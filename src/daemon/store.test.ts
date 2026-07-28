import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "../types.ts";
import { openStore } from "./store.ts";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    agent: "primary-claude",
    kind: "claude",
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

  test("file-backed store creates parent dirs and roundtrips identity + events", () => {
    const dbPath = join(dir, "nested", "deeper", "events.sqlite");
    const store = openStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const id1 = store.append(event({ ts: 1000 }));
    const id2 = store.append(
      event({
        agent: "review_codex",
        kind: "codex",
        type: "turn.start",
        sessionId: null,
        ts: 2000,
        payload: { nativeType: "UserPromptSubmit", body: {} },
      }),
    );
    const id3 = store.append(event({ ts: 3000 }));
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1 + 1);
    expect(id3).toBe(id2 + 1);

    // Newest first, preserving both configured id and adapter kind.
    const rows = store.recent();
    expect(rows.map((row) => row.id)).toEqual([id3, id2, id1]);
    expect(rows[0]?.agent).toBe("primary-claude");
    expect(rows[0]?.kind).toBe("claude");
    expect(rows[0]?.type).toBe("turn.complete");
    expect(rows[0]?.native_type).toBe("Stop");
    expect(rows[0]?.session_id).toBe("s1");
    expect(rows[0]?.ts).toBe(3000);
    expect(rows[1]?.agent).toBe("review_codex");
    expect(rows[1]?.kind).toBe("codex");
    expect(JSON.parse(rows[1]?.payload ?? "{}")).toEqual({
      nativeType: "UserPromptSubmit",
      body: {},
    });
    expect(rows[1]?.session_id).toBeNull();

    // Limit.
    expect(store.recent({ limit: 2 }).map((row) => row.id)).toEqual([id3, id2]);

    // AgentId is an arbitrary configured instance id, not an adapter kind.
    const reviewerRows = store.recent({ agent: "review_codex" });
    expect(reviewerRows.map((row) => row.id)).toEqual([id2]);
    expect(reviewerRows[0]?.kind).toBe("codex");
    expect(store.recent({ agent: "not-configured" })).toEqual([]);

    store.close();

    // Reopen: data survived (and CREATE TABLE IF NOT EXISTS is idempotent).
    const reopened = openStore(dbPath);
    expect(reopened.recent()).toHaveLength(3);
    expect(reopened.recent({ agent: "primary-claude" })).toHaveLength(2);
    reopened.close();
  });

  test(":memory: store works", () => {
    const store = openStore(":memory:");
    const id = store.append(event());
    expect(id).toBe(1);
    const rows = store.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe("primary-claude");
    expect(rows[0]?.kind).toBe("claude");
    store.close();
  });

  test("migrates pre-reframe databases without losing historical rows", () => {
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        native_type TEXT NOT NULL,
        session_id TEXT,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      INSERT INTO events (agent, type, native_type, session_id, ts, payload)
      VALUES ('claude', 'turn.complete', 'Stop', 'old-session', 1, '{}');
    `);
    legacy.close();

    const store = openStore(dbPath);
    const historical = store.recent();
    expect(historical).toHaveLength(1);
    expect(historical[0]?.agent).toBe("claude");
    expect(historical[0]?.kind).toBe("unknown");
    store.append(event({ agent: "primary-claude", kind: "claude", ts: 2 }));
    expect(store.recent()[0]?.kind).toBe("claude");
    store.close();
  });
});
