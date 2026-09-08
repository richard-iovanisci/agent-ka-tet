import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageRecord, Run, RuntimeAttempt, RuntimeObservation } from "../coordination/types.ts";
import {
  CodexRequestError,
  type CodexClient,
  type CodexThreadSettings,
  type CodexNotification,
  type CodexResponse,
  type CodexServerRequest,
} from "../native/codex.ts";
import { agentFile, pilotFile, preparePilot, readPrivateJson, writePrivateJson } from "./config.ts";
import { pilotRequest, startPilotServer, type PilotServerOptions } from "./server.ts";
import { openCoordinationStore } from "../coordination/store.ts";

class FakeCodex {
  threadId = randomUUID();
  starts = 0;
  threadOptions: Parameters<CodexClient["startThread"]>[0][] = [];
  settings: CodexThreadSettings | null = {
    model: "native-model",
    reasoningEffort: "high",
    approvalPolicy: "never" as const,
    sandbox: { type: "dangerFullAccess" as const },
  };
  settingsError: string | undefined;
  bindingSettings: Awaited<ReturnType<CodexClient["bindThread"]>> = undefined;
  bound: string[] = [];
  peers: Parameters<CodexClient["sendPeer"]>[0][] = [];
  operators: Parameters<CodexClient["startOperatorTurn"]>[0][] = [];
  startError: Error | null = null;
  peerError: Error | null = null;
  operatorError: Error | null = null;
  nameError: Error | null = null;
  onPeer?: (input: Parameters<CodexClient["sendPeer"]>[0]) => void;
  notifications = new Set<(event: CodexNotification) => void>();
  responses = new Set<(event: CodexResponse) => void>();
  requests = new Set<(event: CodexServerRequest) => void>();
  disconnects = new Set<(error: Error) => void>();
  async startThread(options: Parameters<CodexClient["startThread"]>[0]) {
    this.threadOptions.push(options);
    this.starts++;
    if (this.startError) throw this.startError;
    return {
      requestId: randomUUID(),
      threadId: this.threadId,
      thread: { id: this.threadId },
      settings: this.settings,
      ...(this.settingsError ? { settingsError: this.settingsError } : {}),
    };
  }
  async bindThread(id: string) {
    this.bound.push(id);
    return this.bindingSettings;
  }
  async setThreadName() {
    if (this.nameError) throw this.nameError;
  }
  async sendPeer(input: Parameters<CodexClient["sendPeer"]>[0]) {
    this.peers.push(input);
    this.onPeer?.(input);
    if (this.peerError) throw this.peerError;
    return { requestId: input.requestId!, turnId: "peer-turn" };
  }
  async startOperatorTurn(input: Parameters<CodexClient["startOperatorTurn"]>[0]) {
    this.operators.push(input);
    if (this.operatorError) throw this.operatorError;
    return { requestId: input.requestId!, turnId: "operator-turn" };
  }
  onNotification(fn: (event: CodexNotification) => void) {
    this.notifications.add(fn);
    return () => {
      this.notifications.delete(fn);
    };
  }
  onResponse(fn: (event: CodexResponse) => void) {
    this.responses.add(fn);
    return () => {
      this.responses.delete(fn);
    };
  }
  onServerRequest(fn: (event: CodexServerRequest) => void) {
    this.requests.add(fn);
    return () => {
      this.requests.delete(fn);
    };
  }
  onDisconnect(fn: (error: Error) => void) {
    this.disconnects.add(fn);
    return () => {
      this.disconnects.delete(fn);
    };
  }
  close() {
    for (const fn of this.disconnects) fn(new Error("closed"));
  }
  notify(event: CodexNotification) {
    for (const fn of this.notifications) fn(event);
  }
}

