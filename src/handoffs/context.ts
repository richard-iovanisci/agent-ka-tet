import { Buffer } from "node:buffer";
import type { StoredEvent } from "../daemon/store.ts";
import type { AgentKind } from "../types.ts";
import {
  MAX_HANDOFF_MESSAGE_BYTES,
  MAX_HANDOFF_PROMPT_BYTES,
  type CompletionContext,
  type CompletionSourceSelector,
  type GitContext,
  type ObservedAgentMetadata,
} from "./types.ts";

const MAX_SCALAR_BYTES = 8 * 1024;
const MAX_GIT_TEXT_BYTES = 64 * 1024;
const MAX_GIT_PATH_BYTES = 8 * 1024;
const MAX_GIT_PATH_LIST_BYTES = 128 * 1024;
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class HandoffValidationError extends Error {
  override name = "HandoffValidationError";
}

/** Normalize line endings and reject terminal control bytes before persistence/paste. */
export function assertSafeText(
  value: string,
  label: string,
  maxBytes: number,
  opts: { allowEmpty?: boolean; scalar?: boolean } = {},
): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (FORBIDDEN_CONTROLS.test(normalized)) {
    throw new HandoffValidationError(`${label} contains a forbidden control character`);
  }
  if (opts.scalar && /[\n\t]/u.test(normalized)) {
    throw new HandoffValidationError(`${label} must be a single-line scalar`);
  }
  if (!opts.allowEmpty && normalized.length === 0) {
    throw new HandoffValidationError(`${label} must not be empty`);
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new HandoffValidationError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

function safeScalar(value: string, label: string, maxBytes = MAX_SCALAR_BYTES): string {
  return assertSafeText(value, label, maxBytes, { scalar: true });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBody(row: StoredEvent): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    throw new HandoffValidationError(`event ${row.id} has malformed JSON payload`);
  }
  const envelope = record(parsed);
  const body = envelope === null ? null : record(envelope.body);
  if (body === null) {
    throw new HandoffValidationError(`event ${row.id} has no object hook body`);
  }
  return body;
}

function tryBody(row: StoredEvent): Record<string, unknown> | null {
  try {
    return parseBody(row);
  } catch {
    return null;
  }
}

function optionalString(
  value: unknown,
  label: string,
  opts: { scalar?: boolean; maxBytes?: number } = {},
): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return assertSafeText(value, label, opts.maxBytes ?? MAX_SCALAR_BYTES, {
    scalar: opts.scalar,
  });
}

/** Optional hook enrichment must never invalidate an otherwise usable result. */
function optionalEnrichmentString(
  value: unknown,
  label: string,
  opts: { scalar?: boolean; maxBytes?: number } = {},
): string | null {
  try {
    return optionalString(value, label, opts);
  } catch (error) {
    if (error instanceof HandoffValidationError) return null;
    throw error;
  }
}

function effortFrom(body: Record<string, unknown>): unknown {
  if (typeof body.effort === "string") return body.effort;
  return record(body.effort)?.level;
}

function latestObserved(
  rows: readonly StoredEvent[],
  field: "model" | "effort" | "permission_mode" | "cwd" | "transcript_path",
): string | null {
  for (const row of rows) {
    const body = tryBody(row);
    if (body === null) continue;
    const value = field === "effort" ? effortFrom(body) : body[field];
    const found = optionalEnrichmentString(value, `event ${row.id} ${field}`, {
      scalar: true,
      maxBytes: field === "cwd" || field === "transcript_path" ? MAX_SCALAR_BYTES : 512,
    });
    if (found !== null) return found;
  }
  return null;
}

function isActiveKind(kind: StoredEvent["kind"]): kind is AgentKind {
  return kind === "claude" || kind === "codex";
}

/**
 * Select the newest completion for one exact configured identity and derive
 * only stable, visible handoff context. A malformed newest completion is an
 * error; we never silently fall back to stale work or another historical kind.
 */
