import type { BridgeConfig } from "../config.ts";
import type {
  AgentName,
  AgentStatus,
  NormalizedEvent,
  NormalizedEventType,
} from "../types.ts";
import { AGENT_NAMES } from "../types.ts";
import { permissionDigest } from "../adapters/mappers.ts";
import { INITIAL_STATE, nextState } from "./stateMachine.ts";

/**
 * In-memory per-agent status registry. The daemon owns the only mutable copy
 * of agent state (DESIGN.md §4); everything served over HTTP is a snapshot of
 * this. Durable history lives in the event store, not here.
 */

export interface Registry {
  /** Fold one normalized event into the agent's status; returns a copy of it. */
  apply(e: NormalizedEvent): AgentStatus;
  /** Defensive copy of all four agents' statuses. */
  snapshot(): Record<AgentName, AgentStatus>;
}

/**
 * Events that mean any previously pending permission is no longer blocking:
 * an explicit resolution, or the turn/session moving on without one.
 */
const PERMISSION_CLEARING: ReadonlySet<NormalizedEventType> = new Set([
  "permission.resolved",
  "turn.start",
  "turn.complete",
  "turn.error",
  "session.start",
]);

function seedStatus(agent: AgentName, cfg: BridgeConfig): AgentStatus {
  return {
    agent,
    enabled: cfg.agents[agent].enabled,
    state: INITIAL_STATE,
    sessionId: null,
    lastEvent: null,
    pendingPermission: null,
    // agy starts mux-observed (weakest event surface, DESIGN.md §7) and is
    // upgraded the moment a real (non-raw) event arrives from it.
    observedVia: agent === "agy" ? "mux" : "events",
  };
}

function copyStatus(s: AgentStatus): AgentStatus {
  return { ...s, lastEvent: s.lastEvent === null ? null : { ...s.lastEvent } };
}

export function createRegistry(cfg: BridgeConfig): Registry {
  const statuses = Object.fromEntries(
    AGENT_NAMES.map((name) => [name, seedStatus(name, cfg)]),
  ) as Record<AgentName, AgentStatus>;

  return {
    apply(e: NormalizedEvent): AgentStatus {
      const current = statuses[e.agent];
      const next: AgentStatus = {
        ...current,
        state: nextState(current.state, e.type),
        // lastEvent updates on EVERY event, raw included — "we heard from it"
        // is signal even when the event carries no transition.
        lastEvent: { type: e.type, nativeType: e.payload.nativeType, ts: e.ts },
      };
      if (e.sessionId !== null) next.sessionId = e.sessionId;
      if (e.type === "permission.request") {
        next.pendingPermission = permissionDigest(e);
      } else if (PERMISSION_CLEARING.has(e.type)) {
        next.pendingPermission = null;
      }
      if (e.agent === "agy" && next.observedVia === "mux" && e.type !== "raw") {
        next.observedVia = "events";
      }
      statuses[e.agent] = next;
      return copyStatus(next);
    },

    snapshot(): Record<AgentName, AgentStatus> {
      return Object.fromEntries(
        AGENT_NAMES.map((name) => [name, copyStatus(statuses[name])]),
      ) as Record<AgentName, AgentStatus>;
    },
  };
}
