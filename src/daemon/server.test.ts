import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_AGENT_ID_HEADER,
  BRIDGE_CONFIG_FINGERPRINT_HEADER,
} from "../attribution.ts";
import { configFingerprint, defaultConfig } from "../config.ts";
import type { AgentStatus, StatusResponse } from "../types.ts";
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

interface PostOptions {
  attributed?: boolean;
  agentId?: string;
  fingerprint?: string;
}

async function post(
  path: string,
  body: string,
  opts: PostOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.attributed !== false) {
    headers[BRIDGE_AGENT_ID_HEADER] =
      opts.agentId ?? path.slice("/events/".length);
    headers[BRIDGE_CONFIG_FINGERPRINT_HEADER] =
      opts.fingerprint ?? configFingerprint(cfg);
  }
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body,
  });
}

function hookBody(body: Record<string, unknown>, cwd = cfg.repo): string {
  return JSON.stringify({ cwd, ...body });
}

async function getStatus(): Promise<StatusResponse> {
  const res = await fetch(`${base}/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusResponse;
}

function agent(status: StatusResponse, id: string): AgentStatus {
  const found = status.agents.find((candidate) => candidate.agent === id);
  if (found === undefined) throw new Error(`missing agent status for ${id}`);
  return found;
}

describe("daemon HTTP API", () => {
  test("healthz responds ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("status starts with the configured two-agent roster launching", async () => {
    const status = await getStatus();
    expect(status.daemon.port).toBe(daemon.port);
    expect(status.daemon.pid).toBe(process.pid);
    expect(status.daemon.startedAt).toBeGreaterThan(0);
    expect(status.daemon.configDir).toBe(cfg.configDir);
    expect(status.daemon.sourceRoot).toBe(cfg.sourceRoot);
    expect(status.daemon.sourceFingerprint).toBe(cfg.sourceFingerprint);
    expect(status.daemon.configFingerprint).toBe(configFingerprint(cfg));
    expect(status.agents.map((entry) => [entry.agent, entry.kind])).toEqual([
      ["claude", "claude"],
      ["codex", "codex"],
    ]);
    for (const entry of status.agents) {
      expect(entry.state).toBe("launching");
      expect(entry.lastEvent).toBeNull();
      expect(entry.activeAttention).toBeNull();
    }
  });

  test("unmanaged or stale hook processes are silently ignored", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    const body = hookBody({
      hook_event_name: "SessionStart",
      session_id: "unmanaged-session",
    });
    for (const opts of [
      { attributed: false },
      { agentId: "codex" },
      { fingerprint: "stale-config-fingerprint" },
    ] satisfies PostOptions[]) {
      const response = await post("/events/claude", body, opts);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
    const claude = agent(await getStatus(), "claude");
    expect(claude.state).toBe("launching");
    expect(claude.sessionId).toBeNull();
  });

  test("claude lifecycle: SessionStart -> idle, UserPromptSubmit -> working, Stop -> idle", async () => {
    let res = await post("/events/claude", hookBody({
      hook_event_name: "SessionStart",
      session_id: "s1",
      source: "startup",
    }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    let status = await getStatus();
    expect(agent(status, "claude").state).toBe("idle");
    expect(agent(status, "claude").sessionId).toBe("s1");

    res = await post("/events/claude", hookBody({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt_id: "claude-turn-1",
    }));
    expect(res.status).toBe(204);
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("working");

    res = await post("/events/claude", hookBody({
      hook_event_name: "Stop",
      session_id: "s1",
      prompt_id: "claude-turn-1",
    }));
    expect(res.status).toBe(204);
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("idle");
    expect(agent(status, "claude").lastEvent?.type).toBe("turn.complete");
    expect(agent(status, "claude").lastEvent?.nativeType).toBe("Stop");

    // Claude emits this passive reminder after an ordinary idle interval. It
    // must not turn a completed, ready session into an actionable needs-you.
    res = await post("/events/claude", hookBody({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "s1",
    }));
    expect(res.status).toBe(204);
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("idle");
    expect(agent(status, "claude").lastEvent?.type).toBe("raw");
    expect(agent(status, "claude").lastEvent?.nativeType).toBe(
      "Notification:idle_prompt",
    );
  });

  test("permission flow: PermissionRequest -> needs_you with digest, PostToolUse clears -> working", async () => {
    await post("/events/claude", hookBody({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash" }));
    let status = await getStatus();
    expect(agent(status, "claude").state).toBe("needs_you");
    expect(agent(status, "claude").pendingPermission).toBe("Bash");
    expect(agent(status, "claude").activeAttention?.nativeType).toBe(
      "PermissionRequest",
    );

    // Claude sends this generic alert after the detailed PermissionRequest.
    // Older already-loaded hook config may still forward it, but it must not
    // replace the stable tool-name badge or alter the actionable state.
    await post("/events/claude", hookBody({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "s1",
      message: "Claude needs your permission",
    }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("needs_you");
    expect(agent(status, "claude").pendingPermission).toBe("Bash");
    expect(agent(status, "claude").lastEvent?.type).toBe(
      "permission.request",
    );
    expect(agent(status, "claude").lastEvent?.nativeType).toBe(
      "Notification:permission_prompt",
    );
    expect(agent(status, "claude").activeAttention?.nativeType).toBe(
      "PermissionRequest",
    );

    await post("/events/claude", hookBody({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash" }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("working");
    expect(agent(status, "claude").pendingPermission).toBeNull();
    expect(agent(status, "claude").activeAttention).toBeNull();

    await post("/events/claude", hookBody({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "s1",
      message: "Session paused",
    }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("needs_you");
    expect(agent(status, "claude").pendingPermission).toBe("Session paused");
    expect(agent(status, "claude").activeAttention?.nativeType).toBe(
      "Notification:permission_prompt",
    );

    await post("/events/claude", hookBody({
      hook_event_name: "SessionEnd",
      session_id: "s1",
    }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("done");
    expect(agent(status, "claude").pendingPermission).toBeNull();
    expect(agent(status, "claude").activeAttention).toBeNull();

    await post("/events/claude", hookBody({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
    }));
    expect(agent(await getStatus(), "claude").state).toBe("working");

    await post("/events/claude", hookBody({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "s1",
      message: "Claude needs your permission",
    }));
    expect(agent(await getStatus(), "claude").pendingPermission).toBe(
      "Claude needs your permission",
    );

    await post("/events/claude", hookBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
    }));
    status = await getStatus();
    expect(agent(status, "claude").pendingPermission).toBe("Bash");
    expect(agent(status, "claude").activeAttention?.nativeType).toBe(
      "PermissionRequest",
    );

    // Manual permission dismissal has no Claude hook. The next submitted
    // prompt is the first trusted lifecycle event and must clear stale
    // attention before the new turn proceeds.
    await post("/events/claude", hookBody({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
    }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("working");
    expect(agent(status, "claude").pendingPermission).toBeNull();
    expect(agent(status, "claude").activeAttention).toBeNull();

    await post("/events/claude", hookBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
    }));
    await post("/events/claude", hookBody({ hook_event_name: "PermissionDenied", session_id: "s1", tool_name: "Bash" }));
    status = await getStatus();
    expect(agent(status, "claude").state).toBe("working");
    expect(agent(status, "claude").pendingPermission).toBeNull();
    expect(agent(status, "claude").activeAttention).toBeNull();
  });

  test("codex lifecycle is normalized through its own adapter kind", async () => {
    await post("/events/codex", hookBody({
      hook_event_name: "SessionStart",
      session_id: "c1",
      source: "startup",
    }));
    await post("/events/codex", hookBody({
      hook_event_name: "UserPromptSubmit",
      session_id: "c1",
      turn_id: "codex-turn-1",
    }));
    const res = await post("/events/codex", hookBody({
      hook_event_name: "Stop",
      session_id: "c1",
      turn_id: "codex-turn-1",
    }));
    expect(res.status).toBe(204);

    const status = await getStatus();
    expect(agent(status, "codex").state).toBe("idle");
    expect(agent(status, "codex").sessionId).toBe("c1");

    const rows = (await (await fetch(`${base}/events?agent=codex`)).json()) as StoredEvent[];
    expect(rows.length).toBe(3);
    expect(rows[0]?.type).toBe("turn.complete");
    expect(rows[0]?.native_type).toBe("Stop");
    expect(rows[0]?.session_id).toBe("c1");
  });

  test("unknown or stale hook agent is ignored with empty success", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    const res = await post("/events/gemini", hookBody({ hook_event_name: "Stop" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
  });

  test("missing, malformed, or invalid-JSON cwd fails closed with empty success", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    for (const body of [
      JSON.stringify({ hook_event_name: "Stop" }),
      JSON.stringify({ hook_event_name: "Stop", cwd: 42 }),
      "{{{ not json",
    ]) {
      const res = await post("/events/claude", body);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
    expect(agent(await getStatus(), "claude").state).toBe("working");
  });

  test("GET /events returns rows newest-first and respects filters", async () => {
    const all = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    // 15 Claude lifecycle + 3 Codex lifecycle events so far.
    expect(all.length).toBe(18);
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

  test("valid hook payloads from another cwd cannot mutate this target", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    const response = await post(
      "/events/codex",
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "unmanaged-session",
        cwd: "/definitely/another/repo",
      }),
    );
    expect(response.status).toBe(204);
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
    expect(agent(await getStatus(), "codex").sessionId).toBe("c1");
  });

  test("direct ingest rejects an invalid id/kind pair before persistence", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    daemon.ingest({
      agent: "claude",
      kind: "codex",
      type: "raw",
      sessionId: null,
      ts: Date.now(),
      payload: { nativeType: "mismatch", body: {} },
    });
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
    expect(after.some((row) => row.native_type === "mismatch")).toBe(false);
  });

  test("a failed history append cannot advance live status", async () => {
    const before = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    const body: Record<string, unknown> = { turn_id: "cyclic-turn" };
    body.self = body;
    daemon.ingest({
      agent: "codex",
      kind: "codex",
      type: "turn.start",
      sessionId: "c1",
      ts: Date.now(),
      payload: { nativeType: "UserPromptSubmit", body },
    });
    const after = (await (await fetch(`${base}/events`)).json()) as StoredEvent[];
    expect(after).toHaveLength(before.length);
    expect(agent(await getStatus(), "codex").state).toBe("idle");
  });

  test("custom id works and realpath accepts an equivalent symlinked cwd", async () => {
    const realRepo = mkdtempSync(join(tmpdir(), "bridge-real-cwd-"));
    const linkedRepo = `${realRepo}-link`;
    symlinkSync(realRepo, linkedRepo, "dir");
    const customCfg = defaultConfig(linkedRepo);
    customCfg.agents[0] = { ...customCfg.agents[0]!, id: "claude-primary" };
    const custom = startDaemon(customCfg, { port: 0, dbPath: ":memory:" });
    try {
      const customBase = `http://127.0.0.1:${custom.port}`;
      const response = await fetch(`${customBase}/events/claude-primary`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [BRIDGE_AGENT_ID_HEADER]: "claude-primary",
          [BRIDGE_CONFIG_FINGERPRINT_HEADER]: configFingerprint(customCfg),
        },
        body: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "custom-session",
          source: "startup",
          cwd: realRepo,
        }),
      });
      expect(response.status).toBe(204);
      const status = (await (await fetch(`${customBase}/status`)).json()) as StatusResponse;
      expect(agent(status, "claude-primary").kind).toBe("claude");
      expect(agent(status, "claude-primary").sessionId).toBe("custom-session");
      const rows = (await (await fetch(`${customBase}/events?agent=claude-primary`)).json()) as StoredEvent[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent).toBe("claude-primary");
    } finally {
      await custom.stop();
    }
  });

  test("stale and uncorrelated completions are stored as raw without idling the active turn", async () => {
    const isolatedCfg = defaultConfig(process.cwd());
    const isolated = startDaemon(isolatedCfg, { port: 0, dbPath: ":memory:" });
    const isolatedBase = `http://127.0.0.1:${isolated.port}`;
    const headers = {
      "content-type": "application/json",
      [BRIDGE_AGENT_ID_HEADER]: "claude",
      [BRIDGE_CONFIG_FINGERPRINT_HEADER]: configFingerprint(isolatedCfg),
    };
    const send = (body: Record<string, unknown>) =>
      fetch(`${isolatedBase}/events/claude`, {
        method: "POST",
        headers,
        body: hookBody(body, isolatedCfg.repo),
      });

    try {
      await send({
        hook_event_name: "SessionStart",
        session_id: "correlated-session",
        source: "startup",
      });
      await send({
        hook_event_name: "UserPromptSubmit",
        session_id: "correlated-session",
        prompt_id: "older-prompt",
      });
      await send({
        hook_event_name: "UserPromptSubmit",
        session_id: "correlated-session",
        prompt_id: "active-prompt",
      });
      await send({
        hook_event_name: "Stop",
        session_id: "correlated-session",
        prompt_id: "older-prompt",
      });
      await send({
        hook_event_name: "Stop",
        session_id: "correlated-session",
      });

      let status = (await (
        await fetch(`${isolatedBase}/status`)
      ).json()) as StatusResponse;
      expect(agent(status, "claude").state).toBe("working");
      expect(agent(status, "claude").sessionId).toBe("correlated-session");
      expect(agent(status, "claude").lastEvent?.type).toBe("turn.start");

      let rows = (await (
        await fetch(`${isolatedBase}/events?agent=claude`)
      ).json()) as StoredEvent[];
      expect(rows.slice(0, 2).map((row) => row.type)).toEqual(["raw", "raw"]);
      expect(rows.slice(0, 2).map((row) => row.native_type)).toEqual([
        "Stop",
        "Stop",
      ]);

      await send({
        hook_event_name: "Stop",
        session_id: "correlated-session",
        prompt_id: "active-prompt",
      });
      status = (await (
        await fetch(`${isolatedBase}/status`)
      ).json()) as StatusResponse;
      expect(agent(status, "claude").state).toBe("idle");
      expect(agent(status, "claude").lastEvent?.type).toBe("turn.complete");

      rows = (await (
        await fetch(`${isolatedBase}/events?agent=claude&limit=1`)
      ).json()) as StoredEvent[];
      expect(rows[0]?.type).toBe("turn.complete");
    } finally {
      await isolated.stop();
    }
  });
});
