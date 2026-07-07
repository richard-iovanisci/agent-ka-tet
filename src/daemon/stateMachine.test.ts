import { describe, expect, test } from "bun:test";
import { INITIAL_STATE, nextState } from "./stateMachine.ts";
import type { AgentState, NormalizedEventType } from "../types.ts";

function replay(events: NormalizedEventType[], from: AgentState = INITIAL_STATE): AgentState {
  return events.reduce((s, e) => nextState(s, e), from);
}

describe("state machine", () => {
  test("launch -> session start -> idle", () => {
    expect(replay(["session.start"])).toBe("idle");
  });

  test("prompt -> working -> stop -> idle", () => {
    expect(replay(["session.start", "turn.start", "turn.complete"])).toBe("idle");
  });

  test("permission request flips to needs_you; resolution resumes work", () => {
    expect(replay(["session.start", "turn.start", "permission.request"])).toBe("needs_you");
    expect(replay(["session.start", "turn.start", "permission.request", "permission.resolved"])).toBe("working");
  });

  test("turn ending while needs_you returns to idle", () => {
    expect(replay(["session.start", "turn.start", "permission.request", "turn.complete"])).toBe("idle");
  });

  test("failure -> error, recoverable by a new prompt", () => {
    expect(replay(["session.start", "turn.start", "turn.error"])).toBe("error");
    expect(replay(["session.start", "turn.start", "turn.error", "turn.start"])).toBe("working");
  });

  test("agent.exit preserves error, otherwise done", () => {
    expect(nextState("error", "agent.exit")).toBe("error");
    expect(nextState("idle", "agent.exit")).toBe("done");
  });

  test("raw events never change state", () => {
    for (const s of ["launching", "working", "idle", "needs_you", "done", "error"] as const) {
      expect(nextState(s, "raw")).toBe(s);
    }
  });

  test("needs.input flags the human", () => {
    expect(replay(["session.start", "turn.complete", "needs.input"])).toBe("needs_you");
  });
});
