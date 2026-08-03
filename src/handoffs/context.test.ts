import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEvent } from "../daemon/store.ts";
import {
  buildCompletionContext,
  collectGitContext,
  HandoffValidationError,
} from "./context.ts";
import {
  MAX_HANDOFF_MESSAGE_BYTES,
  MAX_HANDOFF_PROMPT_BYTES,
} from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function event(
  id: number,
  type: string,
  sessionId: string,
  body: Record<string, unknown>,
  overrides: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    id,
    agent: "claude",
    kind: "claude",
    type,
    native_type: type === "turn.complete" ? "Stop" : "UserPromptSubmit",
    session_id: sessionId,
    ts: id * 1_000,
    payload: JSON.stringify({ nativeType: "test", body }),
    ...overrides,
  };
}

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
}

describe("buildCompletionContext", () => {
  const source = {
    agentId: "claude",
    kind: "claude",
    sessionId: "source-session",
  } as const;

  test("selects only the newest completion in the exact source session", () => {
    const events = [
      event(30, "turn.complete", "other-session", {
        last_assistant_message: "wrong session",
      }),
      event(10, "turn.complete", "source-session", {
        last_assistant_message: "stale result",
      }),
      event(22, "turn.complete", "source-session", {
        last_assistant_message: "stable final answer",
        prompt_id: "prompt-2",
        turn_id: "turn-2",
        effort: { level: "high" },
        cwd: "/repo",
        transcript_path: "/transcripts/source.jsonl",
      }),
      event(21, "turn.start", "source-session", {
        prompt: "Review the current implementation",
        prompt_id: "prompt-2",
        turn_id: "turn-2",
        model: "claude-opus",
        permission_mode: "default",
      }),
      event(20, "turn.start", "source-session", {
        prompt: "unrelated earlier prompt",
        prompt_id: "prompt-1",
      }),
      event(23, "turn.start", "source-session", {
        prompt: "future event must not leak into this completion",
        model: "future-model",
      }),
    ];

    const context = buildCompletionContext(events, source);

    expect(context).toEqual({
      sourceAgent: "claude",
      sourceKind: "claude",
      sourceSession: "source-session",
      sourceEventId: 22,
      completedAt: 22_000,
      nativeType: "Stop",
      prompt: "Review the current implementation",
      promptId: "prompt-2",
      turnId: "turn-2",
      lastAssistantMessage: "stable final answer",
      observed: {
        model: "claude-opus",
        effort: "high",
        permissionMode: "default",
        cwd: "/repo",
        transcriptPath: "/transcripts/source.jsonl",
      },
    });
  });

  test("returns null when the source session has no completed turn", () => {
    expect(buildCompletionContext([
      event(1, "turn.start", "source-session", { prompt: "still working" }),
    ], source)).toBeNull();
  });

  test("ignores higher-id rows from another AgentId or historical adapter kind", () => {
    const events = [
      event(10, "turn.start", "source-session", {
        prompt: "expected prompt",
        prompt_id: "expected-prompt",
        model: "expected-model",
      }),
      event(11, "turn.complete", "source-session", {
        last_assistant_message: "expected completion",
        prompt_id: "expected-prompt",
      }),
      event(30, "turn.complete", "source-session", {
        last_assistant_message: "wrong agent",
      }, { agent: "another-claude" }),
      event(40, "turn.start", "source-session", {
        prompt: "wrong kind prompt",
        model: "wrong-kind-model",
      }, { kind: "codex" }),
      event(41, "turn.complete", "source-session", {
        last_assistant_message: "wrong kind completion",
      }, { kind: "codex" }),
    ];

    const context = buildCompletionContext(events, source);

    expect(context?.sourceEventId).toBe(11);
    expect(context?.lastAssistantMessage).toBe("expected completion");
    expect(context?.prompt).toBe("expected prompt");
    expect(context?.observed.model).toBe("expected-model");
  });

  test("rejects a malformed newest completion instead of falling back to stale work", () => {
    const events = [
      event(1, "turn.complete", "source-session", {
        last_assistant_message: "valid but stale",
      }),
      event(2, "turn.complete", "source-session", {}),
    ];
    expect(() => buildCompletionContext(events, source))
      .toThrow("has no stable last_assistant_message");
  });

  test("rejects an id-less completion instead of pairing it with a newer prompt", () => {
    const events = [
      event(1, "turn.start", "source-session", {
        prompt: "This prompt must not be backfilled",
        prompt_id: "newer-prompt",
      }),
      event(2, "turn.complete", "source-session", {
        last_assistant_message: "Uncorrelated legacy result",
      }),
    ];
    expect(() => buildCompletionContext(events, source)).toThrow(
      "has no prompt_id provider turn token",
    );
  });

  test("omits an oversized optional source prompt without rejecting the completion", () => {
    const context = buildCompletionContext([
      event(1, "turn.start", "source-session", {
        prompt: "p".repeat(MAX_HANDOFF_PROMPT_BYTES + 1),
        prompt_id: "prompt-oversized",
      }),
      event(2, "turn.complete", "source-session", {
        last_assistant_message: "The result remains valid.",
        prompt_id: "prompt-oversized",
      }),
    ], source);

    expect(context?.prompt).toBeNull();
    expect(context?.lastAssistantMessage).toBe("The result remains valid.");
  });

  test("omits malformed optional metadata without rejecting the completion", () => {
    const context = buildCompletionContext([
      event(1, "turn.start", "source-session", {
        prompt: "Continue safely",
        prompt_id: "prompt-invalid-metadata",
        model: "m".repeat(513),
        effort: { level: "bad\u001b" },
        permission_mode: "bad\nmode",
        cwd: "bad\npath",
        transcript_path: "t".repeat(8 * 1024 + 1),
      }),
      event(2, "turn.complete", "source-session", {
        last_assistant_message: "The required result remains usable.",
        prompt_id: "prompt-invalid-metadata",
      }),
    ], source);

    expect(context?.observed).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
      cwd: null,
      transcriptPath: null,
    });
    expect(context?.lastAssistantMessage).toBe("The required result remains usable.");
  });

  test("rejects terminal controls and oversized assistant output", () => {
    expect(() => buildCompletionContext([
      event(1, "turn.complete", "source-session", {
        last_assistant_message: "unsafe\u001b[31m",
      }),
    ], source)).toThrow(HandoffValidationError);

    expect(() => buildCompletionContext([
      event(1, "turn.complete", "source-session", {
        last_assistant_message: "x".repeat(MAX_HANDOFF_MESSAGE_BYTES + 1),
      }),
    ], source)).toThrow(`exceeds ${MAX_HANDOFF_MESSAGE_BYTES}`);
  });
});

