import { describe, expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  BRIDGE_TOOLS,
  BridgeMcp,
  MAX_MCP_FRAME_BYTES,
  MCP_PROTOCOL_VERSIONS,
  bridgeConnection,
  runMcp,
} from "./mcp.ts";

const env = { AGENT_BRIDGE_URL: "http://127.0.0.1:4771", AGENT_BRIDGE_TOKEN: "test-attempt-secret" };
const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const initialize = (protocolVersion = "2025-11-25") =>
  rpc(1, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1" },
  });
type Call = { url: string; init: RequestInit; body: unknown };

function fixture(
  options: {
    channel?: boolean;
    environment?: Record<string, string>;
    response?: (call: Call) => Promise<Response> | Response;
    write?: (line: string) => Promise<void>;
  } = {},
) {
  const lines: string[] = [];
  const calls: Call[] = [];
  const reports: string[] = [];
  const server = new BridgeMcp({
    channel: options.channel,
    env: options.environment ?? env,
    write: async (line) => {
      await options.write?.(line);
      lines.push(line);
    },
    report: (message) => {
      reports.push(message);
    },
    fetch: async (url, init) => {
      const call = { url, init, body: init.body ? (JSON.parse(String(init.body)) as unknown) : undefined };
      calls.push(call);
      return (await options.response?.(call)) ?? Response.json({ ready: true });
    },
  });
  return { server, lines, calls, reports, packets: () => lines.map((line) => JSON.parse(line)) };
}

async function ready(server: BridgeMcp, version?: string) {
  await server.receive(initialize(version));
  await server.receive(initialized);
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Condition did not become true");
}

describe("MCP lifecycle", () => {
  test("negotiates inspected protocol versions and identifies Bridge without agent authentication", async () => {
    for (const version of [...MCP_PROTOCOL_VERSIONS, "2099-01-01"]) {
      const f = fixture({ environment: {} });
      await f.server.receive(initialize(version));
      const result = f.packets()[0].result;
      expect(result.protocolVersion).toBe(version === "2099-01-01" ? MCP_PROTOCOL_VERSIONS[0] : version);
      expect(result.serverInfo).toEqual({ name: "agent-bridge", version: "0.0.1" });
      expect(result.capabilities).toEqual({ tools: {} });
      expect(f.calls).toEqual([]);
      await f.server.close();
    }
  });

  test("requires valid initialize followed by initialized; early notifications cannot enable polling", async () => {
    const f = fixture({ channel: true });
    await f.server.receive(initialized);
    await f.server.receive(rpc(1, "initialize", { protocolVersion: "2025-11-25" }));
    await f.server.receive(rpc(2, "tools/list"));
    await f.server.pollChannel();
    expect(f.packets().map((packet) => packet.error.code)).toEqual([-32602, -32002]);
    expect(f.calls).toEqual([]);
    await f.server.receive(initialize());
    await f.server.pollChannel();
    expect(f.calls).toEqual([]);
    expect(f.packets().at(-1).result.capabilities).toEqual({
      tools: {},
      experimental: { "claude/channel": {} },
    });
    expect(JSON.stringify(f.packets().at(-1).result.capabilities)).not.toContain("permission");
    await f.server.receive(initialized);
    expect(f.server.channelActive).toBe(true);
    await f.server.receive(initialize());
    expect(f.packets().at(-1).error.code).toBe(-32600);
    await f.server.close();
  });

  test("supports ping before initialization and ignores notifications as tool invocations", async () => {
    const f = fixture();
    await f.server.receive(rpc(0, "ping"));
    await ready(f.server);
    await f.server.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "bridge_ack_message", arguments: { messageId: "m1" } },
      }),
    );
    await f.server.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: { content: "ACK m1" },
      }),
    );
    expect(f.packets()[0]).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
    expect(f.calls).toEqual([]);
    await f.server.close();
  });

  test("reports malformed JSON and requests without echoing inputs or secrets", async () => {
    const f = fixture();
    await f.server.receive(`{"secret":"${env.AGENT_BRIDGE_TOKEN}"`);
    for (const value of [
      [],
      null,
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping", result: {} },
    ]) {
      await f.server.receive(JSON.stringify(value));
    }
    await f.server.receive("x".repeat(MAX_MCP_FRAME_BYTES + 1));
    expect(f.packets().map((packet) => packet.error.code)).toEqual([
      -32700, -32600, -32600, -32600, -32600, -32600,
    ]);
    expect(f.lines.join(" ")).not.toContain(env.AGENT_BRIDGE_TOKEN);
    expect(f.reports).toEqual([]);
    await f.server.close();
  });
});

