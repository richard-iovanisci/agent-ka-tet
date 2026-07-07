import { afterAll, describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import type { StatusResponse } from "../types.ts";
import type { StoredEvent } from "./store.ts";
import { startDaemon } from "./server.ts";

/**
 * Real Bun.serve on an ephemeral port with an in-memory store — no mocks.
 * Tests run in declaration order and share one daemon, so the state
 * transitions below are sequential on purpose.
 */

const cfg = defaultConfig(process.cwd());
const daemon = startDaemon(cfg, { port: 0, dbPath: ":memory:" });
const base = `http://127.0.0.1:${daemon.port}`;

afterAll(async () => {
  await daemon.stop();
});

async function post(path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function getStatus(): Promise<StatusResponse> {
  const res = await fetch(`${base}/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusResponse;
}

describe("daemon HTTP API", () => {
  test("healthz responds ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("status starts with all agents launching; daemon block is populated", async () => {
    const status = await getStatus();
    expect(status.daemon.port).toBe(daemon.port);
    expect(status.daemon.pid).toBe(process.pid);
    expect(status.daemon.startedAt).toBeGreaterThan(0);
    for (const agent of ["claude", "codex", "agy", "opencode"] as const) {
      expect(status.agents[agent].state).toBe("launching");
      expect(status.agents[agent].lastEvent).toBeNull();
    }
    expect(status.agents.agy.observedVia).toBe("mux");
    expect(status.agents.claude.observedVia).toBe("events");
  });

  test("claude lifecycle: SessionStart -> idle, UserPromptSubmit -> working, Stop -> idle", async () => {
    let res = await post("/events/claude", JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    let status = await getStatus();
    expect(status.agents.claude.state).toBe("idle");
    expect(status.agents.claude.sessionId).toBe("s1");

    res = await post("/events/claude", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" }));
    expect(res.status).toBe(200);
    status = await getStatus();
    expect(status.agents.claude.state).toBe("working");

    res = await post("/events/claude", JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }));
    expect(res.status).toBe(200);
    status = await getStatus();
    expect(status.agents.claude.state).toBe("idle");
    expect(status.agents.claude.lastEvent?.type).toBe("turn.complete");
    expect(status.agents.claude.lastEvent?.nativeType).toBe("Stop");
  });

  test("permission flow: PermissionRequest -> needs_you with digest, PostToolUse clears -> working", async () => {
    await post("/events/claude", JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash" }));
    let status = await getStatus();
    expect(status.agents.claude.state).toBe("needs_you");
    expect(status.agents.claude.pendingPermission).toBe("Bash");

    await post("/events/claude", JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash" }));
    status = await getStatus();
    expect(status.agents.claude.state).toBe("working");
    expect(status.agents.claude.pendingPermission).toBeNull();
  });

  test("agy ?native= hint records turn.complete and flips observedVia to events", async () => {
    const res = await post("/events/agy?native=Stop", JSON.stringify({ session_id: "a1" }));
    expect(res.status).toBe(200);

    const status = await getStatus();
    expect(status.agents.agy.state).toBe("idle");
    expect(status.agents.agy.sessionId).toBe("a1");
    expect(status.agents.agy.observedVia).toBe("events");

    const rows = (await (await fetch(`${base}/events?agent=agy`)).json()) as StoredEvent[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.type).toBe("turn.complete");
    expect(rows[0]?.native_type).toBe("Stop");
    expect(rows[0]?.session_id).toBe("a1");
  });

  test("unknown agent is rejected", async () => {
    const res = await post("/events/gemini", JSON.stringify({ hook_event_name: "Stop" }));
    expect(res.status).toBe(400);
  });

  test("invalid JSON body still gets 200 and is stored as raw", async () => {
    const res = await post("/events/claude", "{{{ not json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = (await (await fetch(`${base}/events?agent=claude&limit=1`)).json()) as StoredEvent[];
    expect(rows.length).toBe(1);
    expect(rows[0]?.type).toBe("raw");
    expect(rows[0]?.native_type).toBe("unknown");

    // raw causes no state transition — claude stays working from the previous test.
    const status = await getStatus();
    expect(status.agents.claude.state).toBe("working");
  });

  test("GET /events returns rows newest-first and respects filters", async () => {
    const all = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    // 5 claude lifecycle + 1 raw claude + 1 agy events so far.
    expect(all.length).toBe(7);
    const ids = all.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    const limited = (await (await fetch(`${base}/events?limit=2`)).json()) as StoredEvent[];
    expect(limited.length).toBe(2);

    const badAgent = await fetch(`${base}/events?agent=nope`);
    expect(badAgent.status).toBe(400);
  });

  test("unknown routes 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/events/claude`)).status).toBe(404); // GET on ingest route
    expect((await fetch(`${base}/status`, { method: "POST" })).status).toBe(404);
  });
});