export function buildCompletionContext(
  events: readonly StoredEvent[],
  source: CompletionSourceSelector,
): CompletionContext | null {
  const safeAgentId = safeScalar(source.agentId, "source agent", 256);
  const safeSessionId = safeScalar(source.sessionId, "source session", 512);
  if (!isActiveKind(source.kind)) {
    throw new HandoffValidationError(
      `source kind ${String(source.kind)} is not active`,
    );
  }
  const matchingEvents = events.filter((row) =>
    row.agent === safeAgentId &&
    row.kind === source.kind &&
    row.session_id === safeSessionId
  );
  const completion = matchingEvents
    .filter((row) => row.type === "turn.complete")
    .sort((a, b) => b.id - a.id || b.ts - a.ts)[0];
  if (completion === undefined) return null;

  const body = parseBody(completion);
  const lastAssistantMessage = typeof body.last_assistant_message === "string"
    ? assertSafeText(
      body.last_assistant_message,
      `event ${completion.id} last_assistant_message`,
      MAX_HANDOFF_MESSAGE_BYTES,
    )
    : null;
  if (lastAssistantMessage === null) {
    throw new HandoffValidationError(
      `event ${completion.id} has no stable last_assistant_message`,
    );
  }

  const promptId = optionalString(body.prompt_id, `event ${completion.id} prompt_id`, {
    scalar: true,
    maxBytes: 512,
  });
  const turnId = optionalString(body.turn_id, `event ${completion.id} turn_id`, {
    scalar: true,
    maxBytes: 512,
  });
  const providerTurnToken = source.kind === "claude" ? promptId : turnId;
  if (providerTurnToken === null) {
    throw new HandoffValidationError(
      `event ${completion.id} has no ${source.kind === "claude" ? "prompt_id" : "turn_id"} provider turn token`,
    );
  }
  const preceding = matchingEvents
    .filter((row) => row.id <= completion.id)
    .sort((a, b) => b.id - a.id || b.ts - a.ts);
  const starts = preceding.filter((row) => row.type === "turn.start");
  const matchingStart = starts.find((row) => {
    const startBody = tryBody(row);
    if (startBody === null) return false;
    if (promptId !== null && startBody.prompt_id !== promptId) return false;
    if (turnId !== null && startBody.turn_id !== turnId) return false;
    return true;
  });
  const startBody = matchingStart === undefined ? null : tryBody(matchingStart);
  const prompt = startBody === null
    ? null
    : optionalEnrichmentString(
      startBody.prompt,
      `event ${matchingStart?.id ?? "unknown"} prompt`,
      {
      maxBytes: MAX_HANDOFF_PROMPT_BYTES,
      },
    );

  const observed: ObservedAgentMetadata = {
    model: latestObserved(preceding, "model"),
    effort: latestObserved(preceding, "effort"),
    permissionMode: latestObserved(preceding, "permission_mode"),
    cwd: latestObserved(preceding, "cwd"),
    transcriptPath: latestObserved(preceding, "transcript_path"),
  };

  return {
    sourceAgent: safeAgentId,
    sourceKind: source.kind,
    sourceSession: safeSessionId,
    sourceEventId: completion.id,
    completedAt: completion.ts,
    nativeType: safeScalar(completion.native_type, "completion native type", 256),
    prompt,
    promptId,
    turnId,
    lastAssistantMessage,
    observed,
  };
}

interface GitRun {
  ok: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function runGit(repo: string, args: readonly string[]): GitRun {
  const proc = Bun.spawnSync({
    cmd: ["git", "-c", "color.ui=false", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
    // Hook-derived handoff creation must not buffer unbounded repository
    // output or wait forever on a pathological Git invocation.
    maxBuffer: 256 * 1024,
    timeout: 10_000,
  });
  return { ok: proc.exitCode === 0, stdout: proc.stdout, stderr: proc.stderr };
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  const suffix = "\n… [truncated]";
  const prefix = bytes
    .subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix)))
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return { value: prefix + suffix, truncated: true };
}

function textOutput(run: GitRun, label: string): { value: string; truncated: boolean } {
  const bounded = truncateUtf8(Buffer.from(run.stdout).toString("utf8"), MAX_GIT_TEXT_BYTES);
  return {
    value: assertSafeText(bounded.value, label, MAX_GIT_TEXT_BYTES, { allowEmpty: true }),
    truncated: bounded.truncated,
  };
}

