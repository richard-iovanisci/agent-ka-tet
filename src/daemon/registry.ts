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
  apply(event: NormalizedEvent): AgentStatus;
  snapshot(): AgentStatus[];
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

export function createRegistry(cfg: BridgeConfig): Registry {
  const order = cfg.agents.map((agent) => agent.id);
  const statuses = new Map<AgentId, AgentStatus>(
    cfg.agents.map((agent) => [agent.id, seedStatus(agent)]),
  );

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

    apply(event: NormalizedEvent): AgentStatus {
      validate(event);
      const current = statuses.get(event.agent)!;
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
      if (event.sessionId !== null) next.sessionId = event.sessionId;
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
      return copyStatus(next);
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
