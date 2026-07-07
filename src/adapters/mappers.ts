import type { AgentName, NormalizedEvent, NormalizedEventType } from "../types.ts";

/**
 * Per-agent native-payload -> normalized-event translation. Schemas were
 * verified against official docs / live binaries July 2026 (see DESIGN.md §2
 * and DECISIONS.md). Anything unrecognized maps to "raw" and is stored for
 * forensics — mappers never throw and never drop an event.
 */
/**
 * @param nativeHint optional native event name supplied out-of-band (the
 * `?native=` query param our command shims append) — needed for agy, whose
 * hook payloads are not verified to carry an event name field.
 */
export function mapNativeEvent(agent: AgentName, body: unknown, nativeHint?: string): NormalizedEvent {
  switch (agent) {
    case "claude":
      return mapClaudeEvent(body);
    case "codex":
      return mapCodexEvent(body);
    case "agy":
      return mapAgyEvent(body, nativeHint);
    case "opencode":
      return mapOpencodeEvent(body);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function make(
  agent: AgentName,
  type: NormalizedEventType,
  nativeType: string,
  sessionId: string | null,
  body: unknown,
): NormalizedEvent {
  return { agent, type, sessionId, ts: Date.now(), payload: { nativeType, body } };
}

/* ------------------------------ Claude Code ------------------------------ */
// Hooks POST JSON with hook_event_name / session_id (code.claude.com/docs/en/hooks).

const CLAUDE_HOOK_MAP: Record<string, NormalizedEventType> = {
  SessionStart: "session.start",
  UserPromptSubmit: "turn.start",
  Stop: "turn.complete",
  StopFailure: "turn.error",
  PermissionRequest: "permission.request",
  PostToolUse: "permission.resolved", // tool ran => any pending approval cleared, agent working
  SessionEnd: "agent.exit",
};

// notification_type values inside Notification events.
const CLAUDE_NOTIFICATION_MAP: Record<string, NormalizedEventType> = {
  permission_prompt: "permission.request",
  idle_prompt: "needs.input",
  agent_needs_input: "needs.input",
  // agent_completed refers to a *background subagent* finishing — it does not
  // mean the main session is done, so it stays "raw" (stored, no transition).
};

export function mapClaudeEvent(body: unknown): NormalizedEvent {
  const o = asRecord(body);
  const name = str(o.hook_event_name);
  const sessionId = str(o.session_id);
  if (name === "Notification") {
    const nType = str(o.notification_type) ?? "";
    const mapped = CLAUDE_NOTIFICATION_MAP[nType];
    return make("claude", mapped ?? "raw", `Notification:${nType}`, sessionId, body);
  }
  const mapped = name ? CLAUDE_HOOK_MAP[name] : undefined;
  return make("claude", mapped ?? "raw", name ?? "unknown", sessionId, body);
}

/* -------------------------------- Codex CLI ------------------------------ */
// Two shapes arrive on /events/codex:
//  1. hooks.json command-shim payloads: stdin JSON, snake_case, hook_event_name
//     (developers.openai.com/codex/hooks; no Notification/StopFailure events exist)
//  2. notify payloads: hyphenated keys, {"type":"agent-turn-complete","thread-id":…}

const CODEX_HOOK_MAP: Record<string, NormalizedEventType> = {
  SessionStart: "session.start",
  UserPromptSubmit: "turn.start",
  Stop: "turn.complete",
  PermissionRequest: "permission.request",
  PostToolUse: "permission.resolved",
};

export function mapCodexEvent(body: unknown): NormalizedEvent {
  const o = asRecord(body);
  if (str(o.type) === "agent-turn-complete") {
    return make("codex", "turn.complete", "agent-turn-complete", str(o["thread-id"]), body);
  }
  const name = str(o.hook_event_name);
  const mapped = name ? CODEX_HOOK_MAP[name] : undefined;
  return make("codex", mapped ?? "raw", name ?? "unknown", str(o.session_id), body);
}

/* ---------------------------- Antigravity (agy) --------------------------- */
// Weakest surface (DESIGN.md §7); verified findings in docs/agy-notes.md.
// Two feeds arrive on /events/agy:
//  1. statusline forwarder: payload carries agent_state
//     (initializing|idle|thinking|working|tool_use) — primary state signal.
//  2. hook command shims (PreToolUse/PostToolUse/Stop verified-ish): payload is
//     stdin JSON with session_id; event name comes via the ?native= hint the
//     shim appends, since agy payloads aren't verified to name their event.
// agy has NO PermissionRequest/SessionStart equivalents — needs_you stays
// partial for agy in Phase 0 (HANDOFF.md allows this).

const AGY_STATE_MAP: Record<string, NormalizedEventType> = {
  idle: "turn.complete",
  thinking: "turn.start",
  working: "turn.start",
  tool_use: "turn.start",
  // initializing: stays "raw" so the agent remains `launching` until real state
};

const AGY_HOOK_MAP: Record<string, NormalizedEventType> = {
  PreToolUse: "turn.start",
  PostToolUse: "turn.start",
  Stop: "turn.complete",
};

export function mapAgyEvent(body: unknown, nativeHint?: string): NormalizedEvent {
  const o = asRecord(body);
  const agentState = str(o.agent_state);
  if (agentState !== null) {
    const mapped = AGY_STATE_MAP[agentState];
    return make("agy", mapped ?? "raw", `statusline:${agentState}`, str(o.session_id), body);
  }
  const name = nativeHint ?? str(o.hook_event_name);
  const mapped = name ? AGY_HOOK_MAP[name] : undefined;
  return make("agy", mapped ?? "raw", name ?? "unknown", str(o.session_id), body);
}

/* -------------------------------- OpenCode ------------------------------- */
// SSE envelope from GET /event: { id: "evt_…", type, properties } — verified
// against the live v1.17.15 OpenAPI spec. v1 and v2 permission events coexist
// (DECISIONS.md); session.status carries {type:"busy"|"idle"|"retry"}.

export function mapOpencodeEvent(envelope: unknown): NormalizedEvent {
  const o = asRecord(envelope);
  const type = str(o.type) ?? "unknown";
  const props = asRecord(o.properties);
  const sessionId = str(props.sessionID);

  switch (type) {
    case "session.created":
      return make("opencode", "session.start", type, sessionId, envelope);
    case "session.status": {
      const status = str(asRecord(props.status).type);
      if (status === "busy" || status === "retry") {
        return make("opencode", "turn.start", `${type}:${status}`, sessionId, envelope);
      }
      if (status === "idle") {
        return make("opencode", "turn.complete", `${type}:${status}`, sessionId, envelope);
      }
      return make("opencode", "raw", type, sessionId, envelope);
    }
    case "session.idle":
      return make("opencode", "turn.complete", type, sessionId, envelope);
    case "permission.asked":
    case "permission.v2.asked":
      return make("opencode", "permission.request", type, sessionId, envelope);
    case "permission.replied":
    case "permission.v2.replied":
      return make("opencode", "permission.resolved", type, sessionId, envelope);
    case "session.error":
      return make("opencode", "turn.error", type, sessionId, envelope);
    default:
      return make("opencode", "raw", type, sessionId, envelope);
  }
}

/* ---------------------------- display helpers ---------------------------- */

/** Short human-readable digest of a permission request, for the top board. */
export function permissionDigest(event: NormalizedEvent): string {
  const body = asRecord(event.payload.body);
  switch (event.agent) {
    case "claude":
    case "codex":
    case "agy": {
      const tool = str(body.tool_name) ?? str(asRecord(body).message) ?? "approval";
      return String(tool);
    }
    case "opencode": {
      const props = asRecord(body.properties);
      return str(props.permission) ?? str(props.action) ?? "approval";
    }
  }
}
