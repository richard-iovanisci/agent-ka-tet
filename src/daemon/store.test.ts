import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.ts";
import type { NormalizedEvent } from "../types.ts";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    agent: "claude",
    type: "turn.complete",
    sessionId: "s1",
    ts: Date.now(),
    payload: { nativeType: "Stop", body: { hook_event_name: "Stop" } },
    ...overrides,
  };
}

describe("event store", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-test-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("file-backed store creates parent dirs and roundtrips events", () => {
    const dbPath = join(dir, "nested", "deeper", "events.sqlite");
    const store = openStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const id1 = store.append(event({ ts: 1000 }));
    const id2 = store.append(
      event({ agent: "codex", type: "turn.start", sessionId: null, ts: 2000, payload: { nativeType: "UserPromptSubmit", body: {} } }),
    );
    const id3 = store.append(event({ ts: 3000 }));
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1 + 1);
    expect(id3).toBe(id2 + 1);

    // Newest first.
    const rows = store.recent();
    expect(rows.map((r) => r.id)).toEqual([id3, id2, id1]);
    expect(rows[0]?.agent).toBe("claude");
    expect(rows[0]?.type).toBe("turn.complete");
    expect(rows[0]?.native_type).toBe("Stop");
    expect(rows[0]?.session_id).toBe("s1");
    expect(rows[0]?.ts).toBe(3000);
    expect(JSON.parse(rows[1]?.payload ?? "{}")).toEqual({ nativeType: "UserPromptSubmit", body: {} });
    expect(rows[1]?.session_id).toBeNull();

    // Limit.
    expect(store.recent({ limit: 2 }).map((r) => r.id)).toEqual([id3, id2]);

    // Agent filter.
    const codexRows = store.recent({ agent: "codex" });
    expect(codexRows.map((r) => r.id)).toEqual([id2]);
    expect(store.recent({ agent: "agy" })).toEqual([]);

    store.close();

    // Reopen: data survived (and CREATE TABLE IF NOT EXISTS is idempotent).
    const reopened = openStore(dbPath);
    expect(reopened.recent().length).toBe(3);
    reopened.close();
  });

  test(":memory: store works", () => {
    const store = openStore(":memory:");
    const id = store.append(event());
    expect(id).toBe(1);
    const rows = store.recent();
    expect(rows.length).toBe(1);
    expect(rows[0]?.agent).toBe("claude");
    store.close();
  });
});
