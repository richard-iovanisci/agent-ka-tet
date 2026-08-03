import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import type {
  AgentId,
  AgentKind,
  NormalizedEvent,
  NormalizedEventType,
} from "../types.ts";
import { createRegistry } from "./registry.ts";

let ts = 1;

function nativeEvent(
  type: NormalizedEventType,
  opts: {
    agent?: AgentId;
    kind?: AgentKind;
    sessionId?: string | null;
    nativeType?: string;
    body?: Record<string, unknown>;
  } = {},
): NormalizedEvent {
  return {
    agent: opts.agent ?? "claude",
    kind: opts.kind ?? "claude",
    type,
    sessionId: opts.sessionId === undefined ? "s1" : opts.sessionId,
    ts: ts++,
    payload: {
      nativeType: opts.nativeType ?? type,
      body: opts.body ?? {},
    },
  };
}

describe("daemon registry projection", () => {
  test("launching persists until a genuine session or first semantic turn", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));

    const raw = registry.apply(nativeEvent("raw", {
      sessionId: "untrusted-session",
      nativeType: "SessionStart",
      body: { source: "compact" },
    }));
    expect(raw.applied).toBe(true);
    expect(raw.status.state).toBe("launching");
    expect(raw.status.sessionId).toBeNull();
    expect(raw.status.lastEvent?.type).toBe("raw");

    const unboundPermission = registry.apply(nativeEvent("permission.request", {
      sessionId: "untrusted-session",
    }));
    expect(unboundPermission.applied).toBe(false);
    expect(unboundPermission.persistedEvent.type).toBe("raw");
    expect(unboundPermission.status.state).toBe("launching");
    expect(unboundPermission.status.sessionId).toBeNull();
    expect(unboundPermission.status.lastEvent?.nativeType).toBe("SessionStart");

    const claudeWithoutStart = registry.apply(nativeEvent("turn.start", {
      sessionId: "claude-missing-start",
      body: { prompt_id: "prompt-1" },
    }));
    expect(claudeWithoutStart.applied).toBe(true);
    expect(claudeWithoutStart.status.state).toBe("working");
    expect(claudeWithoutStart.status.sessionId).toBe("claude-missing-start");

    const firstTurn = registry.apply(nativeEvent("turn.start", {
      agent: "codex",
      kind: "codex",
      sessionId: "codex-first-turn",
      body: { turn_id: "turn-1" },
    }));
    expect(firstTurn.applied).toBe(true);
    expect(firstTurn.status.state).toBe("working");
    expect(firstTurn.status.sessionId).toBe("codex-first-turn");
  });

  test("raw and old semantic events cannot rebind an active session", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    registry.apply(nativeEvent("session.start", { sessionId: "current" }));
    registry.apply(nativeEvent("turn.start", {
      sessionId: "current",
      body: { prompt_id: "current-turn" },
    }));

    for (const event of [
      nativeEvent("turn.start", {
        sessionId: "old",
        body: { prompt_id: "old-turn" },
      }),
      nativeEvent("turn.complete", {
        sessionId: "old",
        body: { prompt_id: "current-turn" },
      }),
      nativeEvent("agent.exit", { sessionId: "old" }),
    ]) {
      const result = registry.apply(event);
      expect(result.applied).toBe(false);
      expect(result.persistedEvent.type).toBe("raw");
      expect(result.status.sessionId).toBe("current");
      expect(result.status.state).toBe("working");
      expect(result.status.lastEvent?.type).toBe("turn.start");
    }

    const raw = registry.apply(nativeEvent("raw", {
      sessionId: "old",
      nativeType: "Stop",
    }));
    expect(raw.applied).toBe(true);
    expect(raw.status.sessionId).toBe("current");
    expect(raw.status.state).toBe("working");

    const busyReplacement = registry.apply(nativeEvent("session.start", {
      sessionId: "replacement",
    }));
    expect(busyReplacement.applied).toBe(false);
    expect(busyReplacement.persistedEvent.type).toBe("raw");
    expect(busyReplacement.status.sessionId).toBe("current");
    expect(busyReplacement.status.state).toBe("working");

    registry.apply(nativeEvent("turn.complete", {
      sessionId: "current",
      body: { prompt_id: "current-turn" },
    }));
    const replacement = registry.apply(nativeEvent("session.start", {
      sessionId: "replacement",
    }));
    expect(replacement.applied).toBe(true);
    expect(replacement.status.sessionId).toBe("replacement");
    expect(replacement.status.state).toBe("idle");
  });

  test("a delayed or uncorrelated Claude completion cannot finish a newer turn", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    registry.apply(nativeEvent("session.start"));
    registry.apply(nativeEvent("turn.start", {
      body: { prompt_id: "older" },
    }));
    registry.apply(nativeEvent("turn.start", {
      body: { prompt_id: "newer" },
    }));

    const delayedStart = registry.apply(nativeEvent("turn.start", {
      body: { prompt_id: "older" },
    }));
    expect(delayedStart.applied).toBe(false);
    expect(delayedStart.persistedEvent.type).toBe("raw");
    expect(delayedStart.status.state).toBe("working");

    for (const body of [
      { prompt_id: "older" },
      {},
      { turn_id: "unshared-provider-id" },
    ]) {
      const result = registry.apply(nativeEvent("turn.complete", { body }));
      expect(result.applied).toBe(false);
      expect(result.persistedEvent.type).toBe("raw");
      expect(result.status.state).toBe("working");
      expect(result.status.lastEvent?.type).toBe("turn.start");
    }

    const current = registry.apply(nativeEvent("turn.complete", {
      body: { prompt_id: "newer" },
    }));
    expect(current.applied).toBe(true);
    expect(current.status.state).toBe("idle");
  });

  test("Codex turn_id correlation rejects stale completions and accepts the active one", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    registry.apply(nativeEvent("session.start", {
      agent: "codex",
      kind: "codex",
      sessionId: "c1",
    }));
    registry.apply(nativeEvent("turn.start", {
      agent: "codex",
      kind: "codex",
      sessionId: "c1",
      body: { turn_id: "codex-old" },
    }));
    registry.apply(nativeEvent("turn.start", {
      agent: "codex",
      kind: "codex",
      sessionId: "c1",
      body: { turn_id: "codex-new" },
    }));

    const stale = registry.apply(nativeEvent("turn.error", {
      agent: "codex",
      kind: "codex",
      sessionId: "c1",
      body: { turn_id: "codex-old" },
    }));
    expect(stale.applied).toBe(false);
    expect(stale.status.state).toBe("working");

    const current = registry.apply(nativeEvent("turn.complete", {
      agent: "codex",
      kind: "codex",
      sessionId: "c1",
      body: { turn_id: "codex-new" },
    }));
    expect(current.applied).toBe(true);
    expect(current.status.state).toBe("idle");
  });

  test("every shared correlation id must match", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    registry.apply(nativeEvent("session.start"));
    registry.apply(nativeEvent("turn.start", {
      body: { prompt_id: "p1", turn_id: "t1" },
    }));

    const conflict = registry.apply(nativeEvent("turn.complete", {
      body: { prompt_id: "p1", turn_id: "different" },
    }));
    expect(conflict.applied).toBe(false);
    expect(conflict.status.state).toBe("working");

    const match = registry.apply(nativeEvent("turn.complete", {
      body: { prompt_id: "p1", turn_id: "t1" },
    }));
    expect(match.applied).toBe(true);
    expect(match.status.state).toBe("idle");
  });

  test("raw SessionStart preserves attention and active-turn correlation", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    registry.apply(nativeEvent("session.start", { sessionId: "s1" }));
    registry.apply(nativeEvent("turn.start", {
      sessionId: "s1",
      body: { prompt_id: "p1" },
    }));
    registry.apply(nativeEvent("permission.request", {
      sessionId: "s1",
      nativeType: "PermissionRequest",
      body: { tool_name: "Bash" },
    }));

    const compact = registry.apply(nativeEvent("raw", {
      sessionId: "other-session",
      nativeType: "SessionStart",
      body: { source: "compact" },
    }));
    expect(compact.status.state).toBe("needs_you");
    expect(compact.status.sessionId).toBe("s1");
    expect(compact.status.pendingPermission).toBe("Bash");
    expect(compact.status.activeAttention?.nativeType).toBe("PermissionRequest");
    expect(compact.status.lastEvent?.type).toBe("raw");

    const otherSessionStart = registry.apply(nativeEvent("session.start", {
      sessionId: "nested-session",
      nativeType: "SessionStart",
      body: { source: "startup" },
    }));
    expect(otherSessionStart.applied).toBe(false);
    expect(otherSessionStart.persistedEvent.type).toBe("raw");
    expect(otherSessionStart.status.state).toBe("needs_you");
    expect(otherSessionStart.status.sessionId).toBe("s1");
    expect(otherSessionStart.status.pendingPermission).toBe("Bash");

    const duplicateStart = registry.apply(nativeEvent("session.start", {
      sessionId: "s1",
      nativeType: "SessionStart",
      body: { source: "resume" },
    }));
    expect(duplicateStart.applied).toBe(false);
    expect(duplicateStart.persistedEvent.type).toBe("raw");
    expect(duplicateStart.status.state).toBe("needs_you");
    expect(duplicateStart.status.pendingPermission).toBe("Bash");

    const completion = registry.apply(nativeEvent("turn.complete", {
      sessionId: "s1",
      body: { prompt_id: "p1" },
    }));
    expect(completion.applied).toBe(true);
    expect(completion.status.state).toBe("idle");
    expect(completion.status.pendingPermission).toBeNull();
    expect(completion.status.activeAttention).toBeNull();
  });

  test("a persistence failure cannot advance state or active-turn correlation", () => {
    const registry = createRegistry(defaultConfig(process.cwd()));
    expect(() =>
      registry.apply(nativeEvent("session.start", { sessionId: "s1" }), () => {
        throw new Error("append failed");
      })
    ).toThrow("append failed");
    expect(registry.snapshot()[0]?.state).toBe("launching");
    expect(registry.snapshot()[0]?.sessionId).toBeNull();

    registry.apply(nativeEvent("session.start", { sessionId: "s1" }));
    registry.apply(nativeEvent("turn.start", {
      sessionId: "s1",
      body: { prompt_id: "p1" },
    }));
    expect(() =>
      registry.apply(nativeEvent("turn.complete", {
        sessionId: "s1",
        body: { prompt_id: "p1" },
      }), () => {
        throw new Error("append failed");
      })
    ).toThrow("append failed");
    expect(registry.snapshot()[0]?.state).toBe("working");

    const retried = registry.apply(nativeEvent("turn.complete", {
      sessionId: "s1",
      body: { prompt_id: "p1" },
    }));
    expect(retried.applied).toBe(true);
    expect(retried.status.state).toBe("idle");
  });
});
