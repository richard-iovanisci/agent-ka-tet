import { describe, expect, test } from "bun:test";
import { mapNativeEvent, permissionDigest } from "./mappers.ts";

describe("claude mapper", () => {
  test("hook events map to canonical types", () => {
    const cases: Array<[string, string]> = [
      ["SessionStart", "session.start"],
      ["UserPromptSubmit", "turn.start"],
      ["Stop", "turn.complete"],
      ["StopFailure", "turn.error"],
      ["PermissionRequest", "permission.request"],
      ["PostToolUse", "permission.resolved"],
    ];
    for (const [native, normalized] of cases) {
      const e = mapNativeEvent("claude", { hook_event_name: native, session_id: "s1" });
      expect(e.type).toBe(normalized as never);
      expect(e.sessionId).toBe("s1");
      expect(e.payload.nativeType).toBe(native);
    }
  });

  test("notification subtypes", () => {
    const permission = mapNativeEvent("claude", {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "s1",
    });
    expect(permission.type).toBe("permission.request");
    expect(permission.payload.nativeType).toBe("Notification:permission_prompt");

    const idle = mapNativeEvent("claude", {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "s1",
    });
    expect(idle.type).toBe("needs.input");

    // subagent completion is not "this agent is done"
    const sub = mapNativeEvent("claude", {
      hook_event_name: "Notification",
      notification_type: "agent_completed",
      session_id: "s1",
    });
    expect(sub.type).toBe("raw");
  });

  test("unknown/garbage payloads degrade to raw, never throw", () => {
    expect(mapNativeEvent("claude", null).type).toBe("raw");
    expect(mapNativeEvent("claude", "junk").type).toBe("raw");
    expect(mapNativeEvent("claude", { hook_event_name: "SomethingNew" }).type).toBe("raw");
  });
});

describe("codex mapper", () => {
  test("hook payloads (snake_case)", () => {
    const e = mapNativeEvent("codex", {
      hook_event_name: "Stop",
      session_id: "c1",
      last_assistant_message: "done",
    });
    expect(e.type).toBe("turn.complete");
    expect(e.sessionId).toBe("c1");
  });

  test("notify payload (hyphenated agent-turn-complete)", () => {
    const e = mapNativeEvent("codex", {
      type: "agent-turn-complete",
      "thread-id": "t9",
      "last-assistant-message": "done",
    });
    expect(e.type).toBe("turn.complete");
    expect(e.sessionId).toBe("t9");
    expect(e.payload.nativeType).toBe("agent-turn-complete");
  });

  test("permission request", () => {
    const e = mapNativeEvent("codex", {
      hook_event_name: "PermissionRequest",
      session_id: "c1",
      tool_name: "shell",
    });
    expect(e.type).toBe("permission.request");
    expect(permissionDigest(e)).toBe("shell");
  });
});

describe("opencode mapper", () => {
  test("session.status busy/idle/retry", () => {
    const busy = mapNativeEvent("opencode", {
      id: "evt_1",
      type: "session.status",
      properties: { sessionID: "ses1", status: { type: "busy" } },
    });
    expect(busy.type).toBe("turn.start");

    const idle = mapNativeEvent("opencode", {
      id: "evt_2",
      type: "session.status",
      properties: { sessionID: "ses1", status: { type: "idle" } },
    });
    expect(idle.type).toBe("turn.complete");

    const retry = mapNativeEvent("opencode", {
      id: "evt_3",
      type: "session.status",
      properties: { sessionID: "ses1", status: { type: "retry", attempt: 2 } },
    });
    expect(retry.type).toBe("turn.start");
  });

  test("v1 and v2 permission events both map", () => {
    const v1 = mapNativeEvent("opencode", {
      id: "evt_4",
      type: "permission.asked",
      properties: { id: "per1", sessionID: "ses1", permission: "bash", patterns: ["*"] },
    });
    expect(v1.type).toBe("permission.request");
    expect(permissionDigest(v1)).toBe("bash");

    const v2 = mapNativeEvent("opencode", {
      id: "evt_5",
      type: "permission.v2.asked",
      properties: { id: "per2", sessionID: "ses1", action: "fs.write", resources: [] },
    });
    expect(v2.type).toBe("permission.request");
    expect(permissionDigest(v2)).toBe("fs.write");

    const replied = mapNativeEvent("opencode", {
      id: "evt_6",
      type: "permission.replied",
      properties: { sessionID: "ses1", requestID: "per1", reply: "once" },
    });
    expect(replied.type).toBe("permission.resolved");
  });

  test("session.error with optional fields", () => {
    const e = mapNativeEvent("opencode", { id: "evt_7", type: "session.error", properties: {} });
    expect(e.type).toBe("turn.error");
    expect(e.sessionId).toBeNull();
  });

  test("session.created starts a session; unknown types are raw", () => {
    const created = mapNativeEvent("opencode", {
      id: "evt_8",
      type: "session.created",
      properties: { sessionID: "ses1", info: {} },
    });
    expect(created.type).toBe("session.start");
    expect(mapNativeEvent("opencode", { id: "evt_9", type: "message.part.updated", properties: {} }).type).toBe("raw");
  });
});

describe("agy mapper (optimistic Claude-shape until docs/agy-notes.md verifies)", () => {
  test("claude-compatible names map, unknown degrades to raw", () => {
    expect(mapNativeEvent("agy", { hook_event_name: "Stop", session_id: "a1" }).type).toBe("turn.complete");
    expect(mapNativeEvent("agy", { hook_event_name: "Mystery" }).type).toBe("raw");
  });
});
