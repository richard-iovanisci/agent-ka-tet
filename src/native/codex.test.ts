import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { connectCodex, CodexRequestError, type CodexNotification, type CodexServerRequest } from "./codex.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INFO = { name: "agent_bridge_test", title: "Bridge fixture", version: "0.1.0" };
type Rpc = { id?: string; method?: string; params?: Record<string, unknown>; [key: string]: unknown };
type Peer = { send(text: string): void; terminate(): void };

async function fixture(handle?: (message: Rpc, peer: Peer) => boolean | void) {
  const dir = mkdtempSync("/tmp/abcp-");
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "s");
  const messages: Rpc[] = [];
  const peers = new Set<Peer>();
  const server = createServer((socket) => {
    const peer: Peer = {
      send(text) {
        const body = Buffer.from(text);
        const header = Buffer.alloc(body.length < 126 ? 2 : 4);
        header[0] = 0x81;
        header[1] = body.length < 126 ? body.length : 126;
        if (header.length === 4) header.writeUInt16BE(body.length, 2);
        socket.write(Buffer.concat([header, body]));
      },
      terminate() {
        socket.destroy();
      },
    };
    peers.add(peer);
    socket.on("error", () => {});
    socket.on("close", () => peers.delete(peer));
    let buffered = Buffer.alloc(0);
    let ready = false;
    socket.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      if (!ready) {
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const headers = buffered.subarray(0, boundary).toString();
        const key = /Sec-WebSocket-Key: ([^\r]+)/.exec(headers)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        buffered = buffered.subarray(boundary + 4);
        ready = true;
      }
      while (buffered.length >= 2) {
        let length = buffered[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (buffered.length < offset + 4 + length) return;
        const opcode = buffered[0]! & 15;
        const body = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++) body[i] = body[i]! ^ buffered[offset + (i % 4)]!;
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString()) as Rpc;
        messages.push(message);
        if (handle?.(message, peer)) continue;
        if (!message.id) continue;
        let result: unknown = {};
        if (message.method === "thread/start") result = { thread: { id: THREAD, cwd: message.params?.cwd } };
        if (message.method === "thread/resume") result = { thread: { id: message.params?.threadId } };
        if (message.method === "turn/start") result = { turn: { id: `turn-${message.id}` } };
        peer.send(JSON.stringify({ id: message.id, result }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    messages,
    peers,
    connect: (requestTimeoutMs = 500) => connectCodex({ socketPath, clientInfo: INFO, requestTimeoutMs }),
    async close() {
      for (const peer of peers) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Codex native peer client", () => {
  test("initializes, starts approved thread, binds exact UUID, and emits only tool-tier peer input", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      const started = await client.startThread({
        cwd: "/tmp/pilot-work",
        model: "gpt-6-astra",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: { model_reasoning_effort: "ultra" },
      });
      expect(started.threadId).toBe(THREAD);
      await client.bindThread(started.threadId);
      const envelope = JSON.stringify({ messageId: "message-1", body: "Review the artifact" });
      const result = await client.sendPeer({
        messageId: "message-1",
        envelope,
        threadId: THREAD,
        requestId: "durable-rpc-1",
      });
      expect(result).toEqual({ requestId: "durable-rpc-1", turnId: "turn-durable-rpc-1" });
      expect(host.messages.map((message) => message.method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "thread/resume",
        "turn/start",
      ]);
      expect(host.messages[0]?.params).toEqual({ clientInfo: INFO });
      expect(host.messages[1]).toEqual({ method: "initialized" });
      expect(host.messages[2]?.params).toEqual({
        cwd: "/tmp/pilot-work",
        model: "gpt-6-astra",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: { model_reasoning_effort: "ultra" },
      });
      expect(host.messages[3]?.params).toEqual({ threadId: THREAD, excludeTurns: true });
      expect(host.messages[4]).toEqual({
        id: "durable-rpc-1",
        method: "turn/start",
        params: {
          threadId: THREAD,
          input: [],
          toolOutput: { name: "bridge_receive_message", namespace: "agent_bridge", output: envelope },
        },
      });
      expect(host.messages.every((message) => !("jsonrpc" in message))).toBe(true);
      client.close();
    } finally {
      await host.close();
    }
  });

  test("keeps explicit operator startup on the distinct native user-input route", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      await client.bindThread(THREAD);
      const result = await client.startOperatorTurn({
        text: "Implement the approved brief",
        requestId: "operator-1",
      });
      expect(result).toEqual({ requestId: "operator-1", turnId: "turn-operator-1" });
      expect(host.messages.at(-1)).toEqual({
        id: "operator-1",
        method: "turn/start",
        params: {
          threadId: THREAD,
          input: [{ type: "text", text: "Implement the approved brief", text_elements: [] }],
        },
      });
      client.close();
    } finally {
      await host.close();
    }
  });

  test("correlates out-of-order responses and emits native notifications independently", async () => {
    const submitted: Array<{ message: Rpc; peer: Peer }> = [];
    const host = await fixture((message, peer) => {
      if (message.method !== "turn/start") return;
      submitted.push({ message, peer });
      if (submitted.length === 2) {
        peer.send(
          JSON.stringify({
            method: "item/started",
            params: { threadId: THREAD, turnId: "active", item: { id: "fco_a", type: "functionCallOutput" } },
          }),
        );
        for (const item of [...submitted].reverse())
          item.peer.send(JSON.stringify({ id: item.message.id, result: { turn: { id: "active" } } }));
      }
      return true;
    });
    try {
      const client = await host.connect();
      await client.bindThread(THREAD);
      const notifications: CodexNotification[] = [];
      client.onNotification((notification) => notifications.push(notification));
      const responses: string[] = [];
      client.onResponse((response) => responses.push(response.requestId));
      expect(
        await Promise.all([
          client.sendPeer({ messageId: "a", envelope: "a", requestId: "rpc-a" }),
          client.sendPeer({ messageId: "b", envelope: "b", requestId: "rpc-b" }),
        ]),
      ).toEqual([
        { requestId: "rpc-a", turnId: "active" },
        { requestId: "rpc-b", turnId: "active" },
      ]);
      expect(responses).toEqual(["rpc-b", "rpc-a"]);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.method).toBe("item/started");
      client.close();
    } finally {
      await host.close();
    }
  });

  test("does not answer native approval requests", async () => {
    const host = await fixture((message, peer) => {
      if (message.method !== "turn/start") return;
      peer.send(
        JSON.stringify({
          id: "native-approval",
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD },
        }),
      );
      peer.send(
        JSON.stringify({
          id: "foreign-approval",
          method: "item/commandExecution/requestApproval",
          params: { threadId: OTHER },
        }),
      );
    });
    try {
      const client = await host.connect();
      await client.bindThread(THREAD);
      const observed: CodexServerRequest[] = [];
      client.onServerRequest((request) => observed.push(request));
      await client.sendPeer({ messageId: "permission-open", envelope: "inert", requestId: "peer-rpc" });
      await Bun.sleep(10);
      expect(host.messages.some((message) => message.id === "native-approval")).toBe(false);
      expect(observed).toEqual([
        {
          requestId: "native-approval",
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD },
        },
      ]);
      client.close();
    } finally {
      await host.close();
    }
  });

  test("rejects missing, changed, named, and concurrent bindings before peer input", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      await expect(client.sendPeer({ messageId: "a", envelope: "a" })).rejects.toThrow(/bound/);
      await expect(client.bindThread("recent-thread-name")).rejects.toThrow(/UUID/);
      const binding = client.bindThread(THREAD);
      await expect(client.bindThread(OTHER)).rejects.toThrow(/cannot change/);
      await binding;
      await client.bindThread(THREAD);
      await expect(client.bindThread(OTHER)).rejects.toThrow(/cannot change/);
      await expect(client.sendPeer({ messageId: "a", envelope: "a", threadId: OTHER })).rejects.toThrow(
        /recipient/,
      );
      expect(host.messages.filter((message) => message.method === "turn/start")).toHaveLength(0);
      expect(host.messages.filter((message) => message.method === "thread/resume")).toHaveLength(1);
      client.close();
    } finally {
      await host.close();
    }
  });

  test("fails binding when the server returns another native thread", async () => {
    const host = await fixture((message, peer) => {
      if (message.method !== "thread/resume") return;
      peer.send(JSON.stringify({ id: message.id, result: { thread: { id: OTHER } } }));
      return true;
    });
    try {
      const client = await host.connect();
      await expect(client.bindThread(THREAD)).rejects.toMatchObject({
        reason: "protocol",
        outcome: "uncertain",
      });
      await expect(client.sendPeer({ messageId: "a", envelope: "a" })).rejects.toThrow(/bound/);
    } finally {
      await host.close();
    }
  });

  test("retains correlated raw native errors without parsing retry permission", async () => {
    const rawError = {
      code: -32603,
      message: "failed to submit turn input: ActiveTurnNotSteerable",
      data: { fixture: true },
    };
    const host = await fixture((message, peer) => {
      if (message.method !== "turn/start") return;
      peer.send(JSON.stringify({ id: message.id, error: rawError }));
      return true;
    });
    try {
      const client = await host.connect();
      await client.bindThread(THREAD);
      const failure = await client
        .sendPeer({ messageId: "held", envelope: "inert", requestId: "held-rpc" })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CodexRequestError);
      expect(failure).toMatchObject({
        requestId: "held-rpc",
        method: "turn/start",
        reason: "rpc",
        rawError,
        outcome: "uncertain",
      });
      await expect(
        client.sendPeer({ messageId: "held", envelope: "inert", requestId: "held-rpc" }),
      ).rejects.toThrow(/never replayed/);
      expect(host.messages.filter((message) => message.method === "turn/start")).toHaveLength(1);
      client.close();
    } finally {
      await host.close();
    }
  });

  test("timeout stays uncertain, never retries, and preserves a late response observation", async () => {
    const submitted = Promise.withResolvers<{ message: Rpc; peer: Peer }>();
    const host = await fixture((message, peer) => {
      if (message.method !== "turn/start") return;
      submitted.resolve({ message, peer });
      return true;
    });
    try {
      const client = await host.connect(40);
      await client.bindThread(THREAD);
      const failed = client
        .sendPeer({ messageId: "late", envelope: "inert", requestId: "late-rpc" })
        .catch((error: unknown) => error);
      const { peer, message } = await submitted.promise;
      expect(await failed).toMatchObject({ requestId: "late-rpc", reason: "timeout", outcome: "uncertain" });
      const late = Promise.withResolvers<unknown>();
      client.onResponse(late.resolve);
      peer.send(JSON.stringify({ id: message.id, result: { turn: { id: "late-turn" } } }));
      expect(await late.promise).toEqual({ requestId: "late-rpc", result: { turn: { id: "late-turn" } } });
      expect(host.messages.filter((item) => item.method === "turn/start")).toHaveLength(1);
      client.close();
    } finally {
      await host.close();
    }
  });

  test("disconnect rejects in-flight input and notifies observers without reconnecting", async () => {
    const host = await fixture((message, peer) => {
      if (message.method !== "turn/start") return;
      peer.terminate();
      return true;
    });
    try {
      const client = await host.connect();
      await client.bindThread(THREAD);
      const disconnected = Promise.withResolvers<Error>();
      client.onDisconnect(disconnected.resolve);
      await expect(
        client.sendPeer({ messageId: "gone", envelope: "inert", requestId: "gone-rpc" }),
      ).rejects.toMatchObject({ requestId: "gone-rpc", reason: "disconnect", outcome: "uncertain" });
      expect(await disconnected.promise).toBeInstanceOf(Error);
      expect(host.messages.filter((item) => item.method === "initialize")).toHaveLength(1);
      const alreadyClosed = Promise.withResolvers<Error>();
      client.onDisconnect(alreadyClosed.resolve);
      expect(await alreadyClosed.promise).toBeInstanceOf(Error);
    } finally {
      await host.close();
    }
  });

  test("rejects malformed responses, invalid JSON, and duplicate request IDs", async () => {
    for (const malformed of ["both", "invalid-turn", "json"]) {
      const host = await fixture((message, peer) => {
        if (message.method !== "turn/start") return;
        peer.send(
          malformed === "json"
            ? "not-json"
            : JSON.stringify({
                id: message.id,
                result: { turn: {} },
                ...(malformed === "both" ? { error: { code: -32603 } } : {}),
              }),
        );
        return true;
      });
      try {
        const client = await host.connect();
        await client.bindThread(THREAD);
        await expect(
          client.sendPeer({ messageId: "bad", envelope: "inert", requestId: "bad-rpc" }),
        ).rejects.toBeInstanceOf(CodexRequestError);
        expect(host.messages.filter((item) => item.method === "turn/start")).toHaveLength(1);
        client.close();
      } finally {
        await host.close();
      }
    }
  });
});
