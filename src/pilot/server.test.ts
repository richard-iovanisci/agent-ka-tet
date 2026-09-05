import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { MessageRecord, Run, RuntimeAttempt, RuntimeObservation } from "../coordination/types.ts";
import {
  CodexRequestError,
  type CodexClient,
  type CodexNotification,
  type CodexResponse,
  type CodexServerRequest,
} from "../native/codex.ts";
import { agentFile, pilotFile, preparePilot, readPrivateJson, writePrivateJson } from "./config.ts";
import { pilotRequest, startPilotServer, type PilotServerOptions } from "./server.ts";

class FakeCodex {
  threadId = randomUUID();
  starts = 0;
  bound: string[] = [];
  peers: Parameters<CodexClient["sendPeer"]>[0][] = [];
  operators: Parameters<CodexClient["startOperatorTurn"]>[0][] = [];
  startError: Error | null = null;
  peerError: Error | null = null;
  operatorError: Error | null = null;
  onPeer?: (input: Parameters<CodexClient["sendPeer"]>[0]) => void;
  notifications = new Set<(event: CodexNotification) => void>();
  responses = new Set<(event: CodexResponse) => void>();
  requests = new Set<(event: CodexServerRequest) => void>();
  disconnects = new Set<(error: Error) => void>();
  async startThread() {
    this.starts++;
    if (this.startError) throw this.startError;
    return { requestId: randomUUID(), threadId: this.threadId, thread: { id: this.threadId } };
  }
  async bindThread(id: string) {
    this.bound.push(id);
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
  run: Run;
  agents: RuntimeAttempt[];
  messages: MessageRecord[];
  observations: RuntimeObservation[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(options: Omit<PilotServerOptions, "connect"> = {}) {
  const cfg = preparePilot();
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
  });
  async function request(path: string, body?: unknown, credential = cfg.operatorToken) {
    const response = await fetch(`http://127.0.0.1:${server.endpoint.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
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
    await f.request("/operator/ready", { agentId: "claude", confirmNative: true });
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
    expect((await f.channel("receipt", { deliveryId: delivery.deliveryId, outcome: "written" })).status).toBe(
      200,
    );
    let receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.state).toBe("written");
    expect(receipt.application).toBe("unread");
    expect((await f.tool("codex", "bridge_ack_message", { messageId: delivery.messageId })).status).toBe(400);
    await f.tool("claude", "bridge_read_message", { messageId: delivery.messageId });
    await f.tool("claude", "bridge_ack_message", { messageId: delivery.messageId });
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
      await f.tool("claude", "bridge_send_message", { to: "codex", body: "PONG", idempotencyKey: "pong" })
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
    await f.tool("claude", "bridge_send_message", { to: "codex", body: "PONG", idempotencyKey: "pong" });
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
      await f.tool("claude", "bridge_send_message", { to: "codex", body: "PONG", idempotencyKey: "pong" })
    ).data as MessageRecord;
    await until(async () => (await f.status()).messages[0]!.receipt.state === "ambiguous");
    const receipt = (await f.status()).messages[0]!.receipt;
    expect(receipt.turnId).toBe("observed-turn");
    expect(receipt.itemId).toBe("observed-item");
    expect(receipt.application).toBe("unread");
    for (const listener of f.native.responses)
      listener({ requestId: sent.receipt.requestId, result: { turn: { id: "observed-turn" } } });
    expect((await f.status()).messages[0]!.receipt.state).toBe("ambiguous");
  });

  test("holds a Channel notification whose write receipt was lost", async () => {
    const f = fixture();
    await f.ready();
    await f.tool("codex", "bridge_send_message", { to: "claude", body: "PING", idempotencyKey: "ping" });
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

  test("revalidates expiry before starting the operator turn", async () => {
    let now = Date.now();
    const f = fixture({ now: () => now });
    await f.ready();
    now = (await f.status()).run.expiresAt + 1;
    expect((await f.request("/operator/start", {})).status).toBe(400);
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

  test("records native approval requests without answering or exposing credentials", async () => {
    const f = fixture();
    await f.ready();
    for (const listener of f.native.requests)
      listener({
        requestId: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: f.native.threadId, turnId: "turn-1", itemId: "item-1" },
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
