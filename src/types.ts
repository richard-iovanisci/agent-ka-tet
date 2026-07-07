/**
 * Core contracts for Agent Bridge. Every module builds against this file;
 * changes here ripple everywhere, so keep it small and deliberate.
 */

export const AGENT_NAMES = ["claude", "codex", "agy", "opencode"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export function isAgentName(v: string): v is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(v);
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
 * hook/SSE payloads into these; the state machine consumes only these.
 * The original native event name and body are preserved in the payload
 * envelope, so nothing is lost by normalizing.
 */
export const EVENT_TYPES = [
  "session.start", //   agent session began (SessionStart / session created)
  "turn.start", //      agent began working on a prompt
  "turn.complete", //   agent finished its turn (Stop / agent-turn-complete / session.idle)
  "turn.error", //      turn aborted or failed (StopFailure / session.error)
  "permission.request", // agent is blocked on an approval
  "permission.resolved", // approval granted/denied; agent may resume
  "needs.input", //     agent is waiting on the human (idle prompt / needs-input notification)
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

/** The normalized event (DESIGN.md: {agent, type, sessionId, ts, payload}). */
export interface NormalizedEvent {
  agent: AgentName;
  type: NormalizedEventType;
  sessionId: string | null;
  /** Epoch milliseconds. Daemon receive time unless the source supplies one. */
  ts: number;
  payload: EventPayload;
}

/** Per-agent view the daemon maintains and `bridge top` renders. */
export interface AgentStatus {
  agent: AgentName;
  /** From bridge.config — disabled agents are shown dimmed, never "stuck". */
  enabled: boolean;
  state: AgentState;
  sessionId: string | null;
  /** Last normalized event applied, if any. */
  lastEvent: { type: NormalizedEventType; nativeType: string; ts: number } | null;
  /** Set while a permission request is pending (payload digest for display). */
  pendingPermission: string | null;
  /** How this agent's state is observed. agy may degrade to "mux". */
  observedVia: "events" | "mux";
}

/** GET /status response shape (daemon HTTP API). */
export interface StatusResponse {
  daemon: { startedAt: number; port: number; pid: number };
  agents: Record<AgentName, AgentStatus>;
}
