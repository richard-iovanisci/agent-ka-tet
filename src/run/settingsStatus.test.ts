import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCoordinationStore } from "../coordination/store.ts";
import { agentFile, preparePilot, writePrivateJson } from "../pilot/config.ts";
import { resolveLaunchSettings } from "./settings.ts";
import { runtimeSettings } from "./settingsStatus.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});

function fixture(version: 1 | 2 = 2) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-settings-status-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const cfg = preparePilot(join(directory, "run"));
  cleanup.push(() => rmSync(cfg.socketDir, { recursive: true, force: true }));
  cfg.version = version;
  if (version === 2) cfg.launch = resolveLaunchSettings();
  let time = 1000;
  const store = openCoordinationStore(cfg.db, { now: () => time++ });
  cleanup.push(() => store.close());
  const claude = cfg.agents[0]!;
  const codex = cfg.agents[1]!;
  const bind = (agent = claude) => {
    const sessionId = agent.sessionId ?? randomUUID();
    store.expectSession(agent.runtimeId, sessionId);
    return store.bindRuntime(agent.runtimeId, sessionId);
  };
  const hook = (name: string, data: Record<string, unknown> = {}, source = "native-hook") => {
    const body = { session_id: claude.sessionId, hook_event_name: name, ...data };
    return store.appendObservation(claude.runtimeId, {
      source,
      name,
      sessionId: claude.sessionId!,
      data: source === "native-hook-pending" ? { body, wrapper: { pid: 123, born: "fixture" } } : body,
    });
  };
  const launch = (extra: Record<string, unknown> = {}) =>
    writePrivateJson(agentFile(cfg.root, claude.id, "launch"), {
      version: 1,
      runtimeId: claude.runtimeId,
      role: "claude",
      recordedAt: 900,
      configured: cfg.launch?.claude ?? { permissionMode: "default" },
      environment: [],
      ...extra,
    });
  return { cfg, store, claude, codex, bind, hook, launch };
}

