import type { AgentState, NormalizedEventType } from "../types.ts";

/**
 * Pure transition function: (current state, normalized event) -> next state.
 * The daemon owns the only mutable copy of state; everything else derives
 * from replaying events through this function.
 */
export function nextState(
  current: AgentState,
  event: NormalizedEventType,
): AgentState {
  switch (event) {
    case "session.start":
      return "idle";
    case "turn.start":
      return "working";
    case "turn.complete":
      return "idle";
    case "turn.error":
      return "error";
    case "permission.request":
      return "needs_you";
    case "permission.resolved":
      return "working";
    case "needs.input":
      return "needs_you";
    case "agent.done":
      return "done";
    case "agent.exit":
      // Preserve a visible error; otherwise the pane closing means done.
      return current === "error" ? "error" : "done";
    case "raw":
      return current;
  }
}

export const INITIAL_STATE: AgentState = "launching";
