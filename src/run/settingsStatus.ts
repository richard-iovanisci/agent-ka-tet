import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RuntimeAttempt } from "../coordination/types.ts";
import { agentFile, readPrivateJson, type PilotConfig } from "../pilot/config.ts";
import type { EnvironmentDisposition } from "./launch.ts";
import type { ClaudeLaunchSettings, CodexLaunchSettings } from "./settings.ts";

export interface SettingsSample {
  value: string | boolean;
  source: string;
  recordedAt: number;
}

export interface RuntimeSettings {
  requested: ClaudeLaunchSettings | CodexLaunchSettings | null;
  configured: {
    source: string;
    recordedAt: number | null;
    values: Record<string, unknown> | null;
    environment?: EnvironmentDisposition[];
    status?: "unparsed";
    error?: "Native thread settings could not be parsed";
  };
  observed: Record<"model" | "effort" | "permissionMode" | "thinking", SettingsSample | null>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(path: string): Record<string, unknown> | null {
  try {
    const value = readPrivateJson<unknown>(path);
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

function configuredValues(value: unknown, kind: RuntimeAttempt["kind"]): Record<string, unknown> | null {
  if (!object(value)) return null;
  const values: Record<string, unknown> = {};
  for (const key of kind === "claude"
    ? ["model", "effort", "thinking", "permissionMode", "accountRef"]
    : ["model", "modelProvider", "reasoningEffort"]) {
    if (text(value[key]) || (key === "reasoningEffort" && value[key] === null)) values[key] = value[key];
  }
  if (kind === "claude") {
    if (timestamp(value.thinkingBudgetTokens)) values.thinkingBudgetTokens = value.thinkingBudgetTokens;
    return values;
  }
  if (
    typeof value.approvalPolicy === "string" &&
    ["never", "untrusted", "on-request"].includes(value.approvalPolicy)
  ) {
    values.approvalPolicy = value.approvalPolicy;
  } else if (object(value.approvalPolicy) && object(value.approvalPolicy.granular)) {
    const granular = value.approvalPolicy.granular;
    const keys = ["sandbox_approval", "rules", "skill_approval", "request_permissions", "mcp_elicitations"];
    if (keys.every((key) => typeof granular[key] === "boolean"))
      values.approvalPolicy = { granular: Object.fromEntries(keys.map((key) => [key, granular[key]])) };
  }
  const sandbox = value.sandbox;
  if (!object(sandbox)) return values;
  if (sandbox.type === "dangerFullAccess") values.sandbox = { type: sandbox.type };
  else if (
    (sandbox.type === "readOnly" && typeof sandbox.networkAccess === "boolean") ||
    (sandbox.type === "externalSandbox" &&
      (sandbox.networkAccess === "restricted" || sandbox.networkAccess === "enabled"))
  ) {
    values.sandbox = { type: sandbox.type, networkAccess: sandbox.networkAccess };
  } else if (
    sandbox.type === "workspaceWrite" &&
    Array.isArray(sandbox.writableRoots) &&
    sandbox.writableRoots.every((root: unknown) => typeof root === "string" && isAbsolute(root)) &&
    ["networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"].every(
      (key) => typeof sandbox[key] === "boolean",
    )
  ) {
    values.sandbox = {
      type: sandbox.type,
      writableRoots: [...sandbox.writableRoots],
      networkAccess: sandbox.networkAccess,
      excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar,
      excludeSlashTmp: sandbox.excludeSlashTmp,
    };
  }
  return values;
}

function environment(value: unknown): EnvironmentDisposition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) =>
    object(entry) &&
    typeof entry.name === "string" &&
    /^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.name) &&
    (entry.disposition === "replaced" || entry.disposition === "inherited")
      ? [{ name: entry.name, disposition: entry.disposition }]
      : [],
  );
}

const CLAUDE_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "Notification",
];

const CODEX_MODEL_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "PreCompact",
  "PostCompact",
];

