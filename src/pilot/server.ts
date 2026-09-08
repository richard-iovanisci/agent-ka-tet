import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { openCoordinationStore } from "../coordination/store.ts";
import type { RuntimeAttempt, SendMessageInput } from "../coordination/types.ts";
import { connectCodex, CodexRequestError, type CodexClient } from "../native/codex.ts";
import { validateArtifact, validateReviewer } from "../run/artifact.ts";
import { reviewerPrompt } from "../run/prompts.ts";
import { runtimeSettings } from "../run/settingsStatus.ts";
import {
  agentFile,
  pilotFile,
  readPrivateJson,
  writePrivateJson,
  type PilotConfig,
  type PilotEndpoint,
} from "./config.ts";
import {
  acquireCoordinatorLock,
  processAlive,
  processRecord,
  recordProcess,
  releaseCoordinatorLock,
  type ProcessRecord,
} from "./processState.ts";

type NativeClient = Pick<
  CodexClient,
  | "startThread"
  | "setThreadName"
  | "bindThread"
  | "sendPeer"
  | "startOperatorTurn"
  | "onNotification"
  | "onResponse"
  | "onServerRequest"
  | "onDisconnect"
  | "close"
>;

export interface PilotServerOptions {
  port?: number;
  connect?: () => Promise<NativeClient>;
  nativeAlive?: (id: string) => boolean;
  wrapperAlive?: (id: string) => boolean;
  hostAlive?: () => boolean;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new Error("authentication required");
  return header.slice(7);
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function fields(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("unsupported tool field");
}

function taskVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("expectedVersion must be a positive integer");
  return value as number;
}

