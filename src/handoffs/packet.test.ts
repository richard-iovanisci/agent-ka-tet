import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_HANDOFF_ACTION_BYTES,
  MAX_HANDOFF_MESSAGE_BYTES,
  MAX_HANDOFF_PACKET_BYTES,
  MAX_HANDOFF_PROMPT_BYTES,
  type CompletionContext,
  type GitContext,
} from "./types.ts";
import {
  createHandoffArtifact,
  handoffsDir,
  renderHandoffPacket,
  updateHandoffReceipt,
  verifyPersistedHandoffPacket,
} from "./packet.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-handoff-packet-"));
  temporaryDirectories.push(dir);
  return dir;
}

const completion: CompletionContext = {
  sourceAgent: "claude",
  sourceKind: "claude",
  sourceSession: "claude-session",
  sourceEventId: 42,
  completedAt: 1_700_000_000_000,
  nativeType: "Stop",
  prompt: "Inspect the parser",
  promptId: "prompt-42",
  turnId: "turn-42",
  lastAssistantMessage: "The parser issue is isolated to `parseInput`.",
  observed: {
    model: "claude-opus",
    effort: "high",
    permissionMode: "default",
    cwd: "/repo",
    transcriptPath: "/transcripts/claude-session.jsonl",
  },
};

const gitContext: GitContext = {
  available: true,
  root: "/repo",
  head: "0123456789012345678901234567890123456789",
  branch: "codex/phase-1-handoffs",
  status: " M src/parser.ts",
  diffStat: "src/parser.ts | 2 +-",
  changedPaths: ["src/parser.ts"],
  truncated: false,
  reason: null,
};

describe("renderHandoffPacket", () => {
  test("renders the exact inspectable delivery text", () => {
    const packet = renderHandoffPacket({
      id: "handoff-test",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      targetSession: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      completion,
      git: gitContext,
      requestedAction: "Verify the parser fix and report any regression.",
    });

    expect(packet).toContain('handoff_id: "handoff-test"');
    expect(packet).toContain('source_kind: "claude"');
    expect(packet).toContain('target_kind: "codex"');
    expect(packet).toContain('source_completed_at: "2023-11-14T22:13:20.000Z"');
    expect(packet).toContain("## Requested next action");
    expect(packet).toContain("Verify the parser fix and report any regression.");
    expect(packet).toContain("### Source result");
    expect(packet).toContain("The parser issue is isolated to `parseInput`.");
    expect(packet).toContain('Branch: "codex/phase-1-handoffs"');
    expect(packet.trimEnd().endsWith("Agent Bridge packet handoff-test")).toBe(true);
    expect(packet.endsWith("\n")).toBe(true);
  });

  test("rejects mismatched provenance and terminal control sequences", () => {
    expect(() => renderHandoffPacket({
      id: "handoff-test",
      from: "codex",
      to: "claude",
      targetKind: "claude",
      sourceSession: "claude-session",
      targetSession: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      completion,
      git: gitContext,
      requestedAction: "Continue",
    })).toThrow("completion source agent does not match");

    expect(() => renderHandoffPacket({
      id: "handoff-test",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      targetSession: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      completion,
      git: gitContext,
      requestedAction: "unsafe\0action",
    })).toThrow("forbidden control character");
  });

  test("omits optional enrichment before rejecting a valid maximum-sized core", () => {
    const packet = renderHandoffPacket({
      id: "handoff-budget",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      targetSession: "codex-session",
      createdAt: "2026-07-31T12:00:00.000Z",
      completion: {
        ...completion,
        prompt: "p".repeat(MAX_HANDOFF_PROMPT_BYTES),
        lastAssistantMessage: "r".repeat(MAX_HANDOFF_MESSAGE_BYTES),
        observed: {
          ...completion.observed,
          cwd: `/${"c".repeat(8 * 1024 - 2)}`,
        },
      },
      git: {
        ...gitContext,
        status: "s".repeat(64 * 1024),
        diffStat: "d".repeat(64 * 1024),
        changedPaths: Array.from(
          { length: 16 },
          (_, index) => `${index}-${"x".repeat(8 * 1024 - 4)}`,
        ),
        truncated: true,
      },
      requestedAction: "a".repeat(MAX_HANDOFF_ACTION_BYTES),
    });

    expect(Buffer.byteLength(packet, "utf8")).toBeLessThanOrEqual(
      MAX_HANDOFF_PACKET_BYTES,
    );
    expect(packet).toContain("Repository metadata omitted to fit packet size budget.");
    expect(packet).toContain("r".repeat(1_024));
    expect(packet.trimEnd()).toEndWith("Agent Bridge packet handoff-budget");
  });
});