function observedHooks(cfg: PilotConfig, runtime: RuntimeAttempt): RuntimeSettings["observed"] {
  const observed: RuntimeSettings["observed"] = {
    model: null,
    effort: null,
    permissionMode: null,
    thinking: null,
  };
  if (!runtime.sessionId || runtime.sessionId !== runtime.expectedSessionId) return observed;
  const claude = runtime.kind === "claude";
  const hooks = claude ? CLAUDE_HOOKS : CODEX_MODEL_HOOKS;
  const modelHooks = claude ? ["SessionStart"] : CODEX_MODEL_HOOKS;
  const fields = claude ? (["model", "effort", "permissionMode"] as const) : (["model"] as const);
  let db: Database | undefined;
  try {
    const stat = lstatSync(cfg.db);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      return observed;
    db = new Database(cfg.db, { readonly: true });
    const rows = db
      .query<
        {
          source: string;
          name: string;
          recordedAt: unknown;
          model: unknown;
          effort: unknown;
          permissionMode: unknown;
        },
        [string, string, string, string]
      >(
        `
      WITH events AS (
        SELECT id, CASE WHEN json_valid(value) THEN value ELSE '{}' END AS event
        FROM runtime_observation WHERE runtime_id = ?
      ), hooks AS (
        SELECT id, json_extract(event, '$.source') AS source,
          json_extract(event, '$.name') AS name,
          CASE WHEN json_type(event, '$.createdAt') = 'integer' THEN json_extract(event, '$.createdAt') END AS recordedAt,
          CASE
            WHEN json_extract(event, '$.source') = 'native-hook' AND json_type(event, '$.data') = 'object'
              THEN json_extract(event, '$.data')
            WHEN ${claude ? 1 : 0} AND json_extract(event, '$.source') = 'native-hook-pending'
              AND json_extract(event, '$.name') = 'SessionStart' AND json_type(event, '$.data.body') = 'object'
              THEN json_extract(event, '$.data.body')
            ELSE '{}' END AS body
        FROM events WHERE json_extract(event, '$.runtimeId') = ? AND json_extract(event, '$.sessionId') = ?
      )
      SELECT source, name, recordedAt,
        CASE WHEN name IN (${modelHooks.map((hook) => `'${hook}'`).join(",")}) AND json_type(body, '$.model') = 'text'
          THEN substr(json_extract(body, '$.model'), 1, 257) END AS model,
        CASE WHEN ${claude ? 1 : 0} AND name IN ('PreToolUse', 'PostToolUse', 'Stop') AND json_type(body, '$.effort.level') = 'text'
          THEN substr(json_extract(body, '$.effort.level'), 1, 257) END AS effort,
        CASE WHEN ${claude ? 1 : 0} AND json_type(body, '$.permission_mode') = 'text'
          THEN substr(json_extract(body, '$.permission_mode'), 1, 257) END AS permissionMode
      FROM hooks WHERE name IN (${hooks.map((hook) => `'${hook}'`).join(",")})
        AND json_extract(body, '$.session_id') = ?
        AND (source != 'native-hook-pending' OR json_extract(body, '$.source') = 'startup')
        AND (json_extract(body, '$.hook_event_name') IS NULL OR json_extract(body, '$.hook_event_name') = name)
        AND (json_extract(body, '$.event') IS NULL OR json_extract(body, '$.event') = name)
        ${["agent_id", "agent_type", "subagent_id", "parent_session_id", "parent_thread_id"]
          .map(
            (key) =>
              `AND (json_type(body, '$.${key}') IS NOT 'text' OR length(json_extract(body, '$.${key}')) = 0)`,
          )
          .join("\n")}
      ORDER BY id DESC
    `,
      )
      .iterate(runtime.id, runtime.id, runtime.sessionId, runtime.sessionId);
    for (const row of rows) {
      if (!timestamp(row.recordedAt)) continue;
      for (const field of fields) {
        if (!observed[field] && text(row[field]))
          observed[field] = {
            value: row[field],
            source: `${row.source}:${row.name}`,
            recordedAt: row.recordedAt,
          };
      }
      if (fields.every((field) => observed[field])) break;
    }
  } catch {
  } finally {
    db?.close();
  }
  return observed;
}

function configuredCodex(cfg: PilotConfig, runtime: RuntimeAttempt): RuntimeSettings["configured"] | null {
  if (!runtime.sessionId || runtime.sessionId !== runtime.expectedSessionId) return null;
  for (const [file, source] of [
    ["thread-settings", "codex-thread/resume"],
    ["thread-intent", "codex-thread/start"],
  ] as const) {
    const snapshot = record(agentFile(cfg.root, runtime.agentId, file));
    if (
      !snapshot ||
      snapshot.runtimeId !== runtime.id ||
      snapshot.threadId !== runtime.sessionId ||
      !timestamp(snapshot.configuredAt) ||
      (source === "codex-thread/start" ? snapshot.state !== "accepted" : snapshot.source !== source)
    )
      continue;
    if (snapshot.settings === null && typeof snapshot.settingsError === "string" && snapshot.settingsError) {
      return {
        source,
        recordedAt: snapshot.configuredAt,
        values: null,
        status: "unparsed",
        error: "Native thread settings could not be parsed",
      };
    }
    const values = configuredValues(snapshot.settings, "codex");
    if (values && (source === "codex-thread/start" || Object.keys(values).length > 0))
      return { source, recordedAt: snapshot.configuredAt, values };
  }
  return null;
}

export function runtimeSettings(cfg: PilotConfig, runtime: RuntimeAttempt): RuntimeSettings {
  const status: RuntimeSettings = {
    requested: null,
    configured: { source: "pending", recordedAt: null, values: null },
    observed: { model: null, effort: null, permissionMode: null, thinking: null },
  };
  const agent = cfg.agents.find((candidate) => candidate.runtimeId === runtime.id);
  if (
    !agent ||
    runtime.runId !== cfg.runId ||
    agent.id !== runtime.agentId ||
    agent.kind !== runtime.kind ||
    agent.workspace !== runtime.workspace ||
    (runtime.kind === "claude" && agent.sessionId !== runtime.expectedSessionId)
  )
    return status;
  status.requested = cfg.version === 2 ? (cfg.launch?.[runtime.kind] ?? null) : null;
  const launch = record(agentFile(cfg.root, agent.id, "launch"));
  const matchingLaunch =
    launch?.version === 1 &&
    launch.runtimeId === runtime.id &&
    launch.role === (runtime.kind === "claude" ? "claude" : "codex-host") &&
    timestamp(launch.recordedAt);
  const dispositions = matchingLaunch ? environment(launch.environment) : undefined;
  if (runtime.kind === "claude") {
    if (matchingLaunch) {
      const values = configuredValues(launch.configured, "claude");
      if (values)
        status.configured = {
          source: "claude-launch",
          recordedAt: launch.recordedAt as number,
          values,
          ...(dispositions === undefined ? {} : { environment: dispositions }),
        };
    }
  } else {
    const configured = configuredCodex(cfg, runtime);
    if (configured)
      status.configured = {
        ...configured,
        ...(dispositions === undefined ? {} : { environment: dispositions }),
      };
  }
  status.observed = observedHooks(cfg, runtime);
  return status;
}
