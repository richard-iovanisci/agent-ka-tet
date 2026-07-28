import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentId, AgentKind, NormalizedEvent } from "../types.ts";

/**
 * bun:sqlite event store. Append-only log of normalized events; the registry
 * holds live state, this holds history (forensics, `bridge top` detail,
 * replay). WAL mode so the daemon's writer never blocks readers.
 */

/** Row shape as stored (column names match the schema, snake_case). */
export interface StoredEvent {
  id: number;
  agent: string;
  /** Adapter kind; historical pre-reframe rows migrate as "unknown". */
  kind: AgentKind | "unknown";
  type: string;
  native_type: string;
  session_id: string | null;
  ts: number;
  /** JSON.stringify of the event's payload envelope ({nativeType, body}). */
  payload: string;
}

export interface EventStore {
  /** Insert one event; returns the assigned row id. */
  append(e: NormalizedEvent): number;
  /** Newest-first rows, optionally filtered by agent. Default limit 50. */
  recent(opts?: { agent?: AgentId; limit?: number }): StoredEvent[];
  close(): void;
}

const SELECT_COLUMNS = "id, agent, kind, type, native_type, session_id, ts, payload";

/**
 * Open (creating if needed) the event store at `dbPath`. The parent directory
 * is created for file-backed databases; pass ":memory:" for an ephemeral
 * store in tests.
 */
export function openStore(dbPath: string): EventStore {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL,
      type TEXT NOT NULL,
      native_type TEXT NOT NULL,
      session_id TEXT,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);

  // Phase-0 reframe migration: old databases keyed events only by provider
  // name. Preserve those rows and make the new identity boundary explicit.
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(events)").all();
  if (!columns.some((column) => column.name === "kind")) {
    db.exec("ALTER TABLE events ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown';");
  }

  const insert = db.prepare<StoredEvent, [string, string, string, string, string | null, number, string]>(
    `INSERT INTO events (agent, kind, type, native_type, session_id, ts, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectAll = db.prepare<StoredEvent, [number]>(
    `SELECT ${SELECT_COLUMNS} FROM events ORDER BY id DESC LIMIT ?`,
  );
  const selectByAgent = db.prepare<StoredEvent, [string, number]>(
    `SELECT ${SELECT_COLUMNS} FROM events WHERE agent = ? ORDER BY id DESC LIMIT ?`,
  );

  return {
    append(e: NormalizedEvent): number {
      const result = insert.run(
        e.agent,
        e.kind,
        e.type,
        e.payload.nativeType,
        e.sessionId,
        e.ts,
        JSON.stringify(e.payload),
      );
      return Number(result.lastInsertRowid);
    },

    recent(opts?: { agent?: AgentId; limit?: number }): StoredEvent[] {
      const limit = opts?.limit ?? 50;
      return opts?.agent !== undefined
        ? selectByAgent.all(opts.agent, limit)
        : selectAll.all(limit);
    },

    close(): void {
      db.close();
    },
  };
}
