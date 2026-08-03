import type { AgentConfig, BridgeConfig } from "../config.ts";
import type {
  AgentId,
  AgentStatus,
  AgentStatusEvent,
  NormalizedEvent,
  NormalizedEventType,
} from "../types.ts";
import { permissionDigest } from "../adapters/mappers.ts";
import { INITIAL_STATE, nextState } from "./stateMachine.ts";

/** In-memory status registry, ordered by the configured agent roster. */
export interface Registry {
  validate(event: NormalizedEvent): void;
  /**
   * Project and commit one event. `beforeCommit`, when supplied, must durably
   * append the chosen semantic/raw representation; a throw leaves state and
   * active-turn correlation unchanged.
   */
  apply(
    event: NormalizedEvent,
    beforeCommit?: (persistedEvent: NormalizedEvent) => void,
  ): RegistryApplyResult;
  snapshot(): AgentStatus[];
}

/**
 * Result of projecting one event. Rejected semantic events are preserved in
 * the append-only history as `raw`, but must not mutate the live projection or
 * appear to handoff consumers as an authoritative completion.
 */
export interface RegistryApplyResult {
  status: AgentStatus;
  applied: boolean;
  persistedEvent: NormalizedEvent;
}

interface TurnCorrelation {
  promptId: string | null;
  turnId: string | null;
}

const ATTENTION_CLEARING: ReadonlySet<NormalizedEventType> = new Set([
  "permission.resolved",
  "turn.start",
  "turn.complete",
  "turn.error",
  "session.start",
  "agent.done",
  "agent.exit",
]);

function seedStatus(agent: AgentConfig): AgentStatus {
  return {
    agent: agent.id,
    kind: agent.kind,
    enabled: agent.enabled,
    state: INITIAL_STATE,
    sessionId: null,
    lastEvent: null,
    activeAttention: null,
    pendingPermission: null,
  };
}

