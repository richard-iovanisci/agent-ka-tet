import { describe, expect, test } from "bun:test";
import type { AgentIdentity } from "../types.ts";
import { mapNativeEvent, permissionDigest } from "./mappers.ts";

const CLAUDE: AgentIdentity = { id: "primary-claude", kind: "claude" };
const CODEX: AgentIdentity = { id: "review_codex", kind: "codex" };

describe("Claude mapper", () => {
  test("hook events map to canonical types and preserve instance identity", () => {
    const cases: Array<[string, string]> = [
      ["SessionStart", "session.start"],
      ["UserPromptSubmit", "turn.start"],
      ["Stop", "turn.complete"],
      ["StopFailure", "turn.error"],
      ["PermissionRequest", "permission.request"],
      ["PermissionDenied", "permission.resolved"],
      ["PostToolUse", "permission.resolved"],
      ["SessionEnd", "agent.exit"],
    ];

    for (const [native, normalized] of cases) {
      const event = mapNativeEvent(CLAUDE, {
        hook_event_name: native,
        session_id: "s1",
      });
      expect(event.agent).toBe("primary-claude");
      expect(event.kind).toBe("claude");
      expect(event.type).toBe(normalized as never);
      expect(event.sessionId).toBe("s1");
      expect(event.payload.nativeType).toBe(native);
    }
  });

  test("notification subtypes", () => {
    const permission = mapNativeEvent(CLAUDE, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "s1",
    });
    expect(permission.type).toBe("permission.request");
    expect(permission.payload.nativeType).toBe(
      "Notification:permission_prompt",
    );

    const idle = mapNativeEvent(CLAUDE, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "s1",
    });
    expect(idle.type).toBe("raw");
    expect(idle.payload.nativeType).toBe("Notification:idle_prompt");

    const needsInput = mapNativeEvent(CLAUDE, {
      hook_event_name: "Notification",
      notification_type: "agent_needs_input",
      session_id: "s1",
    });
    expect(needsInput.type).toBe("needs.input");

    // A background subagent completing does not complete the main session.
    const subagent = mapNativeEvent(CLAUDE, {
      hook_event_name: "Notification",
      notification_type: "agent_completed",
      session_id: "s1",
    });
    expect(subagent.type).toBe("raw");
  });

  test("unknown and malformed payloads degrade to raw without losing identity", () => {
    for (const body of [null, "junk", { hook_event_name: "SomethingNew" }]) {
      const event = mapNativeEvent(CLAUDE, body);
      expect(event.agent).toBe("primary-claude");
      expect(event.kind).toBe("claude");
      expect(event.type).toBe("raw");
    }
  });
});

describe("Codex mapper", () => {
  test("hook events map to canonical types and preserve instance identity", () => {
    const cases: Array<[string, string]> = [
      ["SessionStart", "session.start"],
      ["UserPromptSubmit", "turn.start"],
      ["Stop", "turn.complete"],
      ["PermissionRequest", "permission.request"],
      ["PostToolUse", "permission.resolved"],
    ];

    for (const [native, normalized] of cases) {
      const event = mapNativeEvent(CODEX, {
        hook_event_name: native,
        session_id: "c1",
      });
      expect(event.agent).toBe("review_codex");
      expect(event.kind).toBe("codex");
      expect(event.type).toBe(normalized as never);
      expect(event.sessionId).toBe("c1");
      expect(event.payload.nativeType).toBe(native);
    }
  });

  test("permission request exposes a human-readable digest", () => {
    const event = mapNativeEvent(CODEX, {
      hook_event_name: "PermissionRequest",
      session_id: "c1",
      tool_name: "shell",
    });
    expect(event.agent).toBe("review_codex");
    expect(event.kind).toBe("codex");
    expect(event.type).toBe("permission.request");
    expect(permissionDigest(event)).toBe("shell");
  });

  test("unknown and malformed payloads degrade to raw without losing identity", () => {
    for (const body of [null, "junk", { hook_event_name: "SomethingNew" }]) {
      const event = mapNativeEvent(CODEX, body);
      expect(event.agent).toBe("review_codex");
      expect(event.kind).toBe("codex");
      expect(event.type).toBe("raw");
    }
  });
});