describe("handoff artifact persistence", () => {
  test("creates a private immutable packet and atomically mutable receipt", () => {
    const repo = temporaryDirectory();
    const artifact = createHandoffArtifact({
      repo,
      id: "handoff-test",
      createdAt: "2026-07-31T12:00:00.000Z",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "Verify the parser fix.",
    });

    expect(handoffsDir(repo)).toBe(join(repo, ".bridge", "handoffs"));
    expect(readFileSync(artifact.packetPath, "utf8")).toBe(artifact.packet);
    expect(JSON.parse(readFileSync(artifact.receiptPath, "utf8"))).toEqual(artifact.receipt);
    expect(artifact.receipt.packetSha256).toBe(
      createHash("sha256").update(artifact.packet).digest("hex"),
    );
    expect(artifact.receipt.sourceKind).toBe("claude");
    expect(artifact.receipt.targetKind).toBe("codex");
    expect(artifact.receipt.attempt).toBe(0);
    expect(artifact.receipt.approvedAt).toBeNull();
    expect(artifact.receipt.deliveryStartedAt).toBeNull();
    expect(artifact.receipt.deliveredAt).toBeNull();
    expect(artifact.receipt.targetTurnEventId).toBeNull();
    expect(artifact.receipt.targetPromptId).toBeNull();
    expect(artifact.receipt.targetTurnId).toBeNull();
    expect(artifact.receipt.targetTurnObservedAt).toBeNull();
    expect(lstatSync(handoffsDir(repo)).mode & 0o777).toBe(0o700);
    expect(lstatSync(artifact.packetPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(artifact.receiptPath).mode & 0o777).toBe(0o600);

    const originalPacket = readFileSync(artifact.packetPath);
    const approved = updateHandoffReceipt(artifact.receiptPath, {
      status: "approved",
      updatedAt: "2026-07-31T12:00:30.000Z",
    }, artifact.receipt);
    expect(approved.approvedAt).toBe("2026-07-31T12:00:30.000Z");
    const delivering = updateHandoffReceipt(artifact.receiptPath, {
      status: "delivering",
      updatedAt: "2026-07-31T12:00:45.000Z",
    }, artifact.receipt);
    expect(delivering.attempt).toBe(1);
    expect(delivering.deliveryStartedAt).toBe("2026-07-31T12:00:45.000Z");
    expect(delivering.deliveredAt).toBeNull();
    const updated = updateHandoffReceipt(artifact.receiptPath, {
      status: "delivered",
      targetSession: "codex-session",
      detail: "echo verified",
      updatedAt: "2026-07-31T12:01:00.000Z",
    }, artifact.receipt);
    expect(updated.status).toBe("delivered");
    expect(updated.targetSession).toBe("codex-session");
    expect(updated.detail).toBe("echo verified");
    expect(updated.attempt).toBe(1);
    expect(updated.deliveredAt).toBe("2026-07-31T12:01:00.000Z");
    const observed = updateHandoffReceipt(artifact.receiptPath, {
      status: "delivered",
      targetTurnEventId: 42,
      targetTurnId: "codex-turn-42",
      targetTurnObservedAt: "2026-07-31T12:01:30.000Z",
      updatedAt: "2026-07-31T12:01:31.000Z",
    }, artifact.receipt);
    expect(observed.targetTurnEventId).toBe(42);
    expect(observed.targetPromptId).toBeNull();
    expect(observed.targetTurnId).toBe("codex-turn-42");
    expect(observed.targetTurnObservedAt).toBe("2026-07-31T12:01:30.000Z");
    expect(observed.deliveredAt).toBe("2026-07-31T12:01:00.000Z");
    expect(readFileSync(artifact.packetPath)).toEqual(originalPacket);
    expect(lstatSync(artifact.receiptPath).mode & 0o777).toBe(0o600);
  });

  test("refuses to overwrite an existing artifact id", () => {
    const repo = temporaryDirectory();
    const input = {
      repo,
      id: "same-id",
      createdAt: "2026-07-31T12:00:00.000Z",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "First packet",
    } as const;
    const first = createHandoffArtifact(input);
    const original = readFileSync(first.packetPath, "utf8");

    expect(() => createHandoffArtifact({ ...input, requestedAction: "Overwrite" }))
      .toThrow("already exists");
    expect(readFileSync(first.packetPath, "utf8")).toBe(original);
  });

  test("refuses a changed persisted packet before beginning delivery", () => {
    const repo = temporaryDirectory();
    const artifact = createHandoffArtifact({
      repo,
      id: "tamper-test",
      createdAt: "2026-07-31T12:00:00.000Z",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "Deliver only the approved bytes.",
    });
    writeFileSync(artifact.packetPath, `${artifact.packet}changed\n`);

    expect(() => verifyPersistedHandoffPacket(
      artifact.packetPath,
      artifact.receipt.packetSha256,
    )).toThrow("does not match its approved SHA-256");
    expect(() => updateHandoffReceipt(artifact.receiptPath, {
      status: "delivering",
    }, artifact.receipt)).toThrow("does not match its approved SHA-256");
    expect(JSON.parse(readFileSync(artifact.receiptPath, "utf8")).status)
      .toBe("prepared");
  });

  test("bounds persisted packet and receipt reads", () => {
    const repo = temporaryDirectory();
    const artifact = createHandoffArtifact({
      repo,
      id: "bounded-read-test",
      createdAt: "2026-07-31T12:00:00.000Z",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "Refuse oversized persisted state.",
    });

    writeFileSync(artifact.packetPath, "x".repeat(MAX_HANDOFF_PACKET_BYTES + 1));
    expect(() => verifyPersistedHandoffPacket(
      artifact.packetPath,
      artifact.receipt.packetSha256,
    )).toThrow("packet exceeds its size limit");

    writeFileSync(artifact.receiptPath, " ".repeat(64 * 1024 + 1));
    expect(() => updateHandoffReceipt(
      artifact.receiptPath,
      { status: "approved" },
      artifact.receipt,
    )).toThrow("receipt exceeds its size limit");
  });

  test("refuses a changed mutable receipt identity", () => {
    const repo = temporaryDirectory();
    const artifact = createHandoffArtifact({
      repo,
      id: "receipt-identity-tamper",
      createdAt: "2026-07-31T12:00:00.000Z",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "Trust only the prepared receipt identity.",
    });
    const alternate = join(repo, "alternate.md");
    writeFileSync(alternate, "alternate packet\n");
    const changed = JSON.parse(readFileSync(artifact.receiptPath, "utf8"));
    changed.packetPath = alternate;
    changed.packetSha256 = createHash("sha256")
      .update(readFileSync(alternate))
      .digest("hex");
    writeFileSync(artifact.receiptPath, `${JSON.stringify(changed, null, 2)}\n`);

    expect(() => updateHandoffReceipt(
      artifact.receiptPath,
      { status: "approved" },
      artifact.receipt,
    )).toThrow("immutable identity field packetPath changed");
  });

  for (const component of [".bridge", ".bridge/handoffs"] as const) {
    test(`refuses a symlinked ${component} directory without writing outside the repo`, () => {
      const repo = temporaryDirectory();
      const outside = temporaryDirectory();
      chmodSync(outside, 0o755);
      if (component === ".bridge/handoffs") {
        mkdirSync(join(repo, ".bridge"));
        symlinkSync(outside, join(repo, ".bridge", "handoffs"), "dir");
      } else {
        symlinkSync(outside, join(repo, ".bridge"), "dir");
      }

      expect(() => createHandoffArtifact({
        repo,
        id: "symlink-test",
        from: "claude",
        to: "codex",
        targetKind: "codex",
        sourceSession: "claude-session",
        completion,
        git: gitContext,
        requestedAction: "Do not escape the repository.",
      })).toThrow("must be a real directory");
      expect(readdirSync(outside)).toEqual([]);
      expect(lstatSync(outside).mode & 0o777).toBe(0o755);
    });
  }

  test("rejects traversal in caller-supplied artifact ids", () => {
    const repo = temporaryDirectory();
    expect(() => createHandoffArtifact({
      repo,
      id: "../escape",
      from: "claude",
      to: "codex",
      targetKind: "codex",
      sourceSession: "claude-session",
      completion,
      git: gitContext,
      requestedAction: "Continue",
    })).toThrow("safe filename component");
  });
});