describe("Bridge MCP tools", () => {
  test("exposes exactly the narrow tool schemas and forwards validated arguments with env authentication", async () => {
    const f = fixture({ response: () => Response.json({ messageId: "m1", status: "held" }) });
    await ready(f.server, "2024-11-05");
    await f.server.receive(rpc(2, "tools/list"));
    expect(f.packets().at(-1).result.tools).toEqual(BRIDGE_TOOLS);
    const tools: Array<[string, Record<string, unknown>]> = [
      [
        "bridge_send_message",
        { to: "codex", body: "Review\nthis α result", idempotencyKey: "send-1", replyTo: "previous" },
      ],
      ["bridge_read_message", { messageId: "m1" }],
      ["bridge_ack_message", { messageId: "m1" }],
      ["bridge_list_agents", {}],
      ["bridge_inbox", {}],
      ["bridge_task_read", {}],
      ["bridge_task_claim", { taskId: "task-1", expectedVersion: 1 }],
      [
        "bridge_task_submit",
        {
          taskId: "task-1",
          expectedVersion: 2,
          commit: "a".repeat(40),
          summary: "Changed source; tests passed.",
        },
      ],
      [
        "bridge_task_review",
        {
          taskId: "task-1",
          expectedVersion: 3,
          decision: "accept",
          summary: "Independently verified source.",
        },
      ],
    ];
    expect(BRIDGE_TOOLS.map((tool) => tool.name)).toEqual(tools.map(([name]) => name));
    for (const [name, args] of tools) {
      await f.server.receive(rpc(3, "tools/call", { name, arguments: args }));
      const call = f.calls.at(-1)!;
      expect(call.url).toBe(`${env.AGENT_BRIDGE_URL}/agent/tools/${name}`);
      expect(call.init.method).toBe("POST");
      expect(call.init.redirect).toBe("error");
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${env.AGENT_BRIDGE_TOKEN}`);
      expect(call.body).toEqual(args);
      expect(f.packets().at(-1).result).toEqual({
        content: [{ type: "text", text: '{"messageId":"m1","status":"held"}' }],
      });
    }
    expect(f.lines.join(" ")).not.toContain(env.AGENT_BRIDGE_TOKEN);
    expect(f.reports).toEqual([]);
    await f.server.close();
  });

  test("declares strict versioned task schemas without caller-supplied roles or authority", async () => {
    const tasks = BRIDGE_TOOLS.filter((tool) => tool.name.startsWith("bridge_task_"));
    expect(tasks.map((tool) => tool.inputSchema.required)).toEqual([
      [],
      ["taskId", "expectedVersion"],
      ["taskId", "expectedVersion", "commit", "summary"],
      ["taskId", "expectedVersion", "decision", "summary"],
    ]);
    for (const tool of tasks) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("role");
      expect(tool.inputSchema.properties).not.toHaveProperty("authority");
      if (tool.name !== "bridge_task_read") {
        expect(tool.inputSchema.properties.expectedVersion).toEqual({
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        });
      }
    }
    const review = tasks.find((tool) => tool.name === "bridge_task_review")!;
    expect(review.inputSchema.properties.decision).toEqual({
      type: "string",
      enum: ["accept", "changes_requested"],
    });
  });

  test("rejects malformed task transitions before HTTP and accepts declared version and summary bounds", async () => {
    const f = fixture();
    await ready(f.server);
    const claim = { taskId: "task-1", expectedVersion: 1 };
    const submit = { ...claim, commit: "a".repeat(40), summary: "Source verified." };
    const review = { ...claim, decision: "accept", summary: "Source independently verified." };
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["bridge_task_read", { taskId: "another-task" }],
      ["bridge_task_claim", { taskId: "task-1" }],
      ...[0, -1, 1.5, "1", null, true, Number.MAX_SAFE_INTEGER + 1].map(
        (expectedVersion): [string, Record<string, unknown>] => [
          "bridge_task_claim",
          { ...claim, expectedVersion },
        ],
      ),
      ["bridge_task_claim", { ...claim, role: "implementer" }],
      ["bridge_task_claim", { ...claim, authority: "operator" }],
      ["bridge_task_claim", { ...claim, taskId: " " }],
      ["bridge_task_submit", { ...submit, commit: "HEAD" }],
      ["bridge_task_submit", { ...submit, commit: "a".repeat(39) }],
      ["bridge_task_submit", { ...submit, commit: "A".repeat(40) }],
      ["bridge_task_submit", { ...submit, commit: "x".repeat(40) }],
      ["bridge_task_submit", { ...submit, summary: " " }],
      ["bridge_task_submit", { ...submit, summary: "x".repeat(4097) }],
      ["bridge_task_review", { ...review, summary: "é".repeat(2049) }],
      ["bridge_task_review", { ...review, decision: "approved" }],
      ["bridge_task_review", { ...review, decision: true }],
      ["bridge_task_review", { ...review, commit: "a".repeat(40) }],
    ];
    for (const [name, args] of invalid) {
      await f.server.receive(rpc(2, "tools/call", { name, arguments: args }));
      expect(f.packets().at(-1).result.isError).toBe(true);
    }
    expect(f.calls).toEqual([]);
    const args = {
      ...review,
      expectedVersion: Number.MAX_SAFE_INTEGER,
      decision: "changes_requested",
      summary: "é".repeat(2048),
    };
    await f.server.receive(rpc(3, "tools/call", { name: "bridge_task_review", arguments: args }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual(args);
    await f.server.close();
  });

  test("keeps failed task mutations uncertain without retrying or changing the submitted version", async () => {
    const f = fixture({ response: () => new Response(null, { status: 409 }) });
    await ready(f.server);
    for (const [name, args] of [
      ["bridge_task_claim", { taskId: "task-1", expectedVersion: 1 }],
      [
        "bridge_task_submit",
        { taskId: "task-1", expectedVersion: 2, commit: "a".repeat(40), summary: "Implemented." },
      ],
      [
        "bridge_task_review",
        { taskId: "task-1", expectedVersion: 3, decision: "accept", summary: "Reviewed." },
      ],
    ] as const) {
      const before = f.calls.length;
      await f.server.receive(rpc(2, "tools/call", { name, arguments: args }));
      expect(f.calls).toHaveLength(before + 1);
      expect(f.calls.at(-1)!.body).toEqual(args);
      expect(f.packets().at(-1).result.isError).toBe(true);
    }
    expect(f.lines.join(" ")).not.toContain(env.AGENT_BRIDGE_TOKEN);
    await f.server.close();
  });

  test("rejects undeclared authority, malformed and oversized tool arguments before HTTP", async () => {
    const f = fixture();
    await ready(f.server);
    const invalid = [
      { to: "codex", body: "hi", idempotencyKey: "1", authority: "operator" },
      { to: "codex", body: "hi", idempotencyKey: "1", token: "spoof" },
      { to: "codex", body: "hi" },
      { to: "codex", body: " ", idempotencyKey: "1" },
      { to: "codex", body: "x".repeat(65537), idempotencyKey: "1" },
      { to: "codex", body: "é".repeat(32769), idempotencyKey: "1" },
      { to: "x".repeat(257), body: "hi", idempotencyKey: "1" },
    ];
    for (const args of invalid) {
      await f.server.receive(rpc(2, "tools/call", { name: "bridge_send_message", arguments: args }));
      expect(f.packets().at(-1).result.isError).toBe(true);
    }
    await f.server.receive(
      rpc(3, "tools/call", { name: "bridge_inbox", arguments: { agentId: "someone-else" } }),
    );
    expect(f.packets().at(-1).result.isError).toBe(true);
    await f.server.receive(rpc(4, "tools/call", { name: "bridge_inbox", arguments: [] }));
    expect(f.packets().at(-1).error.code).toBe(-32602);
    await f.server.receive(rpc(5, "tools/call", { name: "grant_permission", arguments: {} }));
    expect(f.packets().at(-1).error.code).toBe(-32602);
    expect(f.calls).toEqual([]);
    await f.server.close();
  });

  test("unbound, rejected, malformed, oversized, and disconnected HTTP results never cause send retries", async () => {
    for (const response of [
      () => new Response(null, { status: 204 }),
      () => new Response(env.AGENT_BRIDGE_TOKEN, { status: 403 }),
      () => new Response("not json"),
      () => new Response("x".repeat(1024 * 1024 + 1)),
      () => {
        throw new Error(env.AGENT_BRIDGE_TOKEN);
      },
    ]) {
      const f = fixture({ response });
      await ready(f.server);
      await f.server.receive(
        rpc(2, "tools/call", {
          name: "bridge_send_message",
          arguments: { to: "codex", body: "hi", idempotencyKey: "1" },
        }),
      );
      expect(f.packets().at(-1).result.isError).toBe(true);
      expect(f.calls.length).toBe(1);
      expect(f.lines.join(" ")).not.toContain(env.AGENT_BRIDGE_TOKEN);
      expect(f.reports).toEqual([]);
      await f.server.close();
    }
  });

  test("rejects non-loopback origins and credentials supplied outside environment", async () => {
    for (const url of [
      "https://127.0.0.1:4771",
      "http://localhost:4771",
      "http://example.com",
      "http://127.0.0.1:4771/path",
      "http://user:pass@127.0.0.1:4771",
      "http://127.0.0.1:4771/?token=secret",
    ]) {
      expect(bridgeConnection({ ...env, AGENT_BRIDGE_URL: url })).toBeNull();
    }
    expect(bridgeConnection({ ...env, AGENT_BRIDGE_TOKEN: "token\r\nInjected: header" })).toBeNull();
    const f = fixture({ environment: {} });
    await ready(f.server);
    await f.server.receive(rpc(2, "tools/call", { name: "bridge_inbox", arguments: {} }));
    expect(f.packets().at(-1).result.isError).toBe(true);
    expect(f.calls).toEqual([]);
    await f.server.close();
  });
});

describe("Claude Channel transport", () => {
  test("waits for bound readiness and records stdout completion separately from explicit ACK", async () => {
    let readyCalls = 0;
    let delivered = false;
    let releaseWrite: (() => void) | undefined;
    const f = fixture({
      channel: true,
      write: (line) =>
        JSON.parse(line).method === "notifications/claude/channel"
          ? new Promise<void>((resolve) => {
              releaseWrite = resolve;
            })
          : Promise.resolve(),
      response: (call) => {
        if (call.url.endsWith("/ready") && ++readyCalls === 1) return new Response(null, { status: 204 });
        if (call.url.endsWith("/next")) {
          if (delivered) return Response.json(null);
          delivered = true;
          return Response.json({
            deliveryId: "d1",
            messageId: "m1",
            content: "Review this",
            meta: { sender: "codex" },
          });
        }
        return Response.json({ ready: true });
      },
    });
    await ready(f.server);
    expect(await f.server.pollChannel()).toBe(false);
    expect(f.calls.some((call) => call.url.endsWith("/next"))).toBe(false);
    const pending = f.server.pollChannel();
    await until(() => releaseWrite !== undefined);
    expect(f.calls.some((call) => call.url.endsWith("/receipt"))).toBe(false);
    expect(await f.server.pollChannel()).toBe(false);
    releaseWrite!();
    expect(await pending).toBe(true);
    const channel = f.packets().find((packet) => packet.method === "notifications/claude/channel");
    expect(channel.params).toEqual({ content: "Review this", meta: { sender: "codex", message_id: "m1" } });
    expect(f.calls.filter((call) => call.url.endsWith("/receipt")).map((call) => call.body)).toEqual([
      { deliveryId: "d1", outcome: "written" },
    ]);
    expect(f.calls.some((call) => call.url.endsWith("/bridge_ack_message"))).toBe(false);
    await f.server.receive(
      rpc(2, "tools/call", { name: "bridge_ack_message", arguments: { messageId: "m1" } }),
    );
    expect(f.calls.at(-1)!.body).toEqual({ messageId: "m1" });
    await f.server.close();
    expect(f.calls.at(-1)!.body).toEqual({ ready: false });
  });

  test("write failure records ambiguity and cannot re-notify", async () => {
    const f = fixture({
      channel: true,
      write: async (line) => {
        if (JSON.parse(line).method === "notifications/claude/channel") throw new Error("closed output");
      },
      response: (call) =>
        call.url.endsWith("/next")
          ? Response.json({ deliveryId: "d1", messageId: "m1", content: "body", meta: {} })
          : Response.json({ ready: true }),
    });
    await ready(f.server);
    expect(await f.server.pollChannel()).toBe(false);
    expect(f.calls.at(-1)!.body).toEqual({ deliveryId: "d1", outcome: "ambiguous" });
    expect(f.server.channelActive).toBe(false);
    const count = f.calls.length;
    await f.server.pollChannel();
    expect(f.calls.length).toBe(count);
    await f.server.close();
  });

  test("receipt loss does not retry transport and reconnect asks coordinator for new claims", async () => {
    let claims = 0;
    const f = fixture({
      channel: true,
      response: (call) => {
        if (call.url.endsWith("/next"))
          return Response.json(
            ++claims === 1 ? { deliveryId: "d1", messageId: "m1", content: "body" } : null,
          );
        if (call.url.endsWith("/receipt")) throw new Error(env.AGENT_BRIDGE_TOKEN);
        return Response.json({ ready: true });
      },
    });
    await ready(f.server);
    await f.server.pollChannel();
    await f.server.pollChannel();
    expect(f.packets().filter((packet) => packet.method === "notifications/claude/channel")).toHaveLength(1);
    expect(f.calls.filter((call) => call.url.endsWith("/receipt"))).toHaveLength(1);
    expect(f.reports).toEqual(["Channel receipt unavailable; delivery will not be retried."]);
    await f.server.close();
  });

  test("invalid metadata is held as ambiguous instead of emitting a malformed channel event", async () => {
    const f = fixture({
      channel: true,
      response: (call) =>
        call.url.endsWith("/next")
          ? Response.json({
              deliveryId: "d1",
              messageId: "m1",
              content: "body",
              meta: { "invalid-key": "value" },
            })
          : Response.json({ ready: true }),
    });
    await ready(f.server);
    expect(await f.server.pollChannel()).toBe(false);
    expect(f.calls.at(-1)!.body).toEqual({ deliveryId: "d1", outcome: "ambiguous" });
    expect(f.packets().some((packet) => packet.method)).toBe(false);
    await f.server.close();
  });

  test("ordinary MCP never registers or polls the Channel", async () => {
    const f = fixture();
    await ready(f.server);
    await f.server.pollChannel();
    await f.server.close();
    expect(f.calls).toEqual([]);
  });
});

describe("stdio framing", () => {
  test("accepts fragmented UTF-8 JSONL and writes protocol-only lines", async () => {
    const wire = Buffer.from(`${initialize()}\n${initialized}\n${rpc(2, "tools/list")}\n`);
    const chunks = Array.from(wire, (byte) => Buffer.from([byte]));
    const lines: string[] = [];
    await runMcp({
      input: Readable.from(chunks),
      output: new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
      env: {},
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
  });

  test("bounds unterminated frames and rejects invalid UTF-8", async () => {
    for (const chunk of [
      Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120),
      Buffer.from([0xff, 10]),
      Buffer.from('{"incomplete":'),
    ]) {
      const output = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      await expect(runMcp({ input: Readable.from([chunk]), output, env: {} })).rejects.toThrow();
    }
  });

  test("shutdown disconnects channel readiness without dispatching a message", async () => {
    const input = new PassThrough();
    const abort = new AbortController();
    const requests: unknown[] = [];
    let handshake = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (JSON.parse(String(chunk)).id === 2) handshake = true;
        done();
      },
    });
    const running = runMcp({
      input,
      output,
      env,
      channel: true,
      signal: abort.signal,
      fetch: async (url, init) => {
        if (url.endsWith("/ready")) requests.push(JSON.parse(String(init.body)));
        return Response.json(null);
      },
    });
    input.write(`${initialize()}\n${initialized}\n${rpc(2, "ping")}\n`);
    await until(() => handshake);
    abort.abort();
    await running;
    expect(requests).toEqual([{ ready: false }]);
  });
});