function nulPaths(output: Uint8Array): { paths: string[]; truncated: boolean } {
  const raw = Buffer.from(output);
  let truncated = raw.byteLength > MAX_GIT_PATH_LIST_BYTES;
  let bounded = truncated ? raw.subarray(0, MAX_GIT_PATH_LIST_BYTES) : raw;
  if (truncated) {
    const finalNul = bounded.lastIndexOf(0);
    bounded = finalNul < 0 ? Buffer.alloc(0) : bounded.subarray(0, finalNul + 1);
  }
  const paths: string[] = [];
  for (const path of bounded.toString("utf8").split("\0")) {
    if (path.length === 0) continue;
    try {
      paths.push(assertSafeText(path, "git path", MAX_GIT_PATH_BYTES));
    } catch (error) {
      if (!(error instanceof HandoffValidationError)) throw error;
      // Git permits control bytes and paths longer than our terminal-safe
      // packet budget. Repository context is optional: omit only the unsafe
      // entry and surface the loss through the existing truncation marker.
      truncated = true;
    }
  }
  return { paths, truncated };
}

function unavailable(reason: GitContext["reason"]): GitContext {
  return {
    available: false,
    root: null,
    head: null,
    branch: null,
    status: "",
    diffStat: "",
    changedPaths: [],
    truncated: false,
    reason,
  };
}

/** Collect bounded repository context without invoking a shell. */
export function collectGitContext(repo: string): GitContext {
  const safeRepo = assertSafeText(repo, "repository path", MAX_SCALAR_BYTES, { scalar: true });
  let rootRun: GitRun;
  try {
    rootRun = runGit(safeRepo, ["rev-parse", "--show-toplevel"]);
  } catch {
    return unavailable("git-unavailable");
  }
  if (!rootRun.ok) {
    const stderr = Buffer.from(rootRun.stderr).toString("utf8");
    return unavailable(
      stderr.includes("not a git repository")
        ? "not-a-git-repository"
        : "git-command-failed",
    );
  }

  const rootText = textOutput(rootRun, "git root").value.trim();
  const headRun = runGit(safeRepo, ["rev-parse", "--verify", "HEAD"]);
  const branchRun = runGit(safeRepo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const statusRun = runGit(safeRepo, ["status", "--short", "--untracked-files=all"]);
  const unstagedRun = runGit(safeRepo, ["diff", "--no-ext-diff", "--stat", "--"]);
  const stagedRun = runGit(safeRepo, ["diff", "--cached", "--no-ext-diff", "--stat", "--"]);
  const unstagedPathsRun = runGit(safeRepo, ["diff", "--no-ext-diff", "--name-only", "-z", "--"]);
  const stagedPathsRun = runGit(safeRepo, ["diff", "--cached", "--no-ext-diff", "--name-only", "-z", "--"]);
  const untrackedPathsRun = runGit(safeRepo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (
    !statusRun.ok || !unstagedRun.ok || !stagedRun.ok ||
    !unstagedPathsRun.ok || !stagedPathsRun.ok || !untrackedPathsRun.ok
  ) {
    return unavailable("git-command-failed");
  }

  const status = textOutput(statusRun, "git status");
  const unstaged = textOutput(unstagedRun, "git unstaged diff stat");
  const staged = textOutput(stagedRun, "git staged diff stat");
  const unstagedPaths = nulPaths(unstagedPathsRun.stdout);
  const stagedPaths = nulPaths(stagedPathsRun.stdout);
  const untrackedPaths = nulPaths(untrackedPathsRun.stdout);
  const diffParts: string[] = [];
  if (staged.value.trim().length > 0) diffParts.push(`staged:\n${staged.value.trimEnd()}`);
  if (unstaged.value.trim().length > 0) diffParts.push(`unstaged:\n${unstaged.value.trimEnd()}`);

  return {
    available: true,
    root: assertSafeText(rootText, "git root", MAX_SCALAR_BYTES, { scalar: true }),
    head: headRun.ok
      ? optionalString(textOutput(headRun, "git head").value.trim(), "git head", {
        scalar: true,
        maxBytes: 256,
      })
      : null,
    branch: branchRun.ok
      ? optionalString(textOutput(branchRun, "git branch").value.trim(), "git branch", {
        scalar: true,
        maxBytes: MAX_SCALAR_BYTES,
      })
      : null,
    status: status.value.trimEnd(),
    diffStat: diffParts.join("\n\n"),
    changedPaths: [...new Set([
      ...stagedPaths.paths,
      ...unstagedPaths.paths,
      ...untrackedPaths.paths,
    ])].sort(),
    truncated:
      textOutput(rootRun, "git root").truncated || status.truncated || staged.truncated ||
      unstaged.truncated || stagedPaths.truncated || unstagedPaths.truncated ||
      untrackedPaths.truncated,
    reason: null,
  };
}