function copyStatus(status: AgentStatus): AgentStatus {
  return {
    ...status,
    lastEvent: status.lastEvent === null ? null : { ...status.lastEvent },
    activeAttention:
      status.activeAttention === null ? null : { ...status.activeAttention },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function turnCorrelation(event: NormalizedEvent): TurnCorrelation {
  const body = asRecord(event.payload.body);
  return {
    promptId: nonEmptyString(body.prompt_id),
    turnId: nonEmptyString(body.turn_id),
  };
}

function turnCorrelationKey(correlation: TurnCorrelation): string | null {
  if (correlation.promptId === null && correlation.turnId === null) return null;
  return JSON.stringify([correlation.promptId, correlation.turnId]);
}

/**
 * A terminal event must share at least one provider correlation id with the
 * active turn. Any shared-but-different id is authoritative evidence that it
 * belongs to another turn. With no shared id, fail closed in `working`.
 */
function matchesTurn(
  active: TurnCorrelation | undefined,
  terminal: TurnCorrelation,
): boolean {
  if (active === undefined) return false;
  let shared = 0;
  for (const key of ["promptId", "turnId"] as const) {
    if (active[key] !== null && terminal[key] !== null) {
      shared += 1;
      if (active[key] !== terminal[key]) return false;
    }
  }
  return shared > 0;
}

function demoteToRaw(event: NormalizedEvent): NormalizedEvent {
  return { ...event, type: "raw" };
}

export function createRegistry(cfg: BridgeConfig): Registry {
  const order = cfg.agents.map((agent) => agent.id);
  const statuses = new Map<AgentId, AgentStatus>(
    cfg.agents.map((agent) => [agent.id, seedStatus(agent)]),
  );
  const activeTurns = new Map<AgentId, TurnCorrelation>();
  const seenTurnKeys = new Map<AgentId, Set<string>>();

  function validate(event: NormalizedEvent): void {
    const current = statuses.get(event.agent);
    if (current === undefined || current.kind !== event.kind) {
      throw new Error(`event targets unconfigured agent "${event.agent}" (${event.kind})`);
    }
    if (!current.enabled) {
      throw new Error(`event targets disabled agent "${event.agent}"`);
    }
  }

  return {
    validate,

    apply(
      event: NormalizedEvent,
      beforeCommit?: (persistedEvent: NormalizedEvent) => void,
    ): RegistryApplyResult {
      validate(event);
      const current = statuses.get(event.agent)!;

      // Raw/native-unknown events are always retained as last-event
      // provenance, but can neither establish nor replace a session binding.
      // Semantic events must belong to the bound session. The two events that
      // can establish a missing binding are a genuine session start and the
      // first provenance-validated turn start. The latter is required both for
      // Codex's first-turn timing and for either managed TUI after a daemon-only
      // restart that did not restart the native session.
      let applied = event.type === "raw";
      if (event.type === "session.start") {
        applied =
          event.sessionId !== null &&
          current.state !== "working" && current.state !== "needs_you";
      } else if (event.type === "turn.start") {
        applied =
          event.sessionId !== null &&
          (current.sessionId === null ||
            event.sessionId === current.sessionId);
      } else if (event.type !== "raw") {
        applied =
          current.sessionId !== null && event.sessionId === current.sessionId;
      }

      const eventTurn = event.type === "turn.start" ||
          event.type === "turn.complete" || event.type === "turn.error"
        ? turnCorrelation(event)
        : undefined;
      if (applied && event.type === "turn.start" && eventTurn !== undefined) {
        const key = turnCorrelationKey(eventTurn);
        if (key !== null && seenTurnKeys.get(event.agent)?.has(key)) {
          applied = false;
        }
      }

      if (
        applied &&
        (event.type === "turn.complete" || event.type === "turn.error")
      ) {
        applied = matchesTurn(
          activeTurns.get(event.agent),
          eventTurn ?? turnCorrelation(event),
        );
      }

      if (!applied) {
        const result: RegistryApplyResult = {
          status: copyStatus(current),
          applied: false,
          persistedEvent: demoteToRaw(event),
        };
        beforeCommit?.(result.persistedEvent);
        return result;
      }

      const eventStatus: AgentStatusEvent = {
        type: event.type,
        nativeType: event.payload.nativeType,
        ts: event.ts,
      };
      const next: AgentStatus = {
        ...current,
        state: nextState(current.state, event.type),
        lastEvent: eventStatus,
      };
      if (
        event.sessionId !== null &&
        (event.type === "session.start" ||
          (event.type === "turn.start" && current.sessionId === null))
      ) {
        next.sessionId = event.sessionId;
      }

      // Persistence is the transaction boundary: never expose live state that
      // has no matching append-only history row.
      beforeCommit?.(event);

      if (event.type === "session.start") {
        activeTurns.delete(event.agent);
        seenTurnKeys.delete(event.agent);
      } else if (event.type === "turn.start") {
        const correlation = eventTurn ?? turnCorrelation(event);
        activeTurns.set(event.agent, correlation);
        const key = turnCorrelationKey(correlation);
        if (key !== null) {
          let seen = seenTurnKeys.get(event.agent);
          if (seen === undefined) {
            seen = new Set();
            seenTurnKeys.set(event.agent, seen);
          }
          seen.add(key);
        }
      } else if (
        event.type === "turn.complete" ||
        event.type === "turn.error" ||
        event.type === "agent.done" ||
        event.type === "agent.exit"
      ) {
        activeTurns.delete(event.agent);
      }

      if (event.type === "permission.request") {
        // Claude follows a detailed PermissionRequest with a generic
        // Notification:permission_prompt. Keep the notification as a fallback
        // for notification-only consent prompts, but never let it downgrade an
        // already-active tool name such as "Bash".
        const supplemental =
          event.kind === "claude" &&
          event.payload.nativeType === "Notification:permission_prompt";
        if (!supplemental || current.pendingPermission === null) {
          next.pendingPermission = permissionDigest(event);
        }
        if (!supplemental || current.activeAttention === null) {
          next.activeAttention = eventStatus;
        }
      } else if (event.type === "needs.input") {
        next.activeAttention = eventStatus;
      } else if (ATTENTION_CLEARING.has(event.type)) {
        next.pendingPermission = null;
        next.activeAttention = null;
      }
      statuses.set(event.agent, next);
      return {
        status: copyStatus(next),
        applied: true,
        persistedEvent: event,
      };
    },

    snapshot(): AgentStatus[] {
      return order.map((id) => {
        const status = statuses.get(id);
        if (status === undefined) throw new Error(`missing status for configured agent "${id}"`);
        return copyStatus(status);
      });
    },
  };
}