describe("collectGitContext", () => {
  test("degrades explicitly outside a git repository", () => {
    const dir = temporaryDirectory("bridge-handoff-nongit-");
    expect(collectGitContext(dir)).toEqual({
      available: false,
      root: null,
      head: null,
      branch: null,
      status: "",
      diffStat: "",
      changedPaths: [],
      truncated: false,
      reason: "not-a-git-repository",
    });
  });

  test("collects bounded tracked and untracked context through argv git calls", () => {
    const dir = temporaryDirectory("bridge-handoff-git-");
    git(dir, "init", "-b", "handoff-test");
    git(dir, "config", "user.name", "Agent Bridge Test");
    git(dir, "config", "user.email", "bridge@example.invalid");
    writeFileSync(join(dir, "tracked.txt"), "before\n");
    git(dir, "add", "tracked.txt");
    git(dir, "commit", "-m", "initial");
    writeFileSync(join(dir, "tracked.txt"), "after\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");

    const context = collectGitContext(dir);

    expect(context.available).toBe(true);
    expect(context.root).toBe(realpathSync(dir));
    expect(context.branch).toBe("handoff-test");
    expect(context.head).toMatch(/^[0-9a-f]{40}$/);
    expect(context.status).toContain("tracked.txt");
    expect(context.status).toContain("untracked.txt");
    expect(context.diffStat).toContain("tracked.txt");
    expect(context.changedPaths).toEqual(["tracked.txt", "untracked.txt"]);
    expect(context.reason).toBeNull();
  });

  test("omits terminal-unsafe Git paths instead of blocking optional context", () => {
    const dir = temporaryDirectory("bridge-handoff-git-control-path-");
    git(dir, "init", "-b", "handoff-test");
    git(dir, "config", "user.name", "Agent Bridge Test");
    git(dir, "config", "user.email", "bridge@example.invalid");
    writeFileSync(join(dir, "safe.txt"), "safe\n");
    writeFileSync(join(dir, "unsafe\u0001.txt"), "unsafe\n");

    const context = collectGitContext(dir);

    expect(context.available).toBe(true);
    expect(context.changedPaths).toEqual(["safe.txt"]);
    expect(context.truncated).toBe(true);
    expect(context.reason).toBeNull();
  });
});