interface Status {
  serverNow: number;
  run: Run;
  agents: (RuntimeAttempt & {
    attention?: string;
    settings: ReturnType<typeof import("../run/settingsStatus.ts").runtimeSettings>;
  })[];
  messages: MessageRecord[];
  observations: RuntimeObservation[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(options: Omit<PilotServerOptions, "connect"> = {}, task = false) {
  const source = task ? preparePilot() : null;
  const cfg = task
    ? preparePilot(undefined, {
        project: source!.repo,
        brief: "Add a checked artifact.",
      })
    : preparePilot();
  const native = new FakeCodex();
  let server = startPilotServer(cfg, {
    nativeAlive: () => true,
    wrapperAlive: () => true,
    hostAlive: () => true,
    ...options,
    connect: async () => native,
  });
  cleanups.push(async () => {
    await server.stop();
    rmSync(cfg.socketDir, { recursive: true, force: true });
    rmSync(cfg.root, { recursive: true, force: true });
    if (source) {
      rmSync(source.socketDir, { recursive: true, force: true });
      rmSync(source.root, { recursive: true, force: true });
    }
  });
  async function request(path: string, body?: unknown, credential = cfg.operatorToken) {
    const response = await fetch(`http://127.0.0.1:${server.endpoint.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  const agent = (id: string) => cfg.agents.find((a) => a.id === id)!;
  const status = async (): Promise<Status> => (await request("/operator/status")).data;
  const hook = (extra: Record<string, unknown> = {}) =>
    request(
      "/events",
      {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: agent("claude").sessionId,
        cwd: agent("claude").workspace,
        ...extra,
      },
      agent("claude").token,
    );
  const tool = (id: string, name: string, args: unknown = {}) =>
    request(`/agent/tools/${name}`, args, agent(id).token);
  const channel = (path: string, body?: unknown) =>
    request(`/agent/channel/${path}`, body, agent("claude").token);
  async function bind() {
    expect((await request("/operator/connect", {})).status).toBe(200);
    expect((await hook()).status).toBe(204);
    expect((await channel("ready", { ready: true })).status).toBe(200);
  }
  async function ready() {
    await bind();
    for (const agentId of ["claude", "codex"])
      expect((await request("/operator/ready", { agentId, confirmNative: true })).status).toBe(200);
  }
  return {
    cfg,
    native,
    request,
    status,
    agent,
    hook,
    tool,
    channel,
    bind,
    ready,
    async restart() {
      await server.stop();
      server = startPilotServer(cfg, {
        nativeAlive: () => true,
        wrapperAlive: () => true,
        hostAlive: () => true,
        ...options,
        connect: async () => native,
      });
    },
  };
}

async function until(predicate: () => Promise<boolean>, timeout = 2_000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("condition did not settle");
    await Bun.sleep(20);
  }
}

describe("native pilot coordinator", () => {
  test("runs versioned implementation and review through authenticated tools with a real Git artifact", async () => {
    const f = fixture({}, true);
    await f.ready();
    expect((await f.request("/operator/start", {})).status).toBe(200);
    expect(f.native.operators[0]!.text).not.toContain("read-only worktree");
    expect(f.native.operators[0]!.text).not.toContain("PING");
    const initial = (await f.tool("claude", "bridge_task_read")).data;
    expect(initial.role).toBe("implementer");
    expect(initial.baseCommit).toBe(f.cfg.task!.baseCommit);
    expect(
      (
        await f.tool("codex", "bridge_task_claim", {
          taskId: initial.id,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.tool("claude", "bridge_task_claim", {
          taskId: initial.id,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    const workspace = f.agent("claude").workspace;
    writeFileSync(join(workspace, "artifact.txt"), "checked result\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
        { cwd: workspace, stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("add", "artifact.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "Add checked artifact",
    );
    const commit = git("rev-parse", "HEAD");
    expect(
      (
        await f.tool("codex", "bridge_task_submit", {
          taskId: initial.id,
          expectedVersion: 2,
          commit,
          summary: "forged",
        })
      ).status,
    ).toBe(400);
    const submitted = await f.tool("claude", "bridge_task_submit", {
      taskId: initial.id,
      expectedVersion: 2,
      commit,
      summary: "Tests passed.",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.data.task.state).toBe("review");
    expect(submitted.data.notification.message.recipientAgentId).toBe("codex");
    expect(
      (
        await f.tool("claude", "bridge_task_review", {
          taskId: initial.id,
          expectedVersion: 3,
          decision: "accept",
          summary: "self review",
        })
      ).status,
    ).toBe(400);
    const beforeReview = (await f.status()).messages.length;
    const reviewerFile = join(f.agent("codex").workspace, "untracked-review.txt");
    writeFileSync(reviewerFile, "reviewer edits must block either decision");
    for (const decision of ["accept", "changes_requested"]) {
      const refused = await f.tool("codex", "bridge_task_review", {
        taskId: initial.id,
        expectedVersion: 3,
        decision,
        summary: "must not persist",
      });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toContain("uncommitted changes");
      expect((await f.tool("codex", "bridge_task_read")).data.version).toBe(3);
      expect((await f.status()).messages).toHaveLength(beforeReview);
    }
    rmSync(reviewerFile);
    const reviewed = await f.tool("codex", "bridge_task_review", {
      taskId: initial.id,
      expectedVersion: 3,
      decision: "accept",
      summary: "Inspected exact commit.",
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.data.task.state).toBe("accepted");
    expect(reviewed.data.notification.message.replyTo).toBe(submitted.data.notification.message.id);
    await f.restart();
    expect((await f.request("/operator/status")).data.tasks[0].artifact.commit).toBe(commit);
    expect((await f.request("/operator/status")).data.tasks[0].state).toBe("accepted");
  });

  test("keeps operator and unbound runtime credentials separate", async () => {
    const f = fixture();
    expect((await f.request("/operator/status", undefined, "wrong")).status).toBe(401);
    expect((await f.request("/operator/status", undefined, f.agent("claude").token)).status).toBe(401);
    expect((await f.tool("claude", "bridge_list_agents")).status).toBe(400);
    expect((await f.channel("ready", { ready: true })).status).toBe(204);
    await f.hook({ session_id: randomUUID() });
    expect((await f.status()).agents.every((a) => a.sessionId === null)).toBe(true);
    const serialized = JSON.stringify(await f.status());
    for (const credential of [f.cfg.operatorToken, ...f.cfg.agents.map((a) => a.token)])
      expect(serialized).not.toContain(credential);
    await f.bind();
    expect(
      (
        await f.tool("claude", "bridge_send_message", {
          to: "codex",
          body: "peer",
          idempotencyKey: "1",
          sender: "operator",
        })
      ).status,
    ).toBe(400);
  });

  test("buffers the exact startup hook until the owned child appears", async () => {
    let alive = false;
    const f = fixture({ nativeAlive: () => alive });
    await f.hook();
    expect((await f.status()).agents.find((a) => a.agentId === "claude")!.sessionId).toBeNull();
    alive = true;
    await until(
      async () =>
        (await f.status()).agents.find((a) => a.agentId === "claude")!.sessionId ===
        f.agent("claude").sessionId,
    );
    expect((await f.status()).agents.find((a) => a.agentId === "claude")!.ready).toBe(false);
  });

  test("separates Channel writes from recipient acknowledgements and never polls twice", async () => {
    const f = fixture();
    await f.bind();
    const sent = await f.tool("codex", "bridge_send_message", {
      to: "claude",
      body: "PING",
      idempotencyKey: "ping",
    });
    expect(sent.status).toBe(200);
    expect((await f.channel("next")).data).toBeNull();
    await f.request("/operator/ready", {
      agentId: "claude",
      confirmNative: true,
    });
    const delivery = (await f.channel("next")).data;
    expect(delivery.messageId).toBe(sent.data.message.id);
    expect((await f.channel("next")).data).toBeNull();
    expect(
      (
        await f.request(
          "/agent/channel/receipt",
          { deliveryId: delivery.deliveryId, outcome: "written" },
          f.agent("codex").token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.channel("receipt", {
          deliveryId: delivery.deliveryId,
          outcome: "written",
        })
      ).status,
    ).toBe(200);
    let receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.state).toBe("written");
    expect(receipt.application).toBe("unread");
    expect(
      (
        await f.tool("codex", "bridge_ack_message", {
          messageId: delivery.messageId,
        })
      ).status,
    ).toBe(400);
    await f.tool("claude", "bridge_read_message", {
      messageId: delivery.messageId,
    });
    await f.tool("claude", "bridge_ack_message", {
      messageId: delivery.messageId,
    });
    receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.application).toBe("acknowledged");
    expect(receipt.state).toBe("written");
  });

  test("commits the peer attempt before native I/O and preserves exact envelope identity", async () => {
    const f = fixture();
    await f.ready();
    let seenState: string | undefined;
    f.native.onPeer = (input) => {
      expect(input.threadId).toBe(f.native.threadId);
      expect(input.requestId).toBeTruthy();
      const envelope = JSON.parse(input.envelope);
      expect(envelope.senderSessionId).toBe(f.agent("claude").sessionId);
      expect(envelope.recipientSessionId).toBe(f.native.threadId);
      const db = new Database(f.cfg.db, { readonly: true });
      try {
        seenState = (
          db.query("SELECT state FROM delivery_attempt WHERE message_id = ?").get(input.messageId) as {
            state: string;
          }
        ).state;
      } finally {
        db.close();
      }
    };
    const sent = (
      await f.tool("claude", "bridge_send_message", {
        to: "codex",
        body: "PONG",
        idempotencyKey: "pong",
      })
    ).data as MessageRecord;
    await until(async () => (await f.status()).messages[0]!.receipt.state === "accepted");
    expect(seenState).toBe("sending");
    expect(f.native.peers).toHaveLength(1);
    expect(f.native.peers[0]!.requestId).toBe(sent.receipt.requestId);
    expect(JSON.parse(f.native.peers[0]!.envelope)).toEqual(sent.message);
    const receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.turnId).toBe("peer-turn");
    expect(receipt.application).toBe("unread");
  });

  test("holds ambiguous submissions across coordinator recovery", async () => {
    const f = fixture();
    await f.ready();
    f.native.peerError = new CodexRequestError("request", "turn/start", "disconnect");
    await f.tool("claude", "bridge_send_message", {
      to: "codex",
      body: "PONG",
      idempotencyKey: "pong",
    });
    await until(async () => (await f.status()).messages[0]!.receipt.state === "ambiguous");
    await f.restart();
    expect((await f.status()).agents.every((a) => !a.ready)).toBe(true);
    await f.ready();
    await Bun.sleep(220);
    const receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.state).toBe("ambiguous");
    expect(receipt.policy).toBe("held");
    expect(f.native.peers).toHaveLength(1);
    expect(f.native.starts).toBe(1);
  });

  test("retains exact early item evidence when the native response is lost", async () => {
    const f = fixture();
    await f.ready();
    f.native.peerError = new CodexRequestError("request", "turn/start", "timeout");
    f.native.onPeer = (input) =>
      f.native.notify({
        method: "item/started",
        params: {
          threadId: f.native.threadId,
          turnId: "observed-turn",
          item: {
            type: "functionCallOutput",
            id: "observed-item",
            name: "bridge_receive_message",
            namespace: "agent_bridge",
            output: input.envelope,
          },
        },
      });
    const sent = (
      await f.tool("claude", "bridge_send_message", {
        to: "codex",
        body: "PONG",
        idempotencyKey: "pong",
      })
    ).data as MessageRecord;
    await until(async () => (await f.status()).messages[0]!.receipt.state === "ambiguous");
    const receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.turnId).toBe("observed-turn");
    expect(receipt.itemId).toBe("observed-item");
    expect(receipt.application).toBe("unread");
    for (const listener of f.native.responses)
      listener({
        requestId: sent.receipt.requestId,
        result: { turn: { id: "observed-turn" } },
      });
    expect((await f.status()).messages[0]!.receipt.state).toBe("ambiguous");
  });

  test("holds a Channel notification whose write receipt was lost", async () => {
    const f = fixture();
    await f.ready();
    await f.tool("codex", "bridge_send_message", {
      to: "claude",
      body: "PING",
      idempotencyKey: "ping",
    });
    expect((await f.channel("next")).data.messageId).toBeTruthy();
    await f.restart();
    await f.ready();
    expect((await f.channel("next")).data).toBeNull();
    expect((await f.status()).messages[0]!.receipt.state).toBe("ambiguous");
  });

  test("never recreates a native root after an uncertain thread/start", async () => {
    const f = fixture();
    f.native.startError = new CodexRequestError("create", "thread/start", "timeout");
    expect((await f.request("/operator/connect", {})).status).toBe(400);
    expect((await f.request("/operator/connect", {})).status).toBe(400);
    await f.restart();
    expect((await f.request("/operator/connect", {})).status).toBe(400);
    expect(f.native.starts).toBe(1);
    expect((await f.status()).agents.find((a) => a.agentId === "codex")!.sessionId).toBeNull();
  });

  test("binds a certain thread with unparsed settings and recovers without another start", async () => {
    const f = fixture({}, true);
    f.native.settings = null;
    f.native.settingsError = "Native thread settings could not be parsed";
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    const intent = readPrivateJson<Record<string, unknown>>(agentFile(f.cfg.root, "codex", "thread-intent"));
    expect(intent).toMatchObject({
      state: "accepted",
      threadId: f.native.threadId,
      settings: null,
      settingsError: f.native.settingsError,
    });
    const status = (await f.status()).agents.find((a) => a.kind === "codex")!;
    expect(status.sessionId).toBe(f.native.threadId);
    expect(status.settings.configured).toMatchObject({ status: "unparsed", values: null });
    expect(status.ready).toBe(false);
    await f.restart();
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    expect(f.native.starts).toBe(1);
    expect(f.native.bound).toEqual([f.native.threadId, f.native.threadId]);
  });

  test("records settings from the existing bind response without adding native calls", async () => {
    const f = fixture({}, true);
    f.native.bindingSettings = {
      requestId: "resume-settings",
      threadId: f.native.threadId,
      settings: { model: "retained-model", reasoningEffort: "max" },
    };
    await f.bind();
    expect((await f.status()).agents.find((a) => a.kind === "codex")!.settings.configured).toMatchObject({
      source: "codex-thread/resume",
      values: { model: "retained-model", reasoningEffort: "max" },
    });
    expect(f.native.starts).toBe(1);
    expect(f.native.bound).toHaveLength(1);
    await f.restart();
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    expect(f.native.starts).toBe(1);
    expect(f.native.bound).toHaveLength(2);
  });

  test("retains native binding errors without losing the accepted thread identity", async () => {
    const f = fixture();
    f.native.nameError = new CodexRequestError("name", "thread/name/set", "rpc", {
      code: -32601,
      message: "unsupported",
    });
    expect((await f.request("/operator/connect", {})).status).toBe(400);
    const status = await f.status();
    expect(status.agents.find((a) => a.agentId === "codex")!.sessionId).toBe(f.native.threadId);
    expect(status.observations.find((o) => o.name === "thread/name/set")!.data).toEqual({
      requestId: "name",
      reason: "rpc",
      error: { code: -32601, message: "unsupported" },
    });
    expect(f.native.starts).toBe(1);
    expect(f.native.bound).toHaveLength(0);
    f.native.nameError = null;
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    expect(f.native.bound).toEqual([f.native.threadId]);
    await f.restart();
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    expect(f.native.starts).toBe(1);
    expect(f.native.bound).toEqual([f.native.threadId, f.native.threadId]);
    expect((await f.status()).agents.find((a) => a.agentId === "codex")!.sessionId).toBe(f.native.threadId);
  });

  test("refuses private socket connection when its owned host is gone", async () => {
    const f = fixture({ hostAlive: () => false });
    expect((await f.request("/operator/connect", {})).status).toBe(400);
    expect(f.native.starts).toBe(0);
    expect(existsSync(agentFile(f.cfg.root, "codex", "thread-intent"))).toBe(false);
  });

  test("recovers an accepted thread intent without another thread/start", async () => {
    const f = fixture();
    writePrivateJson(agentFile(f.cfg.root, "codex", "thread-intent"), {
      state: "accepted",
      runtimeId: f.agent("codex").runtimeId,
      requestId: "created",
      threadId: f.native.threadId,
    });
    expect((await f.request("/operator/connect", {})).status).toBe(200);
    expect(f.native.starts).toBe(0);
    expect(f.native.bound).toEqual([f.native.threadId]);
  });

  test("revalidates native ownership before starting the operator turn", async () => {
    let claudeAlive = true;
    const f = fixture({ nativeAlive: (id) => id !== "claude" || claudeAlive });
    await f.ready();
    claudeAlive = false;
    expect((await f.request("/operator/start", {})).status).toBe(400);
    expect(f.native.operators).toHaveLength(0);
    expect(existsSync(pilotFile(f.cfg.root, "start.json"))).toBe(false);
  });

  test("reports expiry precisely and rejects resume/start without changing pause or native state", async () => {
    let now = Date.now();
    const f = fixture({ now: () => now });
    await f.ready();
    now = (await f.status()).run.expiresAt;
    expect((await f.status()).serverNow).toBe(now);
    const expected = {
      error: `run expired at ${new Date(now).toISOString()}; prepare a new run for peer delivery`,
    };
    for (const agentId of ["claude", "codex"]) {
      const paused = await f.request("/operator/pause", { agentId });
      expect(paused.status).toBe(200);
      expect(paused.data.paused).toBe(true);
      const resumed = await f.request("/operator/ready", {
        agentId,
        confirmNative: true,
      });
      expect(resumed).toEqual({ status: 400, data: expected });
    }
    expect(await f.request("/operator/start", {})).toEqual({
      status: 400,
      data: expected,
    });
    expect((await f.status()).agents.every((agent) => agent.paused && !agent.ready)).toBe(true);
    expect(f.native.operators).toHaveLength(0);
    expect(existsSync(pilotFile(f.cfg.root, "start.json"))).toBe(false);
  });

  test("distinguishes a paused run from an expired run", async () => {
    const f = fixture();
    await f.ready();
    const store = openCoordinationStore(f.cfg.db);
    try {
      store.pauseRun(f.cfg.runId, true);
    } finally {
      store.close();
    }
    const expected = {
      status: 400,
      data: { error: "run is paused; peer delivery is held" },
    };
    expect(
      await f.request("/operator/ready", {
        agentId: "claude",
        confirmNative: true,
      }),
    ).toEqual(expected);
    expect(await f.request("/operator/start", {})).toEqual(expected);
    expect(f.native.operators).toHaveLength(0);
  });

  test("persists one operator start and refuses repeat starts", async () => {
    const f = fixture();
    await f.ready();
    expect((await f.request("/operator/start", {})).status).toBe(200);
    expect((await f.request("/operator/start", {})).status).toBe(400);
    expect(f.native.operators).toHaveLength(1);
    expect(f.native.operators[0]!.text).toContain(`PING ${f.cfg.id}`);
    expect(readPrivateJson<{ state: string }>(pilotFile(f.cfg.root, "start.json")).state).toBe("accepted");
  });

  test("revokes root session switches without rebinding the old attempt", async () => {
    const f = fixture();
    await f.ready();
    await f.hook({ session_id: randomUUID(), source: "clear" });
    const claude = (await f.status()).agents.find((a) => a.agentId === "claude")!;
    expect(claude.ready).toBe(false);
    expect(claude.revoked).toBe(true);
    expect(claude.sessionId).toBe(f.agent("claude").sessionId!);
    expect((await f.tool("claude", "bridge_list_agents")).status).toBe(400);
  });

  test("does not confuse an explicitly nested hook with a root session switch", async () => {
    const f = fixture();
    await f.ready();
    await f.hook({ session_id: randomUUID(), agent_id: "reviewer-child" });
    const claude = (await f.status()).agents.find((a) => a.agentId === "claude")!;
    expect(claude.revoked).toBe(false);
    expect(claude.ready).toBe(true);
    expect(claude.sessionId).toBe(f.agent("claude").sessionId!);
  });

  test("uses the run policy for thread creation and retains native substitutions across recovery", async () => {
    const f = fixture({}, true);
    await f.bind();
    expect(f.native.threadOptions).toEqual([
      {
        cwd: f.agent("codex").workspace,
        model: "gpt-6-astra",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        config: { model_reasoning_effort: "ultra" },
        historyMode: "legacy",
      },
    ]);
    const settings = (await f.status()).agents.find((a) => a.kind === "codex")!.settings;
    expect(settings.requested).toMatchObject({
      model: "gpt-6-astra",
      effort: "ultra",
    });
    expect(settings.configured.values).toMatchObject({
      model: "native-model",
      reasoningEffort: "high",
    });
    expect(settings.observed.effort).toBeNull();
    await f.restart();
    expect((await f.status()).agents.find((a) => a.kind === "codex")!.settings).toEqual(settings);
    expect(f.native.starts).toBe(1);
  });

  test("keeps legacy thread creation at its original policy", async () => {
    const f = fixture();
    await f.bind();
    expect(f.native.threadOptions[0]).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    expect((await f.status()).agents[0]!.settings.requested).toBeNull();
  });

  test("clears approval attention only for matching native thread and request IDs", async () => {
    const f = fixture();
    await f.ready();
    const attention = async () => (await f.status()).agents.find((a) => a.kind === "codex")!.attention;
    for (const requestId of [0, 1]) {
      for (const listener of f.native.requests)
        listener({
          requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: f.native.threadId,
            turnId: "peer-turn",
            itemId: `item-${requestId}`,
          },
        });
    }
    expect(await attention()).toBe("Native approval pending");
    f.native.notify({
      method: "serverRequest/resolved",
      params: { threadId: randomUUID(), requestId: 0 },
    });
    f.native.notify({
      method: "serverRequest/resolved",
      params: { threadId: f.native.threadId, requestId: 99 },
    });
    f.native.notify({
      method: "turn/completed",
      params: {
        threadId: f.native.threadId,
        turn: { id: "peer-turn", status: "completed" },
      },
    });
    expect(await attention()).toBe("Native approval pending");
    f.native.notify({
      method: "serverRequest/resolved",
      params: { threadId: f.native.threadId, requestId: 0 },
    });
    expect(await attention()).toBe("Native approval pending");
    f.native.notify({
      method: "serverRequest/resolved",
      params: { threadId: f.native.threadId, requestId: 1 },
    });
    expect(await attention()).toBeUndefined();
    for (const listener of f.native.requests)
      listener({
        requestId: 2,
        method: "item/commandExecution/requestApproval",
        params: { threadId: f.native.threadId },
      });
    f.native.close();
    expect(await attention()).toBe("Native approval pending");
    await f.restart();
    expect(await attention()).toBe("Native approval pending");
  });

  test("records native approval requests without answering or exposing credentials", async () => {
    const f = fixture();
    await f.ready();
    for (const listener of f.native.requests)
      listener({
        requestId: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: f.native.threadId,
          turnId: "turn-1",
          itemId: "item-1",
        },
      });
    const status = await f.status();
    expect(status.observations.some((o) => o.name === "item/commandExecution/requestApproval")).toBe(true);
  });

  test("does not send operator credentials to an endpoint with stale ownership", async () => {
    const f = fixture();
    let requests = 0;
    const unrelated = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json({});
      },
    });
    try {
      writePrivateJson(pilotFile(f.cfg.root, "endpoint.json"), {
        pid: process.pid,
        born: "not this process",
        port: unrelated.port,
        instance: randomUUID(),
      });
      await expect(pilotRequest(f.cfg, "/operator/status")).rejects.toThrow();
      expect(requests).toBe(0);
    } finally {
      await unrelated.stop(true);
    }
  });
});