export function startPilotServer(cfg: PilotConfig, options: PilotServerOptions = {}) {
  const lock = acquireCoordinatorLock(cfg.root);
  const now = options.now ?? Date.now;
  let store: ReturnType<typeof openCoordinationStore>;
  try {
    store = openCoordinationStore(cfg.db, { now });
    store.recover();
  } catch (error) {
    releaseCoordinatorLock(cfg.root, lock);
    throw error;
  }
  const confirmed = new Set<string>();
  const channelConnected = new Set<string>();
  const nativeAlive = options.nativeAlive ?? ((id) => processAlive(processRecord(cfg.root, id), true));
  const wrapperAlive =
    options.wrapperAlive ?? options.nativeAlive ?? ((id) => processAlive(processRecord(cfg.root, id)));
  const hostAlive = options.hostAlive ?? (() => processAlive(processRecord(cfg.root, "codex-host"), true));
  const pendingStartup = new Map<string, { sessionId: string; wrapper: ProcessRecord | null }>();
  for (const observation of store.observations(1000).reverse()) {
    if (observation.source === "native-hook-pending" && object(observation.data)) {
      pendingStartup.set(observation.runtimeId, {
        sessionId: observation.sessionId,
        wrapper: object(observation.data.wrapper)
          ? (observation.data.wrapper as unknown as ProcessRecord)
          : null,
      });
    }
  }
  const codexAgent = cfg.agents.find((a) => a.kind === "codex")!;
  const threadIntentFile = agentFile(cfg.root, codexAgent.id, "thread-intent");
  for (const path of [threadIntentFile, pilotFile(cfg.root, "start.json")]) {
    if (!existsSync(path)) continue;
    const intent = readPrivateJson<Record<string, unknown>>(path);
    if (intent.state === "submitting") writePrivateJson(path, { ...intent, state: "ambiguous" });
  }
  let codex: NativeClient | null = null;
  let connectingClient: NativeClient | null = null;
  let connecting = false;
  let dispatching = false;
  let activeRequests = 0;
  let closed = false;
  let endpoint: PilotEndpoint;

  function requireOpenRun(): void {
    const run = store.run(cfg.runId);
    if (!run) throw new Error("run is unavailable");
    if (run.expiresAt <= now())
      throw new Error(
        `run expired at ${new Date(run.expiresAt).toISOString()}; prepare a new run for peer delivery`,
      );
    if (run.paused) throw new Error("run is paused; peer delivery is held");
  }

  function reconcileStartup(runtime: RuntimeAttempt): RuntimeAttempt {
    if (runtime.sessionId || runtime.revoked || runtime.exited) return runtime;
    const pending = pendingStartup.get(runtime.id);
    if (
      !pending ||
      pending.sessionId !== runtime.expectedSessionId ||
      !wrapperAlive(runtime.agentId) ||
      !nativeAlive(runtime.agentId)
    )
      return runtime;
    const owner = processRecord(cfg.root, runtime.agentId);
    if (
      pending.wrapper &&
      (!owner || owner.pid !== pending.wrapper.pid || owner.born !== pending.wrapper.born)
    )
      return runtime;
    const bound = store.bindRuntime(runtime.id, pending.sessionId);
    store.appendObservation(runtime.id, {
      source: "bridge-binding",
      name: "native-session-bound",
      sessionId: pending.sessionId,
    });
    pendingStartup.delete(runtime.id);
    return bound;
  }

  function readiness(runtime: RuntimeAttempt): void {
    runtime = reconcileStartup(runtime);
    if (runtime.revoked || runtime.exited) {
      confirmed.delete(runtime.id);
      return;
    }
    const run = store.run(runtime.runId);
    const connected = runtime.kind === "codex" ? codex !== null : channelConnected.has(runtime.id);
    const available = nativeAlive(runtime.agentId) && (runtime.kind !== "codex" || hostAlive());
    if (!available) confirmed.delete(runtime.id);
    store.setReady(
      runtime.id,
      !!run &&
        !run.paused &&
        run.expiresAt > now() &&
        !runtime.paused &&
        !!runtime.sessionId &&
        connected &&
        confirmed.has(runtime.id) &&
        available,
    );
  }

  function refreshReadiness(): void {
    for (const runtime of store.runtimes()) readiness(runtime);
  }

  function activity(runtime: RuntimeAttempt): {
    activity: string;
    attention?: string;
  } {
    let state = "awaiting native event";
    let attention: string | undefined;
    const pending = new Set<string>();
    for (const observation of store.observations(1000).reverse()) {
      if (observation.runtimeId !== runtime.id || observation.sessionId !== runtime.sessionId) continue;
      const data = object(observation.data) ? observation.data : {};
      if (observation.source === "codex-server-request") pending.add(String(data.requestId));
      if (observation.source === "codex-app-server") {
        if (observation.name === "serverRequest/resolved") pending.delete(String(data.requestId));
        if (observation.name === "thread/status/changed" && object(data.status))
          state = String(data.status.type);
      }
      if (observation.source !== "native-hook" || runtime.kind !== "claude") continue;
      if (observation.name === "UserPromptSubmit") {
        state = "turn started";
        attention = undefined;
      }
      if (observation.name === "Stop") state = "turn completed";
      if (observation.name === "PermissionRequest") attention = "Native permission request";
      if (observation.name === "PermissionDenied") attention = "Native permission denied";
      if (observation.name === "PostToolUse") attention = undefined;
      if (observation.name === "SessionEnd") state = "session ended";
    }
    if (pending.size) attention = "Native approval pending";
    return { activity: state, ...(attention ? { attention } : {}) };
  }

  function holdBinding(runtime: RuntimeAttempt, name: string, data: unknown, revoke = false): void {
    confirmed.delete(runtime.id);
    channelConnected.delete(runtime.id);
    if (runtime.sessionId ?? runtime.expectedSessionId)
      store.appendObservation(runtime.id, {
        source: "bridge-binding",
        name,
        sessionId: (runtime.sessionId ?? runtime.expectedSessionId)!,
        data,
      });
    if (revoke) store.revokeRuntime(runtime.id);
    else if (!runtime.revoked && !runtime.exited) store.pauseRuntime(runtime.id, true);
  }

  function nestedHook(body: Record<string, unknown>): boolean {
    return ["agent_id", "agent_type", "subagent_id", "parent_session_id", "parent_thread_id"].some(
      (key) => typeof body[key] === "string" && body[key].length > 0,
    );
  }

  function observeCodex(client: NativeClient, runtime: RuntimeAttempt): void {
    const observe = (action: () => void) => {
      if (closed) return;
      try {
        action();
      } catch {
        holdBinding(store.runtime(runtime.id), "native-correlation-held", {
          reason: "native evidence could not be correlated",
        });
      }
    };
    client.onNotification(({ method, params }) =>
      observe(() => {
        if (!object(params)) return;
        const thread = object(params.thread) ? params.thread : null;
        const threadId = params.threadId ?? thread?.id;
        if (threadId !== runtime.sessionId) {
          if (method !== "thread/started" || !thread || typeof threadId !== "string") return;
          const source = thread.source;
          if (object(source) && ("subagent" in source || "internal" in source)) return;
          holdBinding(
            store.runtime(runtime.id),
            "native-session-switch",
            { threadId, source },
            source === "cli" || source === "vscode",
          );
          return;
        }
        const turnId =
          typeof params.turnId === "string"
            ? params.turnId
            : object(params.turn) && typeof params.turn.id === "string"
              ? params.turn.id
              : undefined;
        if (method.endsWith("/delta") || method === "thread/tokenUsage/updated") return;
        store.appendObservation(runtime.id, {
          source: "codex-app-server",
          name: method,
          sessionId: runtime.sessionId!,
          ...(turnId ? { turnId } : {}),
          data: params,
        });
        const item = params.item;
        if (
          !method.startsWith("item/") ||
          !object(item) ||
          item.type !== "functionCallOutput" ||
          item.name !== "bridge_receive_message" ||
          item.namespace !== "agent_bridge" ||
          typeof item.output !== "string" ||
          typeof item.id !== "string"
        )
          return;
        const message = store
          .messages()
          .find(
            (record) =>
              record.message.recipientRuntimeId === runtime.id &&
              record.message.recipientSessionId === threadId &&
              JSON.stringify(record.message) === item.output,
          );
        if (message)
          store.observeDelivery(message.message.id, {
            itemId: item.id,
            ...(turnId ? { turnId } : {}),
          });
      }),
    );
    client.onServerRequest(({ requestId, method, params }) =>
      observe(() => {
        if (!object(params) || params.threadId !== runtime.sessionId) return;
        store.appendObservation(runtime.id, {
          source: "codex-server-request",
          name: method,
          sessionId: runtime.sessionId!,
          ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          data: { requestId, params },
        });
      }),
    );
    client.onResponse((response) =>
      observe(() => {
        const message = store
          .messages()
          .find(
            (record) =>
              record.message.recipientRuntimeId === runtime.id &&
              record.receipt.requestId === response.requestId,
          );
        if (!message) return;
        store.appendObservation(runtime.id, {
          source: "codex-rpc",
          name: "response",
          sessionId: runtime.sessionId!,
          data: response,
        });
        if (
          object(response.result) &&
          object(response.result.turn) &&
          typeof response.result.turn.id === "string"
        ) {
          store.observeDelivery(message.message.id, {
            turnId: response.result.turn.id,
          });
        }
      }),
    );
  }

  async function attachCodex(): Promise<void> {
    if (codex || connecting) throw new Error("Codex is already connected or connecting");
    if (!hostAlive()) throw new Error("the owned Codex host is unavailable; refusing native connection");
    connecting = true;
    let client: NativeClient | null = null;
    try {
      client = await (options.connect?.() ??
        connectCodex({
          socketPath: cfg.socketPath,
          clientInfo: {
            name: "agent_bridge",
            title: "Agent Bridge",
            version: "0.0.1",
          },
          experimentalApi: cfg.codexHistoryMode === "legacy",
        }));
      connectingClient = client;
      if (closed) throw new Error("coordinator is stopping");
      if (!hostAlive()) throw new Error("Codex host ownership changed during connection");
      let runtime = store.runtime(codexAgent.runtimeId);
      if (runtime.revoked || runtime.exited)
        throw new Error("Codex attempt is no longer active; prepare a new pilot");
      if (!runtime.sessionId) {
        let threadId: string;
        if (existsSync(threadIntentFile)) {
          const intent = readPrivateJson<Record<string, unknown>>(threadIntentFile);
          if (
            intent.runtimeId !== runtime.id ||
            intent.state !== "accepted" ||
            typeof intent.threadId !== "string"
          ) {
            if (intent.runtimeId === runtime.id && intent.state === "submitting")
              writePrivateJson(threadIntentFile, {
                ...intent,
                state: "ambiguous",
              });
            throw new Error("native thread creation is uncertain; prepare a new pilot instead of retrying");
          }
          threadId = intent.threadId;
        } else {
          requireOpenRun();
          const intent = {
            runtimeId: runtime.id,
            intentId: randomUUID(),
            state: "submitting",
            createdAt: now(),
          };
          writePrivateJson(threadIntentFile, intent);
          try {
            const started = await client.startThread({
              cwd: codexAgent.workspace,
              sandbox: cfg.launch?.codex.sandbox ?? "read-only",
              approvalPolicy: cfg.launch?.codex.approvalPolicy ?? "on-request",
              model: cfg.launch?.codex.model ?? "gpt-6-astra",
              config: {
                model_reasoning_effort: cfg.launch?.codex.effort ?? "ultra",
              },
              ...(cfg.codexHistoryMode ? { historyMode: cfg.codexHistoryMode } : {}),
            });
            threadId = started.threadId;
            writePrivateJson(threadIntentFile, {
              ...intent,
              state: "accepted",
              threadId,
              requestId: started.requestId,
              settings: started.settings,
              configuredAt: now(),
            });
          } catch (error) {
            const result =
              error instanceof CodexRequestError && error.reason === "protocol" && object(error.rawError)
                ? error.rawError
                : null;
            const returnedId = result && object(result.thread) ? result.thread.id : null;
            writePrivateJson(threadIntentFile, {
              ...intent,
              state: "ambiguous",
              ...(error instanceof CodexRequestError
                ? { requestId: error.requestId, reason: error.reason }
                : {}),
              ...(typeof returnedId === "string" &&
              /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(returnedId)
                ? { returnedThreadId: returnedId }
                : {}),
            });
            throw error;
          }
        }
        store.expectSession(runtime.id, threadId);
        runtime = store.bindRuntime(runtime.id, threadId);
      }
      if (closed) throw new Error("coordinator is stopping");
      observeCodex(client, runtime);
      if (cfg.codexHistoryMode === "legacy")
        await client.setThreadName(runtime.sessionId!, `${cfg.tmuxSession}-codex`);
      await client.bindThread(runtime.sessionId!);
      if (closed) throw new Error("coordinator is stopping");
      if (!hostAlive()) throw new Error("Codex host ownership changed during binding");
      writePrivateJson(agentFile(cfg.root, codexAgent.id, "thread"), {
        threadId: runtime.sessionId,
      });
      client.onDisconnect(() => {
        if (closed) return;
        if (codex === client) codex = null;
        confirmed.delete(runtime.id);
        const current = store.runtime(runtime.id);
        if (!current.revoked && !current.exited) store.setReady(runtime.id, false);
      });
      codex = client;
      readiness(runtime);
    } catch (error) {
      const runtime = store.runtime(codexAgent.runtimeId);
      if (runtime.sessionId && error instanceof CodexRequestError) {
        store.appendObservation(runtime.id, {
          source: "codex-rpc",
          name: error.method,
          sessionId: runtime.sessionId,
          data: {
            requestId: error.requestId,
            reason: error.reason,
            error: error.rawError,
          },
        });
      }
      client?.close();
      throw error;
    } finally {
      connectingClient = null;
      connecting = false;
    }
  }

  async function dispatch(): Promise<void> {
    if (closed || dispatching) return;
    dispatching = true;
    try {
      refreshReadiness();
      if (!codex || store.runtime(codexAgent.runtimeId).revoked) return;
      const record = store.claimDelivery(codexAgent.runtimeId, "codex");
      if (!record) return;
      try {
        const result = await codex.sendPeer({
          messageId: record.message.id,
          envelope: JSON.stringify(record.message),
          threadId: record.message.recipientSessionId,
          requestId: record.receipt.requestId!,
        });
        store.finishDelivery(record.message.id, {
          state: "accepted",
          ...result,
        });
      } catch (error) {
        store.finishDelivery(record.message.id, {
          state: "ambiguous",
          detail:
            error instanceof CodexRequestError
              ? JSON.stringify({ reason: error.reason, error: error.rawError })
              : "native submission outcome is uncertain",
        });
      }
    } finally {
      dispatching = false;
    }
  }

  async function hook(req: Request): Promise<Response> {
    try {
      const runtime = store.authenticateForBinding(token(req));
      const body: unknown = await req.json();
      if (!object(body) || typeof body.session_id !== "string" || typeof body.cwd !== "string")
        return new Response(null, { status: 204 });
      if (realpathSync(body.cwd) !== runtime.workspace || nestedHook(body))
        return new Response(null, { status: 204 });
      const name = string(body.hook_event_name ?? body.event, "hook event");
      if (body.session_id !== runtime.expectedSessionId) {
        if (
          name === "SessionStart" &&
          ["clear", "resume"].includes(String(body.source)) &&
          nativeAlive(runtime.agentId)
        ) {
          holdBinding(
            runtime,
            "native-session-switch",
            { sessionId: body.session_id, source: body.source },
            true,
          );
        }
        return new Response(null, { status: 204 });
      }
      if (!runtime.sessionId) {
        if (
          runtime.kind !== "claude" ||
          name !== "SessionStart" ||
          body.source !== "startup" ||
          !wrapperAlive(runtime.agentId)
        )
          return new Response(null, { status: 204 });
        const wrapper = processRecord(cfg.root, runtime.agentId);
        store.appendObservation(runtime.id, {
          source: "native-hook-pending",
          name,
          sessionId: body.session_id,
          data: { body, wrapper },
        });
        pendingStartup.set(runtime.id, { sessionId: body.session_id, wrapper });
        reconcileStartup(runtime);
        return new Response(null, { status: 204 });
      }
      store.appendObservation(runtime.id, {
        source: "native-hook",
        name,
        sessionId: body.session_id,
        ...(typeof body.turn_id === "string" ? { turnId: body.turn_id } : {}),
        data: body,
      });
      if (name === "SessionEnd") {
        confirmed.delete(runtime.id);
        store.setReady(runtime.id, false);
      }
    } catch {
      /* Observation must not block a native hook. */
    }
    return new Response(null, { status: 204 });
  }

  function tool(
    runtime: RuntimeAttempt,
    credential: string,
    name: string,
    args: Record<string, unknown>,
  ): unknown {
    if (name.startsWith("bridge_task_")) {
      if (!cfg.task) throw new Error("this run has no task");
      const task = store.readTask(credential);
      if (!task) throw new Error("task not found");
      if (name === "bridge_task_read") {
        fields(args, []);
        return {
          ...task,
          role: runtime.id === task.implementerRuntimeId ? "implementer" : "reviewer",
          baseCommit: cfg.task.baseCommit,
        };
      }
      const identity = {
        taskId: string(args.taskId, "taskId"),
        expectedVersion: taskVersion(args.expectedVersion),
      };
      if (name === "bridge_task_claim") {
        fields(args, ["taskId", "expectedVersion"]);
        return store.claimTask(credential, identity);
      }
      if (name === "bridge_task_submit") {
        fields(args, ["taskId", "expectedVersion", "commit", "summary"]);
        if (runtime.id !== task.implementerRuntimeId)
          throw new Error("only the assigned implementer can submit");
        const commit = string(args.commit, "commit");
        validateArtifact(cfg, commit);
        return store.submitTask(credential, {
          ...identity,
          artifact: { commit, summary: string(args.summary, "summary") },
        });
      }
      if (name === "bridge_task_review") {
        fields(args, ["taskId", "expectedVersion", "decision", "summary"]);
        if (args.decision !== "accept" && args.decision !== "changes_requested")
          throw new Error("invalid review decision");
        if (runtime.id !== task.reviewerRuntimeId) throw new Error("only the assigned reviewer can review");
        validateReviewer(cfg, runtime.id);
        return store.reviewTask(credential, {
          ...identity,
          decision: args.decision,
          summary: string(args.summary, "summary"),
        });
      }
      throw new Error("unknown task tool");
    }
    switch (name) {
      case "bridge_list_agents":
        return store.runtimes().map(({ agentId, kind, sessionId, ready, paused }) => ({
          agentId,
          kind,
          bound: sessionId !== null,
          ready,
          paused,
        }));
      case "bridge_inbox":
        return store.listMessages(credential);
      case "bridge_read_message":
        return store.readMessage(credential, string(args.messageId, "messageId"));
      case "bridge_ack_message":
        return store.acknowledge(credential, string(args.messageId, "messageId"));
      case "bridge_send_message": {
        const allowed = ["to", "body", "idempotencyKey", "replyTo"];
        if (Object.keys(args).some((key) => !allowed.includes(key)))
          throw new Error("unsupported message field");
        const input: SendMessageInput = {
          to: string(args.to, "to"),
          body: string(args.body, "body"),
          idempotencyKey: string(args.idempotencyKey, "idempotencyKey"),
          ...(args.replyTo === undefined ? {} : { replyTo: string(args.replyTo, "replyTo") }),
        };
        return store.send(credential, input);
      }
      default:
        throw new Error("unknown tool");
    }
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 0,
      maxRequestBodySize: 262_144,
      async fetch(req) {
        activeRequests++;
        try {
          if (closed) return json({ error: "coordinator is stopping" }, 503);
          const url = new URL(req.url),
            path = url.pathname;
          if (req.method === "POST" && path === "/events") return await hook(req);
          try {
            const credential = token(req);
            if (path.startsWith("/operator/")) {
              if (!matches(credential, cfg.operatorToken))
                return json({ error: "operator authentication required" }, 401);
              if (req.method === "GET" && path === "/operator/status") {
                refreshReadiness();
                return json({
                  pilot: cfg.id,
                  endpoint,
                  serverNow: now(),
                  run: store.run(cfg.runId),
                  agents: store.runtimes().map((runtime) => ({
                    ...runtime,
                    available: nativeAlive(runtime.agentId) && (runtime.kind !== "codex" || hostAlive()),
                    ...activity(runtime),
                    settings: runtimeSettings(cfg, runtime),
                  })),
                  tasks: store.task() ? [store.task()] : [],
                  messages: store.messages(),
                  observations: store.observations(100),
                  threadIntent: existsSync(threadIntentFile) ? readPrivateJson(threadIntentFile) : null,
                  startIntent: existsSync(pilotFile(cfg.root, "start.json"))
                    ? readPrivateJson(pilotFile(cfg.root, "start.json"))
                    : null,
                });
              }
              if (req.method !== "POST") return json({ error: "not found" }, 404);
              const args: unknown = await req.json();
              if (!object(args)) throw new Error("expected an object");
              if (path === "/operator/connect") {
                await attachCodex();
                return json({ connected: true });
              }
              if (path === "/operator/ready" || path === "/operator/pause") {
                const agent = cfg.agents.find((a) => a.id === args.agentId);
                if (!agent) throw new Error("unknown pilot agent");
                const runtime = reconcileStartup(store.runtime(agent.runtimeId));
                if (path.endsWith("/pause")) {
                  confirmed.delete(runtime.id);
                  store.pauseRuntime(runtime.id, true);
                } else {
                  requireOpenRun();
                  if (args.confirmNative !== true || !nativeAlive(agent.id))
                    throw new Error("confirm the owned native TUI is attached and usable");
                  if (!runtime.sessionId) throw new Error("native session is not bound");
                  store.pauseRuntime(runtime.id, false);
                  confirmed.add(runtime.id);
                  readiness(store.runtime(runtime.id));
                }
                return json(store.runtime(runtime.id));
              }
              if (path === "/operator/start") {
                refreshReadiness();
                requireOpenRun();
                if (!codex || store.runtimes().some((r) => !r.ready || r.paused))
                  throw new Error("both native TUIs must be confirmed ready");
                const startFile = pilotFile(cfg.root, "start.json");
                if (existsSync(startFile))
                  throw new Error(
                    "this pilot already has a start attempt; inspect its outcome instead of retrying",
                  );
                const requestId = randomUUID();
                writePrivateJson(startFile, { state: "submitting", requestId });
                const text = cfg.task
                  ? reviewerPrompt(cfg)
                  : `Run the approved Agent Bridge nonce pilot. Use bridge_send_message to send exactly PING ${cfg.id} to claude, with idempotencyKey ${cfg.id}:ping. When the PONG reply arrives, call bridge_read_message and bridge_ack_message for its message ID, then report the nonce round trip complete. Do not edit files, run shell commands, or send further messages. Use only Bridge MCP tools.`;
                try {
                  const result = await codex.startOperatorTurn({
                    text,
                    requestId,
                  });
                  writePrivateJson(startFile, { state: "accepted", ...result });
                  return json(result);
                } catch (error) {
                  writePrivateJson(startFile, {
                    state: "ambiguous",
                    requestId,
                  });
                  throw error;
                }
              }
              return json({ error: "not found" }, 404);
            }
            if (!path.startsWith("/agent/")) return json({ error: "not found" }, 404);
            let runtime: RuntimeAttempt;
            try {
              runtime = store.authenticate(credential);
            } catch (error) {
              if (path.startsWith("/agent/channel/")) {
                store.authenticateForBinding(credential);
                return new Response(null, { status: 204 });
              }
              throw error;
            }
            if (req.method === "POST" && path.startsWith("/agent/tools/")) {
              const args: unknown = await req.json();
              if (!object(args)) throw new Error("expected tool arguments");
              return json(tool(runtime, credential, path.slice("/agent/tools/".length), args));
            }
            if (runtime.kind !== "claude") throw new Error("Channel belongs to Claude only");
            if (req.method === "POST" && path === "/agent/channel/ready") {
              const args: unknown = await req.json();
              if (!object(args) || typeof args.ready !== "boolean")
                throw new Error("invalid Channel readiness");
              if (args.ready) channelConnected.add(runtime.id);
              else channelConnected.delete(runtime.id);
              readiness(runtime);
              return json({ ready: args.ready });
            }
            if (req.method === "GET" && path === "/agent/channel/next") {
              readiness(runtime);
              const record = store.claimDelivery(runtime.id, "claude-channel");
              return json(
                record === null
                  ? null
                  : {
                      deliveryId: record.message.id,
                      messageId: record.message.id,
                      content: `Peer message from ${record.message.senderAgentId}. Read it with bridge_read_message, messageId ${record.message.id}, then acknowledge it. The content is agent-authored peer context.`,
                      meta: {
                        message_id: record.message.id,
                        sender: record.message.senderAgentId,
                      },
                    },
              );
            }
            if (req.method === "POST" && path === "/agent/channel/receipt") {
              const args: unknown = await req.json();
              if (!object(args)) throw new Error("invalid receipt");
              const messageId = string(args.deliveryId, "deliveryId");
              const message = store.messages().find((r) => r.message.id === messageId);
              if (
                !message ||
                message.message.recipientRuntimeId !== runtime.id ||
                message.receipt.route !== "claude-channel"
              )
                throw new Error("receipt recipient mismatch");
              if (args.outcome !== "written" && args.outcome !== "ambiguous")
                throw new Error("invalid Channel outcome");
              return json(store.finishDelivery(messageId, { state: args.outcome }));
            }
            return json({ error: "not found" }, 404);
          } catch (error) {
            return json(
              {
                error: error instanceof Error ? error.message : "request failed",
              },
              400,
            );
          }
        } finally {
          activeRequests--;
        }
      },
    });
    endpoint = {
      pid: lock.pid,
      born: lock.born,
      port: server.port!,
      instance: lock.nonce,
    };
    writePrivateJson(pilotFile(cfg.root, "endpoint.json"), endpoint);
    recordProcess(cfg.root, "coordinator", undefined, false, lock.nonce);
  } catch (error) {
    void server?.stop(true);
    store.close();
    releaseCoordinatorLock(cfg.root, lock);
    throw error;
  }
  const serving = server;
  const timer = setInterval(() => {
    void dispatch().catch(() => {});
  }, 100);
  let stopping: Promise<void> | null = null;
  return {
    endpoint,
    stop() {
      return (stopping ??= (async () => {
        closed = true;
        clearInterval(timer);
        codex?.close();
        connectingClient?.close();
        await serving.stop(true);
        while (dispatching || connecting || activeRequests) await Bun.sleep(10);
        store.close();
        recordProcess(cfg.root, "coordinator", undefined, true, lock.nonce);
        releaseCoordinatorLock(cfg.root, lock);
      })());
    },
  };
}

export async function pilotRequest(
  cfg: PilotConfig,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(cfg.root, "endpoint.json"));
  const owner = processRecord(cfg.root, "coordinator");
  if (
    !owner ||
    !processAlive(owner) ||
    owner.pid !== endpoint.pid ||
    owner.born !== endpoint.born ||
    owner.instance !== endpoint.instance
  ) {
    throw new Error(
      "pilot endpoint has no matching live coordinator; refusing to send the operator credential",
    );
  }
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${cfg.operatorToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      object(data) && typeof data.error === "string"
        ? data.error
        : `pilot request failed: ${response.status}`,
    );
  if (
    path === "/operator/status" &&
    (!object(data) ||
      !object(data.endpoint) ||
      data.endpoint.instance !== endpoint.instance ||
      data.pilot !== cfg.id)
  ) {
    throw new Error("pilot endpoint identity changed");
  }
  return data;
}