describe("runtime settings status", () => {
  test("keeps requested, configured, and native substitutions separate without changing runtime authority", () => {
    const f = fixture();
    const runtime = f.bind();
    f.launch();
    const start = f.hook("SessionStart", {
      model: "native-selected-model",
      permission_mode: "default",
      effort: { level: "ignored" },
    });
    const tool = f.hook("PostToolUse", {
      model: "not a SessionStart model",
      effort: { level: "max" },
      permission_mode: "acceptEdits",
    });
    const before = f.store.runtime(runtime.id);
    expect(runtimeSettings(f.cfg, before)).toEqual({
      requested: f.cfg.launch!.claude,
      configured: {
        source: "claude-launch",
        recordedAt: 900,
        values: { ...f.cfg.launch!.claude },
        environment: [],
      },
      observed: {
        model: {
          value: "native-selected-model",
          source: "native-hook:SessionStart",
          recordedAt: start.createdAt,
        },
        effort: { value: "max", source: "native-hook:PostToolUse", recordedAt: tool.createdAt },
        permissionMode: {
          value: "acceptEdits",
          source: "native-hook:PostToolUse",
          recordedAt: tool.createdAt,
        },
        thinking: null,
      },
    });
    expect(f.store.runtime(runtime.id)).toEqual(before);
    expect(before.ready).toBe(false);
  });

  test("v1 has no manufactured launch defaults, but authentic known observations remain visible", () => {
    const f = fixture(1);
    const runtime = f.bind();
    expect(runtimeSettings(f.cfg, runtime)).toEqual({
      requested: null,
      configured: { source: "pending", recordedAt: null, values: null },
      observed: { model: null, effort: null, permissionMode: null, thinking: null },
    });
    const observed = f.hook("SessionStart", { model: "legacy-native-model" });
    expect(runtimeSettings(f.cfg, runtime).observed.model).toEqual({
      value: "legacy-native-model",
      source: "native-hook:SessionStart",
      recordedAt: observed.createdAt,
    });
  });

  test("pending startup evidence is eligible only after the expected exact session binds and survives old event windows", () => {
    const f = fixture();
    const start = f.hook(
      "SessionStart",
      { source: "startup", model: "early-native-model" },
      "native-hook-pending",
    );
    expect(runtimeSettings(f.cfg, f.store.runtime(f.claude.runtimeId)).observed.model).toBeNull();
    const runtime = f.bind();
    for (let i = 0; i < 1100; i++) f.hook("Notification", { message: "unrelated activity" });
    const stop = f.hook("Stop", { effort: { level: "high" } });
    expect(f.store.observations(1000).some((event) => event.id === start.id)).toBe(false);
    expect(runtimeSettings(f.cfg, runtime).observed).toEqual({
      model: {
        value: "early-native-model",
        source: "native-hook-pending:SessionStart",
        recordedAt: start.createdAt,
      },
      effort: { value: "high", source: "native-hook:Stop", recordedAt: stop.createdAt },
      permissionMode: null,
      thinking: null,
    });
  });

  test("ignores mismatched identities, nested events, unsupported provenance and malformed newer optional fields", () => {
    const f = fixture();
    const runtime = f.bind();
    const valid = f.hook("SessionStart", { model: "root-model", permission_mode: "default" });
    const effort = f.hook("PreToolUse", { effort: { level: "medium" } });
    f.hook("SessionStart", { model: 44, permission_mode: [], effort: { level: "not tool context" } });
    f.hook("SessionStart", { model: "foreign-body", session_id: randomUUID() });
    f.hook("SessionStart", { model: "nested-model", agent_id: "nested-agent" });
    f.hook("SessionStart", { model: "wrong-event", hook_event_name: "Notification" });
    f.hook("SessionStart", { model: "untrusted" }, "pane-capture");
    f.hook("Notification", { model: "notification-model", effort: { level: "invalid-context" } });
    f.hook("PostToolUse", { effort: { level: false }, permission_mode: null });
    const db = new Database(f.cfg.db);
    try {
      const insert = db.query("INSERT INTO runtime_observation (runtime_id,value) VALUES (?,?)");
      for (const extra of [{ runtimeId: randomUUID() }, { sessionId: randomUUID() }, { createdAt: true }])
        insert.run(
          runtime.id,
          JSON.stringify({
            runtimeId: runtime.id,
            sessionId: runtime.sessionId,
            source: "native-hook",
            name: "SessionStart",
            createdAt: 9000,
            data: { session_id: runtime.sessionId, model: "wrong-envelope" },
            ...extra,
          }),
        );
      insert.run(runtime.id, "not-json");
    } finally {
      db.close();
    }
    expect(runtimeSettings(f.cfg, runtime).observed).toEqual({
      model: { value: "root-model", source: "native-hook:SessionStart", recordedAt: valid.createdAt },
      effort: { value: "medium", source: "native-hook:PreToolUse", recordedAt: effort.createdAt },
      permissionMode: { value: "default", source: "native-hook:SessionStart", recordedAt: valid.createdAt },
      thinking: null,
    });
    for (const wrong of [
      { sessionId: randomUUID() },
      { expectedSessionId: randomUUID() },
      { kind: "codex" as const },
      { runId: randomUUID() },
    ]) {
      expect(runtimeSettings(f.cfg, { ...runtime, ...wrong }).observed.model).toBeNull();
    }
  });

  test("projects private launch data and hook samples without credentials or unrelated fields", () => {
    const f = fixture();
    const runtime = f.bind();
    const secret = "fixture-secret-do-not-expose";
    f.launch({
      configured: {
        ...f.cfg.launch!.claude,
        thinkingBudgetTokens: 31999,
        apiKey: secret,
        env: { TOKEN: secret },
      },
      environment: [
        { name: "CLAUDE_CODE_EFFORT_LEVEL", disposition: "replaced", value: secret },
        { name: "invalid name", disposition: "inherited" },
      ],
      token: secret,
    });
    f.hook("SessionStart", { model: "native-model", token: secret, transcript_path: secret });
    const status = runtimeSettings(f.cfg, runtime);
    expect(status.configured.values).toEqual({ ...f.cfg.launch!.claude, thinkingBudgetTokens: 31999 });
    expect(status.configured.environment).toEqual([
      { name: "CLAUDE_CODE_EFFORT_LEVEL", disposition: "replaced" },
    ]);
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  test("Codex uses only the exact accepted native response and keeps observed values pending", () => {
    const f = fixture();
    const runtime = f.bind(f.codex);
    const path = agentFile(f.cfg.root, f.codex.id, "thread-intent");
    const settings = {
      model: "native-substitution",
      modelProvider: "openai",
      reasoningEffort: null,
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly", networkAccess: false },
    };
    const intent = {
      runtimeId: runtime.id,
      threadId: runtime.sessionId,
      state: "accepted",
      configuredAt: 2000,
      settings: {
        ...settings,
        token: "fixture-secret",
        sandbox: { ...settings.sandbox, env: "fixture-secret" },
      },
      request: { model: "requested-not-configured", token: "fixture-secret" },
    };
    writePrivateJson(path, intent);
    expect(runtimeSettings(f.cfg, runtime)).toEqual({
      requested: f.cfg.launch!.codex,
      configured: { source: "codex-thread/start", recordedAt: 2000, values: settings },
      observed: { model: null, effort: null, permissionMode: null, thinking: null },
    });
    for (const extra of [
      { state: "ambiguous" },
      { runtimeId: randomUUID() },
      { threadId: randomUUID() },
      { configuredAt: undefined },
      { settings: undefined },
    ]) {
      writePrivateJson(path, { ...intent, ...extra });
      expect(runtimeSettings(f.cfg, runtime).configured).toEqual({
        source: "pending",
        recordedAt: null,
        values: null,
      });
    }
    writePrivateJson(path, { ...intent, settings: {} });
    expect(runtimeSettings(f.cfg, runtime).configured.values).toEqual({});
    writePrivateJson(path, {
      ...intent,
      settings: {
        approvalPolicy: ["never"],
        sandbox: { type: "externalSandbox", networkAccess: ["enabled"] },
      },
    });
    expect(runtimeSettings(f.cfg, runtime).configured.values).toEqual({});
  });

  test("foreign, malformed and non-private launch records remain pending", () => {
    const f = fixture();
    const runtime = f.bind();
    for (const extra of [
      { runtimeId: randomUUID() },
      { role: "codex-host" },
      { recordedAt: "1000" },
      { configured: null },
    ]) {
      f.launch(extra);
      expect(runtimeSettings(f.cfg, runtime).configured.values).toBeNull();
    }
    const path = agentFile(f.cfg.root, f.claude.id, "launch");
    writeFileSync(path, "invalid-json");
    expect(runtimeSettings(f.cfg, runtime).configured.values).toBeNull();
    f.launch();
    chmodSync(path, 0o644);
    expect(runtimeSettings(f.cfg, runtime).configured.values).toBeNull();
  });
});
