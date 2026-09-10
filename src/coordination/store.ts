import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BridgeMessage,
  CoordinationStore,
  CreateRunInput,
  CreateRuntimeInput,
  CreateTaskInput,
  DeliveryOutcome,
  DeliveryReceipt,
  DeliveryRoute,
  MessageRecord,
  Run,
  RuntimeAttempt,
  RuntimeObservation,
  ReviewTaskInput,
  SendMessageInput,
  SubmitTaskInput,
  Task,
  TaskState,
  TaskTransitionInput,
  TaskTransitionResult,
} from "./types.ts";

export class CoordinationError extends Error {
  constructor(
    public readonly code:
      | "invalid"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "unavailable"
      | "limit",
    message: string,
  ) {
    super(message);
    this.name = "CoordinationError";
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireText(value: string, field: string, maxBytes = 64 * 1024): void {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new CoordinationError("invalid", `${field} must be nonempty and at most ${maxBytes} bytes`);
  }
}

function requireSession(value: string): void {
  if (typeof value !== "string" || !UUID.test(value))
    throw new CoordinationError("invalid", "native session must be an exact UUID");
}

function requireFields(value: unknown, allowed: string[]): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new CoordinationError("invalid", "unsupported task fields");
}

function canonicalCheckout(path: string): string {
  const workspace = realpathSync(path);
  if (!statSync(workspace).isDirectory())
    throw new CoordinationError("invalid", "workspace must be a directory");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "--show-toplevel"], {
    env: { ...env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return realpathSync(result.stdout.toString().trim());
  if (result.stderr.toString().includes("not a git repository")) return workspace;
  throw new CoordinationError("unavailable", "cannot establish canonical checkout ownership");
}

const RUNTIME_COLUMNS = `id, run_id AS runId, agent_id AS agentId, kind, workspace, access,
  expected_session_id AS expectedSessionId, session_id AS sessionId,
  ready, paused, revoked, exited, created_at AS createdAt`;
const RECEIPT_COLUMNS = `message_id AS messageId, policy, state, application, route,
  request_id AS requestId, turn_id AS turnId, item_id AS itemId, detail,
  sending_at AS sendingAt, finished_at AS finishedAt, fetched_at AS fetchedAt,
  acknowledged_at AS acknowledgedAt, replied_at AS repliedAt`;

export function openCoordinationStore(path: string, options: { now?: () => number } = {}): CoordinationStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_run (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_attempt (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES coordination_run(id), agent_id TEXT NOT NULL,
      kind TEXT NOT NULL, workspace TEXT NOT NULL, access TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE,
      expected_session_id TEXT, session_id TEXT, ready INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0,
      exited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_agent ON runtime_attempt(run_id, agent_id) WHERE revoked = 0 AND exited = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS checkout_writer ON runtime_attempt(workspace) WHERE access = 'write' AND exited = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS native_session_owner ON runtime_attempt(kind, session_id) WHERE session_id IS NOT NULL AND exited = 0;
    CREATE TABLE IF NOT EXISTS bridge_message (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES coordination_run(id),
      sender_id TEXT NOT NULL REFERENCES runtime_attempt(id), recipient_id TEXT NOT NULL REFERENCES runtime_attempt(id),
      idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, value TEXT NOT NULL,
      UNIQUE(sender_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS delivery_attempt (
      message_id TEXT PRIMARY KEY REFERENCES bridge_message(id), policy TEXT NOT NULL, state TEXT NOT NULL,
      application TEXT NOT NULL DEFAULT 'unread', route TEXT, request_id TEXT NOT NULL UNIQUE,
      turn_id TEXT, item_id TEXT, detail TEXT, sending_at INTEGER, finished_at INTEGER,
      fetched_at INTEGER, acknowledged_at INTEGER, replied_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS runtime_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL REFERENCES runtime_attempt(id), value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordination_task (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES coordination_run(id),
      implementer_id TEXT NOT NULL REFERENCES runtime_attempt(id),
      reviewer_id TEXT NOT NULL REFERENCES runtime_attempt(id), version INTEGER NOT NULL, value TEXT NOT NULL,
      last_notice_id TEXT REFERENCES bridge_message(id),
      CHECK (implementer_id != reviewer_id)
    );
  `);
  const now = options.now ?? Date.now;
  const get = <T>(sql: string, ...args: SQLQueryBindings[]): T | null =>
    db.query<T, SQLQueryBindings[]>(sql).get(...args);
  const all = <T>(sql: string, ...args: SQLQueryBindings[]): T[] =>
    db.query<T, SQLQueryBindings[]>(sql).all(...args);
  const write = (sql: string, ...args: SQLQueryBindings[]) => db.query(sql).run(...args);
  const atomic = <T>(fn: () => T): T => db.transaction(fn).immediate();
  atomic(() => {
    if (!all<{ name: string }>("PRAGMA table_info(coordination_task)").some((column) => column.name === "last_notice_id"))
      db.exec("ALTER TABLE coordination_task ADD COLUMN last_notice_id TEXT REFERENCES bridge_message(id)");
  });

  function run(id?: string): Run | null {
    const row =
      id === undefined
        ? get<{ value: string }>("SELECT value FROM coordination_run LIMIT 1")
        : get<{ value: string }>("SELECT value FROM coordination_run WHERE id = ?", id);
    return row === null ? null : (JSON.parse(row.value) as Run);
  }

  function requireRun(id: string): Run {
    const found = run(id);
    if (found === null) throw new CoordinationError("not_found", "run not found");
    return found;
  }

  function runtime(id: string): RuntimeAttempt {
    const row = get<RuntimeAttempt>(`SELECT ${RUNTIME_COLUMNS} FROM runtime_attempt WHERE id = ?`, id);
    if (row === null) throw new CoordinationError("not_found", "runtime not found");
    return { ...row, ready: !!row.ready, paused: !!row.paused, revoked: !!row.revoked, exited: !!row.exited };
  }

  function active(id: string): RuntimeAttempt {
    const found = runtime(id);
    if (found.revoked || found.exited)
      throw new CoordinationError("unauthorized", "runtime credential is inactive");
    return found;
  }

  function authenticateForBinding(token: string): RuntimeAttempt {
    if (typeof token !== "string" || token.length < 32 || token.length > 128)
      throw new CoordinationError("unauthorized", "invalid runtime credential");
    const row = get<{ id: string }>(
      "SELECT id FROM runtime_attempt WHERE credential_hash = ?",
      digest(token),
    );
    if (row === null) throw new CoordinationError("unauthorized", "invalid runtime credential");
    return active(row.id);
  }

  function authenticate(token: string): RuntimeAttempt {
    const found = authenticateForBinding(token);
    if (found.sessionId === null || found.sessionId !== found.expectedSessionId)
      throw new CoordinationError("unauthorized", "runtime has no validated native binding");
    return found;
  }

  function record(id: string): MessageRecord {
    const row = get<{ value: string }>("SELECT value FROM bridge_message WHERE id = ?", id);
    if (row === null) throw new CoordinationError("not_found", "message not found");
    const receipt = get<DeliveryReceipt>(
      `SELECT ${RECEIPT_COLUMNS} FROM delivery_attempt WHERE message_id = ?`,
      id,
    );
    if (receipt === null) throw new Error("message is missing its durable delivery attempt");
    return { message: JSON.parse(row.value) as BridgeMessage, receipt };
  }

  function refreshPolicies(): void {
    const current = run();
    if (current === null) return;
    write(
      `UPDATE delivery_attempt SET policy = CASE
      WHEN (SELECT expires_at FROM bridge_message WHERE id = message_id) <= ? THEN 'expired'
      WHEN EXISTS (SELECT 1 FROM runtime_attempt r JOIN bridge_message m ON r.id = m.recipient_id
        WHERE m.id = message_id AND (r.revoked = 1 OR r.exited = 1)) THEN 'cancelled'
      WHEN ? = 1 OR EXISTS (SELECT 1 FROM runtime_attempt r JOIN bridge_message m ON r.id = m.recipient_id
        WHERE m.id = message_id AND (r.ready = 0 OR r.paused = 1 OR r.session_id IS NULL OR r.session_id != r.expected_session_id)) THEN 'held'
      ELSE 'ready' END WHERE state = 'prepared'`,
      now(),
      current.paused ? 1 : 0,
    );
  }

  function createRun(input: CreateRunInput): Run {
    requireText(input.brief, "brief");
    const createdAt = now();
    const value: Run = {
      id: randomUUID(),
      brief: input.brief,
      createdAt,
      expiresAt: input.expiresAt ?? createdAt + 3_600_000,
      maxMessages: input.maxMessages ?? 100,
      maxHops: input.maxHops ?? 8,
      paused: false,
    };
    if (
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= createdAt ||
      !Number.isSafeInteger(value.maxMessages) ||
      value.maxMessages < 1 ||
      !Number.isSafeInteger(value.maxHops) ||
      value.maxHops < 0
    )
      throw new CoordinationError("invalid", "invalid run limits");
    return atomic(() => {
      if (run() !== null) throw new CoordinationError("conflict", "pilot database already has a run");
      write("INSERT INTO coordination_run (id, value) VALUES (?, ?)", value.id, JSON.stringify(value));
      return value;
    });
  }

  function createRuntime(input: CreateRuntimeInput): { runtime: RuntimeAttempt; token: string } {
    requireText(input.agentId, "agentId", 128);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.agentId) ||
      !["claude", "codex"].includes(input.kind) ||
      !["read", "write"].includes(input.access)
    )
      throw new CoordinationError("invalid", "invalid runtime identity or access");
    if (input.expectedSessionId !== undefined) requireSession(input.expectedSessionId);
    const workspace = canonicalCheckout(input.workspace);
    return atomic(() => {
      const current = requireRun(input.runId);
      if (current.expiresAt <= now()) throw new CoordinationError("unavailable", "run has expired");
      if (
        get(
          "SELECT id FROM runtime_attempt WHERE run_id = ? AND agent_id = ? AND revoked = 0 AND exited = 0",
          input.runId,
          input.agentId,
        )
      ) {
        throw new CoordinationError("conflict", "agent already has an active runtime");
      }
      if (
        input.access === "write" &&
        get(
          "SELECT id FROM runtime_attempt WHERE workspace = ? AND access = 'write' AND exited = 0",
          workspace,
        )
      ) {
        throw new CoordinationError("conflict", "checkout writer has not been verified exited");
      }
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      write(
        `INSERT INTO runtime_attempt (id, run_id, agent_id, kind, workspace, access, credential_hash, expected_session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        input.agentId,
        input.kind,
        workspace,
        input.access,
        digest(token),
        input.expectedSessionId ?? null,
        now(),
      );
      return { runtime: runtime(id), token };
    });
  }

  function expectSession(runtimeId: string, sessionId: string): RuntimeAttempt {
    requireSession(sessionId);
    return atomic(() => {
      const target = active(runtimeId);
      if (target.expectedSessionId !== null && target.expectedSessionId !== sessionId)
        throw new CoordinationError("conflict", "native session expectation is immutable");
      write("UPDATE runtime_attempt SET expected_session_id = ? WHERE id = ?", sessionId, runtimeId);
      return runtime(runtimeId);
    });
  }

  function bindRuntime(runtimeId: string, sessionId: string): RuntimeAttempt {
    requireSession(sessionId);
    return atomic(() => {
      const target = active(runtimeId);
      if (
        target.expectedSessionId !== sessionId ||
        (target.sessionId !== null && target.sessionId !== sessionId)
      )
        throw new CoordinationError("conflict", "native session does not match the owned expectation");
      if (
        get(
          "SELECT id FROM runtime_attempt WHERE kind = ? AND session_id = ? AND exited = 0 AND id != ?",
          target.kind,
          sessionId,
          runtimeId,
        )
      )
        throw new CoordinationError("conflict", "native session already has an owner");
      write("UPDATE runtime_attempt SET session_id = ? WHERE id = ?", sessionId, runtimeId);
      return runtime(runtimeId);
    });
  }

  function setReady(runtimeId: string, ready: boolean): RuntimeAttempt {
    return atomic(() => {
      const target = active(runtimeId);
      if (
        ready &&
        (target.sessionId === null ||
          target.sessionId !== target.expectedSessionId ||
          target.paused ||
          requireRun(target.runId).expiresAt <= now())
      )
        throw new CoordinationError("unavailable", "runtime binding or policy is not ready");
      write("UPDATE runtime_attempt SET ready = ? WHERE id = ?", ready ? 1 : 0, runtimeId);
      refreshPolicies();
      return runtime(runtimeId);
    });
  }

  function pauseRuntime(runtimeId: string, paused: boolean): RuntimeAttempt {
    return atomic(() => {
      active(runtimeId);
      write("UPDATE runtime_attempt SET paused = ?, ready = 0 WHERE id = ?", paused ? 1 : 0, runtimeId);
      refreshPolicies();
      return runtime(runtimeId);
    });
  }

  function pauseRun(runId: string, paused: boolean): Run {
    return atomic(() => {
      const current = { ...requireRun(runId), paused };
      write("UPDATE coordination_run SET value = ? WHERE id = ?", JSON.stringify(current), runId);
      write("UPDATE runtime_attempt SET ready = 0 WHERE run_id = ?", runId);
      refreshPolicies();
      return current;
    });
  }

  function disableRuntime(runtimeId: string, exited: boolean): RuntimeAttempt {
    return atomic(() => {
      runtime(runtimeId);
      write(
        `UPDATE runtime_attempt SET revoked = 1, ready = 0${exited ? ", exited = 1" : ""} WHERE id = ?`,
        runtimeId,
      );
      refreshPolicies();
      return runtime(runtimeId);
    });
  }

  function send(token: string, input: SendMessageInput): MessageRecord {
    requireText(input.to, "to", 128);
    requireText(input.body, "body");
    requireText(input.idempotencyKey, "idempotencyKey", 256);
    if (Object.keys(input).some((key) => !["to", "body", "idempotencyKey", "replyTo"].includes(key)))
      throw new CoordinationError("invalid", "unsupported send field");
    if (input.replyTo !== undefined) requireText(input.replyTo, "replyTo", 128);
    return atomic(() => {
      const sender = authenticate(token);
      const previous = get<{ id: string }>(
        "SELECT id FROM bridge_message WHERE sender_id = ? AND idempotency_key = ?",
        sender.id,
        input.idempotencyKey,
      );
      if (previous !== null) {
        const old = record(previous.id);
        if (
          old.message.recipientAgentId !== input.to ||
          old.message.body !== input.body ||
          old.message.replyTo !== (input.replyTo ?? null)
        )
          throw new CoordinationError("conflict", "idempotency key already has different content or scope");
        refreshPolicies();
        return record(previous.id);
      }
      const current = requireRun(sender.runId);
      if (current.expiresAt <= now()) throw new CoordinationError("unavailable", "run has expired");
      const targetRow = get<{ id: string }>(
        "SELECT id FROM runtime_attempt WHERE run_id = ? AND agent_id = ? AND revoked = 0 AND exited = 0",
        sender.runId,
        input.to,
      );
      if (targetRow === null)
        throw new CoordinationError("unavailable", "recipient has no active runtime in this run");
      const target = runtime(targetRow.id);
      if (target.id === sender.id)
        throw new CoordinationError("forbidden", "peer messages require another runtime");
      if (target.sessionId === null || target.sessionId !== target.expectedSessionId)
        throw new CoordinationError("unavailable", "recipient has no validated native binding");
      let hops = 0;
      if (input.replyTo !== undefined) {
        const original = record(input.replyTo).message;
        if (
          original.runId !== sender.runId ||
          original.recipientRuntimeId !== sender.id ||
          original.senderRuntimeId !== target.id
        )
          throw new CoordinationError("forbidden", "reply does not match the exact peer conversation");
        hops = original.hops + 1;
      }
      const count = get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM bridge_message WHERE run_id = ?",
        sender.runId,
      )!.count;
      if (count >= current.maxMessages || hops > current.maxHops)
        throw new CoordinationError("limit", "run message or follow-up limit reached");
      const message: BridgeMessage = {
        id: randomUUID(),
        version: 1,
        runId: sender.runId,
        senderRuntimeId: sender.id,
        senderAgentId: sender.agentId,
        senderSessionId: sender.sessionId!,
        recipientRuntimeId: target.id,
        recipientAgentId: target.agentId,
        recipientSessionId: target.sessionId,
        body: input.body,
        digest: digest(input.body),
        idempotencyKey: input.idempotencyKey,
        replyTo: input.replyTo ?? null,
        hops,
        createdAt: now(),
        expiresAt: current.expiresAt,
      };
      write(
        `INSERT INTO bridge_message (id, run_id, sender_id, recipient_id, idempotency_key, created_at, expires_at, value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.runId,
        sender.id,
        target.id,
        message.idempotencyKey,
        message.createdAt,
        message.expiresAt,
        JSON.stringify(message),
      );
      write(
        "INSERT INTO delivery_attempt (message_id, policy, state, request_id) VALUES (?, 'held', 'prepared', ?)",
        message.id,
        randomUUID(),
      );
      if (input.replyTo !== undefined)
        write(
          "UPDATE delivery_attempt SET application = 'replied', replied_at = COALESCE(replied_at, ?) WHERE message_id = ?",
          now(),
          input.replyTo,
        );
      refreshPolicies();
      return record(message.id);
    });
  }

  function recipientRecord(token: string, messageId: string): MessageRecord {
    const recipient = authenticate(token);
    const found = record(messageId);
    if (
      found.message.recipientRuntimeId !== recipient.id ||
      found.message.recipientSessionId !== recipient.sessionId
    )
      throw new CoordinationError("forbidden", "message belongs to another recipient attempt");
    return found;
  }

  function task(id?: string): Task | null {
    if (id !== undefined) requireText(id, "taskId", 256);
    const row =
      id === undefined
        ? get<{ value: string }>("SELECT value FROM coordination_task LIMIT 1")
        : get<{ value: string }>("SELECT value FROM coordination_task WHERE id = ?", id);
    return row === null ? null : (JSON.parse(row.value) as Task);
  }

  function createTask(input: CreateTaskInput): Task {
    requireFields(input, ["runId", "title", "brief", "implementerRuntimeId", "reviewerRuntimeId"]);
    requireText(input.title, "title", 256);
    requireText(input.brief, "brief");
    return atomic(() => {
      const current = requireRun(input.runId);
      if (current.expiresAt <= now()) throw new CoordinationError("unavailable", "run has expired");
      const implementer = active(input.implementerRuntimeId);
      const reviewer = active(input.reviewerRuntimeId);
      if (implementer.id === reviewer.id || [implementer, reviewer].some((r) => r.runId !== current.id))
        throw new CoordinationError("forbidden", "task roles require distinct runtimes in the same run");
      if (get("SELECT id FROM coordination_task WHERE run_id = ?", current.id))
        throw new CoordinationError("conflict", "pilot run already has a task");
      const createdAt = now();
      const value: Task = {
        id: randomUUID(),
        runId: current.id,
        title: input.title,
        brief: input.brief,
        implementerRuntimeId: implementer.id,
        reviewerRuntimeId: reviewer.id,
        state: "ready",
        version: 1,
        artifact: null,
        reviewSummary: null,
        createdAt,
        updatedAt: createdAt,
      };
      write(
        "INSERT INTO coordination_task (id, run_id, implementer_id, reviewer_id, version, value) VALUES (?, ?, ?, ?, ?, ?)",
        value.id,
        value.runId,
        implementer.id,
        reviewer.id,
        value.version,
        JSON.stringify(value),
      );
      return value;
    });
  }

  function readTask(token: string, taskId?: string): Task | null {
    const caller = authenticate(token);
    const found = task(taskId);
    if (
      found &&
      (caller.runId !== found.runId ||
        ![found.implementerRuntimeId, found.reviewerRuntimeId].includes(caller.id))
    )
      throw new CoordinationError("forbidden", "task belongs to other runtime attempts");
    return found;
  }

  function changingTask(
    token: string,
    input: TaskTransitionInput,
    role: "implementerRuntimeId" | "reviewerRuntimeId",
    states: TaskState[],
  ): Task {
    requireText(input.taskId, "taskId", 256);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new CoordinationError("invalid", "expectedVersion must be a positive safe integer");
    const caller = authenticate(token);
    const current = task(input.taskId);
    if (!current) throw new CoordinationError("not_found", "task not found");
    if (current[role] !== caller.id || current.runId !== caller.runId)
      throw new CoordinationError("forbidden", "task transition belongs to the assigned runtime");
    if (current.version !== input.expectedVersion || !states.includes(current.state))
      throw new CoordinationError("conflict", "task version or state changed");
    if (requireRun(current.runId).expiresAt <= now())
      throw new CoordinationError("unavailable", "run has expired");
    return current;
  }

  function advanceTask(
    current: Task,
    changes: Partial<Pick<Task, "state" | "artifact" | "reviewSummary">>,
  ): Task {
    const next = { ...current, ...changes, version: current.version + 1, updatedAt: now() };
    if (!Number.isSafeInteger(next.version)) throw new CoordinationError("limit", "task version limit reached");
    const updated = write(
      "UPDATE coordination_task SET version = ?, value = ? WHERE id = ? AND version = ?",
      next.version,
      JSON.stringify(next),
      current.id,
      current.version,
    );
    if (updated.changes !== 1) throw new CoordinationError("conflict", "task version changed");
    return next;
  }

  function notifyTask(token: string, current: Task, recipientId: string): TaskTransitionResult {
    const target = active(recipientId);
    const sender = authenticate(token);
    const idempotencyKey = `task:${current.id}:v${current.version}`;
    if (
      get("SELECT id FROM bridge_message WHERE sender_id = ? AND idempotency_key = ?", sender.id, idempotencyKey)
    )
      throw new CoordinationError("conflict", "task notification key is already in use");
    const previous = get<{ last_notice_id: string | null }>(
      "SELECT last_notice_id FROM coordination_task WHERE id = ?", current.id,
    )!.last_notice_id;
    const notification = send(token, {
      to: target.agentId,
      idempotencyKey,
      ...(previous ? { replyTo: previous } : {}),
      body: JSON.stringify({
        type: "task_transition",
        taskId: current.id,
        state: current.state,
        version: current.version,
        artifact: current.artifact,
        reviewSummary: current.reviewSummary,
      }),
    });
    if (notification.message.recipientRuntimeId !== recipientId)
      throw new CoordinationError("conflict", "task notification recipient changed");
    write("UPDATE coordination_task SET last_notice_id = ? WHERE id = ?", notification.message.id, current.id);
    return { task: current, notification };
  }

  function claimTask(token: string, input: TaskTransitionInput): Task {
    requireFields(input, ["taskId", "expectedVersion"]);
    return atomic(() =>
      advanceTask(changingTask(token, input, "implementerRuntimeId", ["ready", "changes_requested"]), {
        state: "working",
      }),
    );
  }

  function submitTask(token: string, input: SubmitTaskInput): TaskTransitionResult {
    requireFields(input, ["taskId", "expectedVersion", "artifact"]);
    requireFields(input.artifact, ["commit", "summary"]);
    if (typeof input.artifact.commit !== "string" || !/^[a-f0-9]{40}$/.test(input.artifact.commit))
      throw new CoordinationError("invalid", "artifact commit must be a full lowercase SHA-1");
    requireText(input.artifact.summary, "artifact summary", 4096);
    return atomic(() => {
      const current = changingTask(token, input, "implementerRuntimeId", ["working"]);
      const next = advanceTask(current, {
        state: "review", artifact: { ...input.artifact }, reviewSummary: null,
      });
      return notifyTask(token, next, current.reviewerRuntimeId);
    });
  }

  function reviewTask(token: string, input: ReviewTaskInput): TaskTransitionResult {
    requireFields(input, ["taskId", "expectedVersion", "decision", "summary"]);
    if (!["accept", "changes_requested"].includes(input.decision))
      throw new CoordinationError("invalid", "unsupported review decision");
    requireText(input.summary, "review summary", 4096);
    return atomic(() => {
      const current = changingTask(token, input, "reviewerRuntimeId", ["review"]);
      const next = advanceTask(current, {
        state: input.decision === "accept" ? "accepted" : "changes_requested",
        reviewSummary: input.summary,
      });
      return notifyTask(token, next, current.implementerRuntimeId);
    });
  }

  function observeApplication(token: string, messageId: string, acknowledge: boolean): MessageRecord {
    return atomic(() => {
      recipientRecord(token, messageId);
      if (acknowledge) {
        write(
          `UPDATE delivery_attempt SET application = CASE WHEN application = 'replied' THEN application ELSE 'acknowledged' END,
          acknowledged_at = COALESCE(acknowledged_at, ?) WHERE message_id = ?`,
          now(),
          messageId,
        );
      } else {
        write(
          `UPDATE delivery_attempt SET application = CASE WHEN application = 'unread' THEN 'fetched' ELSE application END,
          fetched_at = COALESCE(fetched_at, ?) WHERE message_id = ?`,
          now(),
          messageId,
        );
      }
      refreshPolicies();
      return record(messageId);
    });
  }

  function claimDelivery(runtimeId: string, route: DeliveryRoute): MessageRecord | null {
    return atomic(() => {
      const target = active(runtimeId);
      if ((target.kind === "codex" ? "codex" : "claude-channel") !== route)
        throw new CoordinationError("invalid", "route does not match recipient harness");
      refreshPolicies();
      const current = requireRun(target.runId);
      if (
        current.paused ||
        current.expiresAt <= now() ||
        target.paused ||
        !target.ready ||
        target.sessionId === null ||
        target.sessionId !== target.expectedSessionId
      )
        return null;
      const row = get<{ id: string }>(
        `SELECT m.id FROM bridge_message m JOIN delivery_attempt d ON m.id = d.message_id
        WHERE m.recipient_id = ? AND d.state = 'prepared' AND d.policy = 'ready' ORDER BY m.created_at, m.rowid LIMIT 1`,
        runtimeId,
      );
      if (row === null) return null;
      const pending = record(row.id);
      if (pending.message.recipientSessionId !== target.sessionId)
        throw new CoordinationError("conflict", "delivery target binding changed");
      const changed = write(
        "UPDATE delivery_attempt SET state = 'sending', route = ?, sending_at = ? WHERE message_id = ? AND state = 'prepared' AND policy = 'ready'",
        route,
        now(),
        row.id,
      );
      return changed.changes === 1 ? record(row.id) : null;
    });
  }

  function finishDelivery(messageId: string, outcome: DeliveryOutcome): MessageRecord {
    if (!["written", "accepted", "rejected", "ambiguous"].includes(outcome.state))
      throw new CoordinationError("invalid", "invalid native delivery outcome");
    return atomic(() => {
      const current = record(messageId);
      if (current.receipt.state !== "sending")
        throw new CoordinationError("conflict", "delivery is not in flight");
      if (outcome.requestId !== undefined && outcome.requestId !== current.receipt.requestId)
        throw new CoordinationError("conflict", "native outcome request does not match durable intent");
      if (
        (outcome.state === "written" && current.receipt.route !== "claude-channel") ||
        (outcome.state === "accepted" && current.receipt.route !== "codex")
      )
        throw new CoordinationError("invalid", "native outcome does not match the claimed route");
      checkCorrelation(current.receipt, outcome);
      const policy =
        outcome.state === "ambiguous"
          ? "held"
          : outcome.state === "rejected"
            ? "refused"
            : current.receipt.policy;
      write(
        `UPDATE delivery_attempt SET state = ?, policy = ?, turn_id = COALESCE(turn_id, ?), item_id = COALESCE(item_id, ?), detail = ?, finished_at = ?
        WHERE message_id = ? AND state = 'sending'`,
        outcome.state,
        policy,
        outcome.turnId ?? null,
        outcome.itemId ?? null,
        outcome.detail ?? null,
        now(),
        messageId,
      );
      return record(messageId);
    });
  }

  function checkCorrelation(
    receipt: DeliveryReceipt,
    observation: { turnId?: string; itemId?: string },
  ): void {
    for (const key of ["turnId", "itemId"] as const) {
      const value = observation[key];
      if (value === undefined) continue;
      requireText(value, key, 256);
      if (receipt[key] !== null && receipt[key] !== value)
        throw new CoordinationError("conflict", "native delivery correlation conflicts with prior evidence");
    }
  }

  function observeDelivery(
    messageId: string,
    observation: { turnId?: string; itemId?: string },
  ): MessageRecord {
    return atomic(() => {
      const current = record(messageId);
      if (current.receipt.state === "prepared" || current.receipt.route !== "codex")
        throw new CoordinationError("conflict", "message has no claimed Codex delivery");
      checkCorrelation(current.receipt, observation);
      write(
        "UPDATE delivery_attempt SET turn_id = COALESCE(turn_id, ?), item_id = COALESCE(item_id, ?) WHERE message_id = ?",
        observation.turnId ?? null,
        observation.itemId ?? null,
        messageId,
      );
      return record(messageId);
    });
  }

  return {
    createRun,
    run,
    createRuntime,
    runtime,
    expectSession,
    bindRuntime,
    authenticate,
    authenticateForBinding,
    setReady,
    pauseRuntime,
    pauseRun,
    send,
    claimDelivery,
    observeDelivery,
    finishDelivery,
    createTask,
    task,
    readTask,
    claimTask,
    submitTask,
    reviewTask,
    runtimes: () =>
      all<{ id: string }>("SELECT id FROM runtime_attempt ORDER BY created_at, rowid").map((row) =>
        runtime(row.id),
      ),
    revokeRuntime: (id) => disableRuntime(id, false),
    exitRuntime: (id) => disableRuntime(id, true),
    listMessages(token) {
      return atomic(() => {
        const recipient = authenticate(token);
        const rows = all<{ id: string }>(
          "SELECT id FROM bridge_message WHERE recipient_id = ? ORDER BY created_at, rowid",
          recipient.id,
        );
        return rows.map((row) => observeApplication(token, row.id, false));
      });
    },
    readMessage: (token, id) => observeApplication(token, id, false),
    acknowledge: (token, id) => observeApplication(token, id, true),
    receipt(token, id) {
      const caller = authenticate(token);
      const found = record(id);
      if (![found.message.senderRuntimeId, found.message.recipientRuntimeId].includes(caller.id))
        throw new CoordinationError("forbidden", "receipt belongs to another runtime");
      refreshPolicies();
      return record(id).receipt;
    },
    messages() {
      refreshPolicies();
      return all<{ id: string }>("SELECT id FROM bridge_message ORDER BY created_at, rowid").map((row) =>
        record(row.id),
      );
    },
    appendObservation(runtimeId, observation) {
      const target = runtime(runtimeId);
      requireText(observation.source, "observation source", 128);
      requireText(observation.name, "observation name", 256);
      requireSession(observation.sessionId);
      if (observation.sessionId !== (target.sessionId ?? target.expectedSessionId))
        throw new CoordinationError("conflict", "observation does not match runtime session");
      const value = { ...observation, runtimeId, createdAt: now() };
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > 256 * 1024)
        throw new CoordinationError("invalid", "observation exceeds size limit");
      const result = write(
        "INSERT INTO runtime_observation (runtime_id, value) VALUES (?, ?)",
        runtimeId,
        serialized,
      );
      return { ...value, id: Number(result.lastInsertRowid) };
    },
    observations(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new CoordinationError("invalid", "observation limit must be 1 through 1000");
      return all<{ id: number; value: string }>(
        "SELECT id, value FROM runtime_observation ORDER BY id DESC LIMIT ?",
        limit,
      ).map((row) => ({ ...JSON.parse(row.value), id: row.id }) as RuntimeObservation);
    },
    recover() {
      atomic(() => {
        write(
          "UPDATE delivery_attempt SET state = 'ambiguous', policy = 'held', detail = 'coordinator restarted with unresolved native I/O', finished_at = ? WHERE state = 'sending'",
          now(),
        );
        write("UPDATE runtime_attempt SET ready = 0");
        refreshPolicies();
      });
    },
    close: () => db.close(),
  };
}
