/**
 * Core contracts for Agent Bridge. Every module builds against this file;
 * changes here ripple everywhere, so keep it small and deliberate.
 */

/** Adapter implementations active in v0. Configured instance ids are separate. */
export const AGENT_KINDS = ["claude", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export type AgentId = string;

export interface AgentIdentity {
  id: AgentId;
  kind: AgentKind;
}

export function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(v);
}

/** Agent lifecycle states (DESIGN.md §4 / CLAUDE.md). */
export const AGENT_STATES = [
  "launching",
  "working",
  "idle",
  "needs_you",
  "done",
  "error",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * Canonical internal event vocabulary. Per-agent mappers translate native
 * hook payloads into these; the state machine consumes only these.
 * The original native event name and body are preserved in the payload
 * envelope, so nothing is lost by normalizing.
 */
export const EVENT_TYPES = [
  "session.start", //   agent session began (SessionStart)
  "turn.start", //      agent began working on a prompt
  "turn.complete", //   agent finished its turn (Stop)
  "turn.error", //      turn aborted or failed (StopFailure)
  "permission.request", // agent is blocked on an approval
  "permission.resolved", // approval granted/denied; agent may resume
  "needs.input", //     agent is waiting on the human (explicit needs-input notification)
  "agent.done", //      agent reports the task complete
  "agent.exit", //      agent process ended
  "raw", //             unrecognized native event, stored for forensics only
] as const;
export type NormalizedEventType = (typeof EVENT_TYPES)[number];

/** Envelope preserving the native event alongside the normalized type. */
export interface EventPayload {
  /** Native event name as the agent emitted it (e.g. "Stop", "session.idle"). */
  nativeType: string;
  /** Native body, stored verbatim. */
  body: unknown;
}

/** The normalized event (DESIGN.md: {agent, kind, type, sessionId, ts, payload}). */
export interface NormalizedEvent {
  /** Configured instance id, not the adapter kind. */
  agent: AgentId;
  kind: AgentKind;
  type: NormalizedEventType;
  sessionId: string | null;
  /** Epoch milliseconds. Daemon receive time unless the source supplies one. */
  ts: number;
  payload: EventPayload;
}

/** Compact event provenance carried in the live status projection. */
export interface AgentStatusEvent {
  type: NormalizedEventType;
  nativeType: string;
  ts: number;
}

/** Per-agent view the daemon maintains and `bridge top` renders. */
export interface AgentStatus {
  /** Configured instance id. */
  agent: AgentId;
  kind: AgentKind;
  /** From bridge.config — disabled agents are shown dimmed, never "stuck". */
  enabled: boolean;
  state: AgentState;
  sessionId: string | null;
  /** Last normalized event applied, if any. */
  lastEvent: AgentStatusEvent | null;
  /** Event that established the unresolved `needs_you` state, if any. */
  activeAttention: AgentStatusEvent | null;
  /** Pending permission or fallback human-attention detail for display. */
  pendingPermission: string | null;
}

/** GET /status response shape (daemon HTTP API). */
export interface StatusResponse {
  daemon: {
    startedAt: number;
    port: number;
    pid: number;
    /** Absolute directory from which bridge.config.jsonc was loaded. */
    configDir: string;
    /** Agent Bridge checkout/build serving this daemon. */
    sourceRoot: string;
    /** Runtime source-content identity captured at process load. */
    sourceFingerprint: string;
    /** Hash of all runtime-relevant loaded configuration. */
    configFingerprint: string;
  };
  /** Configured order is preserved for deterministic pane/card placement. */
  agents: AgentStatus[];
}
