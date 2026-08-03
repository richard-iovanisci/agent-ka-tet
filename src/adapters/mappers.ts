import type {
  AgentId,
  AgentIdentity,
  NormalizedEvent,
  NormalizedEventType,
} from "../types.ts";

/**
 * Native-payload -> normalized-event translation for the two active adapter
 * kinds. Anything unrecognized maps to `raw`; mappers never throw or drop an
 * event. Instance identity is supplied separately from adapter kind so state
 * and future handoffs are not coupled to provider names.
 */
export function mapNativeEvent(agent: AgentIdentity, body: unknown): NormalizedEvent {
  switch (agent.kind) {
    case "claude":
      return mapClaudeEvent(body, agent.id);
    case "codex":
      return mapCodexEvent(body, agent.id);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function make(
  agent: AgentIdentity,
  type: NormalizedEventType,
  nativeType: string,
  sessionId: string | null,
  body: unknown,
): NormalizedEvent {
  return {
    agent: agent.id,
    kind: agent.kind,
    type,
    sessionId,
    ts: Date.now(),
    payload: { nativeType, body },
  };
}

/* ------------------------------ Claude Code ------------------------------ */

const CLAUDE_HOOK_MAP: Record<string, NormalizedEventType> = {
  UserPromptSubmit: "turn.start",
  Stop: "turn.complete",
  StopFailure: "turn.error",
  PermissionRequest: "permission.request",
  PermissionDenied: "permission.resolved",
  PostToolUse: "permission.resolved",
  SessionEnd: "agent.exit",
};

const CLAUDE_SESSION_START_SOURCES: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "clear",
  "fork",
]);

const CLAUDE_NOTIFICATION_MAP: Record<string, NormalizedEventType> = {
  permission_prompt: "permission.request",
  agent_needs_input: "needs.input",
};

export function mapClaudeEvent(body: unknown, agentId: AgentId = "claude"): NormalizedEvent {
  const identity: AgentIdentity = { id: agentId, kind: "claude" };
  const o = asRecord(body);
  const name = str(o.hook_event_name);
  const sessionId = str(o.session_id);
  if (name === "Notification") {
    const notificationType = str(o.notification_type) ?? "";
    const mapped = CLAUDE_NOTIFICATION_MAP[notificationType];
    return make(
      identity,
      mapped ?? "raw",
      `Notification:${notificationType}`,
      sessionId,
      body,
    );
  }
  if (name === "SessionStart") {
    const source = str(o.source);
    return make(
      identity,
      source !== null && CLAUDE_SESSION_START_SOURCES.has(source)
        ? "session.start"
        : "raw",
      name,
      sessionId,
      body,
    );
  }
  const mapped = name ? CLAUDE_HOOK_MAP[name] : undefined;
  return make(identity, mapped ?? "raw", name ?? "unknown", sessionId, body);
}

/* -------------------------------- Codex CLI ------------------------------ */

const CODEX_HOOK_MAP: Record<string, NormalizedEventType> = {
  UserPromptSubmit: "turn.start",
  Stop: "turn.complete",
  PermissionRequest: "permission.request",
  PostToolUse: "permission.resolved",
};

const CODEX_SESSION_START_SOURCES: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "clear",
]);

export function mapCodexEvent(body: unknown, agentId: AgentId = "codex"): NormalizedEvent {
  const identity: AgentIdentity = { id: agentId, kind: "codex" };
  const o = asRecord(body);
  const name = str(o.hook_event_name);
  const sessionId = str(o.session_id);
  if (name === "SessionStart") {
    const source = str(o.source);
    return make(
      identity,
      source !== null && CODEX_SESSION_START_SOURCES.has(source)
        ? "session.start"
        : "raw",
      name,
      sessionId,
      body,
    );
  }
  const mapped = name ? CODEX_HOOK_MAP[name] : undefined;
  return make(identity, mapped ?? "raw", name ?? "unknown", sessionId, body);
}

/** Short human-readable digest of a permission request for `bridge top`. */
export function permissionDigest(event: NormalizedEvent): string {
  const body = asRecord(event.payload.body);
  return str(body.tool_name) ?? str(body.message) ?? "approval";
}
