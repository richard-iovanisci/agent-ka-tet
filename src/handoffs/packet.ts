import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentKind } from "../types.ts";
import { assertSafeText, collectGitContext, HandoffValidationError } from "./context.ts";
import {
  HANDOFF_RECEIPT_STATUSES,
  MAX_HANDOFF_ACTION_BYTES,
  MAX_HANDOFF_MESSAGE_BYTES,
  MAX_HANDOFF_PACKET_BYTES,
  MAX_HANDOFF_PROMPT_BYTES,
  type CreateHandoffArtifactInput,
  type GitContext,
  type HandoffArtifact,
  type HandoffPacketInput,
  type HandoffReceipt,
  type HandoffReceiptIdentity,
  type HandoffReceiptStatus,
  type HandoffReceiptUpdate,
} from "./types.ts";

const MAX_ID_BYTES = 256;
const MAX_DETAIL_BYTES = 4 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const RECEIPT_STATUSES = new Set<string>(HANDOFF_RECEIPT_STATUSES);

export function handoffsDir(repo: string): string {
  const safeRepo = assertSafeText(repo, "repository path", 8 * 1024, { scalar: true });
  return resolve(safeRepo, ".bridge", "handoffs");
}

function safeScalar(value: string, label: string, maxBytes = MAX_ID_BYTES): string {
  return assertSafeText(value, label, maxBytes, { scalar: true });
}

function safeKind(value: AgentKind, label: string): AgentKind {
  if (value !== "claude" && value !== "codex") {
    throw new HandoffValidationError(`${label} is not an active adapter kind`);
  }
  return value;
}

function safeFileId(value: string): string {
  const id = safeScalar(value, "handoff id");
  if (!SAFE_FILE_ID.test(id) || id === "." || id === "..") {
    throw new HandoffValidationError("handoff id is not a safe filename component");
  }
  return id;
}

function isoTimestamp(value: string, label: string): string {
  const safe = safeScalar(value, label, 128);
  const parsed = new Date(safe);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new HandoffValidationError(`${label} is not a valid timestamp`);
  }
  return parsed.toISOString();
}

function eventTimestamp(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HandoffValidationError(`${label} is not a valid epoch-millisecond timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new HandoffValidationError(`${label} is not a valid epoch-millisecond timestamp`);
  }
  return parsed.toISOString();
}

function packetDigest(packet: string | Uint8Array): string {
  return createHash("sha256").update(packet).digest("hex");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function indented(value: string, empty: string): string {
  if (value.length === 0) return `    ${empty}`;
  return value.split("\n").map((line) => `    ${line}`).join("\n");
}

function truncatePacketText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n… [truncated to fit packet budget]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes) return "";
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, maxBytes - suffixBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}${suffix}`;
}

function safeGitContext(git: GitContext): GitContext {
  const paths = git.changedPaths.map((path, index) =>
    assertSafeText(path, `changed path ${index + 1}`, 8 * 1024)
  );
  return {
    ...git,
    root: git.root === null
      ? null
      : assertSafeText(git.root, "git root", 8 * 1024, { scalar: true }),
    head: git.head === null
      ? null
      : assertSafeText(git.head, "git head", 256, { scalar: true }),
    branch: git.branch === null
      ? null
      : assertSafeText(git.branch, "git branch", 8 * 1024, { scalar: true }),
    status: assertSafeText(git.status, "git status", 64 * 1024, { allowEmpty: true }),
    diffStat: assertSafeText(git.diffStat, "git diff stat", 64 * 1024, {
      allowEmpty: true,
    }),
    changedPaths: paths,
  };
}

/** Render the immutable Markdown packet. This string is the delivery payload. */
export function renderHandoffPacket(input: HandoffPacketInput): string {
  const id = safeFileId(input.id);
  const from = safeScalar(input.from, "source agent");
  const to = safeScalar(input.to, "target agent");
  const sourceKind = safeKind(input.completion.sourceKind, "source kind");
  const targetKind = safeKind(input.targetKind, "target kind");
  const sourceSession = safeScalar(input.sourceSession, "source session", 512);
  const targetSession = input.targetSession === null
    ? null
    : safeScalar(input.targetSession, "target session", 512);
  const createdAt = isoTimestamp(input.createdAt, "createdAt");
  const sourceCompletedAt = eventTimestamp(
    input.completion.completedAt,
    "source completion timestamp",
  );
  if (
    !Number.isSafeInteger(input.completion.sourceEventId) ||
    input.completion.sourceEventId < 1
  ) {
    throw new HandoffValidationError("source event id must be a positive safe integer");
  }
  if (input.completion.sourceAgent !== from) {
    throw new HandoffValidationError("completion source agent does not match packet source");
  }
  if (input.completion.sourceSession !== sourceSession) {
    throw new HandoffValidationError("completion source session does not match packet source");
  }
  const prompt = input.completion.prompt === null
    ? null
    : assertSafeText(
      input.completion.prompt,
      "source prompt",
      MAX_HANDOFF_PROMPT_BYTES,
    );
  const result = assertSafeText(
    input.completion.lastAssistantMessage,
    "source result",
    MAX_HANDOFF_MESSAGE_BYTES,
  );
  const requestedAction = assertSafeText(
    input.requestedAction,
    "requested action",
    MAX_HANDOFF_ACTION_BYTES,
  );
  const git = safeGitContext(input.git);
  const observed = input.completion.observed;
  const metadata = [
    `- Model: ${observed.model === null ? "unknown" : yamlString(safeScalar(observed.model, "observed model", 512))}`,
    `- Effort: ${observed.effort === null ? "unknown" : yamlString(safeScalar(observed.effort, "observed effort", 512))}`,
    `- Permission mode: ${observed.permissionMode === null ? "unknown" : yamlString(safeScalar(observed.permissionMode, "observed permission mode", 512))}`,
    `- Working directory: ${observed.cwd === null ? "unknown" : yamlString(assertSafeText(observed.cwd, "observed cwd", 8 * 1024, { scalar: true }))}`,
  ].join("\n");

  const repository = git.available
    ? [
      `- Root: ${yamlString(git.root ?? "unknown")}`,
      `- Branch: ${git.branch === null ? "detached or unborn" : yamlString(git.branch)}`,
      `- HEAD: ${git.head === null ? "unborn" : yamlString(git.head)}`,
      `- Context truncated: ${git.truncated ? "yes" : "no"}`,
      "",
      "### Changed paths",
      git.changedPaths.length === 0
        ? "(none)"
        : git.changedPaths.map((path) => `- ${JSON.stringify(path)}`).join("\n"),
      "",
      "### Status",
      indented(git.status, "clean"),
      "",
      "### Diff statistics",
      indented(git.diffStat, "no tracked diff"),
    ].join("\n")
    : `Repository metadata unavailable (${git.reason ?? "unknown reason"}).`;

  const compactMetadata = [
    "- Model: unknown (omitted to fit packet budget)",
    "- Effort: unknown (omitted to fit packet budget)",
    "- Permission mode: unknown (omitted to fit packet budget)",
    "- Working directory: unknown (omitted to fit packet budget)",
  ].join("\n");
  const omittedRepository = "Repository metadata omitted to fit packet size budget.";
  const missingPrompt = "(not available in retained hook history)";
  const omittedPrompt = "(source prompt omitted to fit packet size budget)";

  const assemble = (
    packetPrompt: string,
    packetMetadata: string,
    packetRepository: string,
  ): string => [
    "---",
    "version: 1",
    `handoff_id: ${yamlString(id)}`,
    `from: ${yamlString(from)}`,
    `source_kind: ${yamlString(sourceKind)}`,
    `to: ${yamlString(to)}`,
    `target_kind: ${yamlString(targetKind)}`,
    `source_session: ${yamlString(sourceSession)}`,
    `target_session: ${targetSession === null ? "null" : yamlString(targetSession)}`,
    `source_event_id: ${input.completion.sourceEventId}`,
    `source_completed_at: ${yamlString(sourceCompletedAt)}`,
    `created_at: ${yamlString(createdAt)}`,
    "---",
    "",
    "# Agent Bridge handoff",
    "",
    "## Requested next action",
    "",
    requestedAction,
    "",
    "## Source turn",
    "",
    `- Adapter: ${sourceKind}`,
    `- Native event: ${yamlString(safeScalar(input.completion.nativeType, "native event", 256))}`,
    `- Prompt ID: ${input.completion.promptId === null ? "unknown" : yamlString(safeScalar(input.completion.promptId, "prompt id", 512))}`,
    `- Turn ID: ${input.completion.turnId === null ? "unknown" : yamlString(safeScalar(input.completion.turnId, "turn id", 512))}`,
    "",
    "### Prompt",
    "",
    packetPrompt,
    "",
    "### Source result",
    "",
    result,
    "",
    "## Last-observed native metadata",
    "",
    packetMetadata,
    "",
    "## Repository context",
    "",
    packetRepository,
    "",
    `Agent Bridge packet ${id}`,
    "",
  ].join("\n");

  const fullPrompt = prompt ?? missingPrompt;
  let packet = assemble(fullPrompt, metadata, repository);
  if (Buffer.byteLength(packet, "utf8") <= MAX_HANDOFF_PACKET_BYTES) {
    return assertSafeText(packet, "handoff packet", MAX_HANDOFF_PACKET_BYTES);
  }

  // Repository and observed metadata are enrichment. Omit them before ever
  // rejecting a packet whose required completion result and action are valid.
  packet = assemble(fullPrompt, metadata, omittedRepository);
  if (Buffer.byteLength(packet, "utf8") <= MAX_HANDOFF_PACKET_BYTES) {
    return assertSafeText(packet, "handoff packet", MAX_HANDOFF_PACKET_BYTES);
  }
  packet = assemble(fullPrompt, compactMetadata, omittedRepository);
  if (Buffer.byteLength(packet, "utf8") <= MAX_HANDOFF_PACKET_BYTES) {
    return assertSafeText(packet, "handoff packet", MAX_HANDOFF_PACKET_BYTES);
  }

  // The source prompt is useful but not part of the required frozen Stop
  // identity. Allocate it only the bytes left after the immutable core.
  const minimal = assemble(omittedPrompt, compactMetadata, omittedRepository);
  const availablePromptBytes = Math.max(
    0,
    MAX_HANDOFF_PACKET_BYTES - Buffer.byteLength(minimal, "utf8") +
      Buffer.byteLength(omittedPrompt, "utf8"),
  );
  const boundedPrompt = prompt === null
    ? missingPrompt
    : truncatePacketText(prompt, availablePromptBytes) || omittedPrompt;
  packet = assemble(boundedPrompt, compactMetadata, omittedRepository);
  return assertSafeText(packet, "handoff packet", MAX_HANDOFF_PACKET_BYTES);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function statIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function ensurePrivateDirectoryComponent(path: string, label: string): void {
  let stat = statIfPresent(path);
  if (stat === null) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(dirname(path));
    } catch (error) {
      // A concurrent creator is acceptable only if it produced the exact
      // regular directory shape checked below.
      if (
        !(
          typeof error === "object" && error !== null &&
          "code" in error && (error as { code?: unknown }).code === "EEXIST"
        )
      ) {
        throw error;
      }
    }
    stat = statIfPresent(path);
  }
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new HandoffValidationError(
      `${label} must be a real directory, not a symlink or another file type`,
    );
  }
  chmodSync(path, 0o700);
  fsyncDirectory(path);
}

function ensurePrivateHandoffsDirectory(repo: string): string {
  const root = resolve(assertSafeText(repo, "repository path", 8 * 1024, {
    scalar: true,
  }));
  const bridge = join(root, ".bridge");
  const handoffs = join(bridge, "handoffs");
  ensurePrivateDirectoryComponent(bridge, ".bridge");
  ensurePrivateDirectoryComponent(handoffs, ".bridge/handoffs");
  return handoffs;
}

function writeImmutableAtomic(path: string, value: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Hard-link publication is atomic and refuses to replace an existing packet.
    linkSync(temp, path);
    unlinkSync(temp);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function writeMutableAtomic(path: string, value: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function receiptJson(receipt: HandoffReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function generatedId(createdAt: string): string {
  const stamp = createdAt.replaceAll(/[-:.]/gu, "");
  return `handoff-${stamp}-${randomUUID()}`;
}

/** Create one immutable packet and its independently mutable delivery receipt. */
export function createHandoffArtifact(input: CreateHandoffArtifactInput): HandoffArtifact {
  const createdAt = isoTimestamp(input.createdAt ?? new Date().toISOString(), "createdAt");
  const id = safeFileId(input.id ?? generatedId(createdAt));
  const dir = ensurePrivateHandoffsDirectory(input.repo);
  const packetPath = join(dir, `${id}.md`);
  const receiptPath = join(dir, `${id}.receipt.json`);
  if (existsSync(packetPath) || existsSync(receiptPath)) {
    throw new HandoffValidationError(`handoff artifact ${id} already exists`);
  }
  const targetSession = input.targetSession ?? null;
  const packet = renderHandoffPacket({
    id,
    from: input.from,
    to: input.to,
    targetKind: input.targetKind,
    sourceSession: input.sourceSession,
    targetSession,
    createdAt,
    completion: input.completion,
    git: input.git ?? collectGitContext(input.repo),
    requestedAction: input.requestedAction,
  });
  const packetSha256 = packetDigest(packet);
  const receipt: HandoffReceipt = {
    version: 1,
    id,
    packetPath,
    packetSha256,
    from: safeScalar(input.from, "source agent"),
    to: safeScalar(input.to, "target agent"),
    sourceKind: safeKind(input.completion.sourceKind, "source kind"),
    targetKind: safeKind(input.targetKind, "target kind"),
    sourceSession: safeScalar(input.sourceSession, "source session", 512),
    targetSession: targetSession === null
      ? null
      : safeScalar(targetSession, "target session", 512),
    status: "prepared",
    detail: null,
    attempt: 0,
    createdAt,
    approvedAt: null,
    deliveryStartedAt: null,
    deliveredAt: null,
    targetTurnEventId: null,
    targetPromptId: null,
    targetTurnId: null,
    targetTurnObservedAt: null,
    updatedAt: createdAt,
  };

  writeImmutableAtomic(packetPath, packet);
  try {
    // Publish the initial receipt create-only; later state transitions use
    // atomic replacement through updateHandoffReceipt.
    writeImmutableAtomic(receiptPath, receiptJson(receipt));
  } catch (error) {
    unlinkSync(packetPath);
    fsyncDirectory(dirname(packetPath));
    throw error;
  }
  return { id, packetPath, receiptPath, packet, receipt };
}

function isReceiptStatus(value: unknown): value is HandoffReceiptStatus {
  return typeof value === "string" && RECEIPT_STATUSES.has(value);
}

function isReceiptKind(value: unknown): value is AgentKind {
  return value === "claude" || value === "codex";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readReceipt(path: string): HandoffReceipt {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HandoffValidationError("handoff receipt must be a regular file");
  }
  if (stat.size > MAX_RECEIPT_BYTES) {
    throw new HandoffValidationError("handoff receipt exceeds its size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HandoffValidationError("handoff receipt is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandoffValidationError("handoff receipt must be a JSON object");
  }
  const value = parsed as Partial<HandoffReceipt>;
  const targetTurnEventId = value.targetTurnEventId ?? null;
  const targetPromptId = value.targetPromptId ?? null;
  const targetTurnId = value.targetTurnId ?? null;
  const targetTurnObservedAt = value.targetTurnObservedAt ?? null;
  if (
    value.version !== 1 || typeof value.id !== "string" ||
    typeof value.packetPath !== "string" || typeof value.from !== "string" ||
    typeof value.packetSha256 !== "string" || !SHA256_HEX.test(value.packetSha256) ||
    typeof value.to !== "string" || !isReceiptKind(value.sourceKind) ||
    !isReceiptKind(value.targetKind) || typeof value.sourceSession !== "string" ||
    (value.targetSession !== null && typeof value.targetSession !== "string") ||
    !isReceiptStatus(value.status) ||
    (value.detail !== null && typeof value.detail !== "string") ||
    typeof value.attempt !== "number" || !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0 || typeof value.createdAt !== "string" ||
    !isNullableString(value.approvedAt) ||
    !isNullableString(value.deliveryStartedAt) ||
    !isNullableString(value.deliveredAt) ||
    (targetTurnEventId !== null &&
      (!Number.isSafeInteger(targetTurnEventId) || targetTurnEventId < 1)) ||
    !isNullableString(targetPromptId) || !isNullableString(targetTurnId) ||
    !isNullableString(targetTurnObservedAt) || typeof value.updatedAt !== "string"
  ) {
    throw new HandoffValidationError("handoff receipt has an invalid shape");
  }
  return {
    ...value,
    targetTurnEventId,
    targetPromptId,
    targetTurnId,
    targetTurnObservedAt,
  } as HandoffReceipt;
}

function assertReceiptIdentity(
  current: HandoffReceipt,
  expected: HandoffReceiptIdentity,
): void {
  for (const field of [
    "version",
    "id",
    "packetPath",
    "packetSha256",
    "from",
    "to",
    "sourceKind",
    "targetKind",
    "sourceSession",
    "createdAt",
  ] as const) {
    if (current[field] !== expected[field]) {
      throw new HandoffValidationError(
        `handoff receipt immutable identity field ${field} changed`,
      );
    }
  }
}

/** Refuse delivery when the persisted packet no longer matches its receipt. */
export function verifyPersistedHandoffPacket(
  packetPath: string,
  expectedSha256: string,
): void {
  const path = resolve(assertSafeText(packetPath, "packet path", 8 * 1024, {
    scalar: true,
  }));
  const digest = safeScalar(expectedSha256, "packet SHA-256", 64);
  if (!SHA256_HEX.test(digest)) {
    throw new HandoffValidationError("packet SHA-256 must be 64 lowercase hex characters");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HandoffValidationError("handoff packet must be a regular file");
  }
  if (stat.size > MAX_HANDOFF_PACKET_BYTES) {
    throw new HandoffValidationError("handoff packet exceeds its size limit");
  }
  const actual = packetDigest(readFileSync(path));
  if (actual !== digest) {
    throw new HandoffValidationError(
      "persisted handoff packet content does not match its approved SHA-256",
    );
  }
}

/** Atomically update delivery state while preserving the packet and receipt identity. */
export function updateHandoffReceipt(
  receiptPath: string,
  update: HandoffReceiptUpdate,
  expectedIdentity: HandoffReceiptIdentity,
): HandoffReceipt {
  const path = resolve(assertSafeText(receiptPath, "receipt path", 8 * 1024, { scalar: true }));
  if (!path.endsWith(".receipt.json")) {
    throw new HandoffValidationError("receipt path must end with .receipt.json");
  }
  if (!isReceiptStatus(update.status)) {
    throw new HandoffValidationError(`unknown handoff receipt status ${String(update.status)}`);
  }
  const current = readReceipt(path);
  assertReceiptIdentity(current, expectedIdentity);
  const targetSession = update.targetSession === undefined
    ? current.targetSession
    : update.targetSession === null
      ? null
      : safeScalar(update.targetSession, "target session", 512);
  const detail = update.detail === undefined
    ? current.detail
    : update.detail === null
      ? null
      : assertSafeText(update.detail, "receipt detail", MAX_DETAIL_BYTES);
  const targetTurnEventId = update.targetTurnEventId === undefined
    ? current.targetTurnEventId
    : update.targetTurnEventId;
  if (
    targetTurnEventId !== null &&
    (!Number.isSafeInteger(targetTurnEventId) || targetTurnEventId < 1)
  ) {
    throw new HandoffValidationError("target turn event id must be a positive safe integer");
  }
  const targetPromptId = update.targetPromptId === undefined
    ? current.targetPromptId
    : update.targetPromptId === null
      ? null
      : safeScalar(update.targetPromptId, "target prompt id", 512);
  const targetTurnId = update.targetTurnId === undefined
    ? current.targetTurnId
    : update.targetTurnId === null
      ? null
      : safeScalar(update.targetTurnId, "target turn id", 512);
  const targetTurnObservedAt = update.targetTurnObservedAt === undefined
    ? current.targetTurnObservedAt
    : update.targetTurnObservedAt === null
      ? null
      : isoTimestamp(update.targetTurnObservedAt, "target turn observedAt");
  const updatedAt = isoTimestamp(update.updatedAt ?? new Date().toISOString(), "updatedAt");
  if (update.status === "delivering") {
    verifyPersistedHandoffPacket(current.packetPath, current.packetSha256);
  }
  const next: HandoffReceipt = {
    ...current,
    targetSession,
    status: update.status,
    detail,
    targetTurnEventId,
    targetPromptId,
    targetTurnId,
    targetTurnObservedAt,
    attempt: update.status === "delivering" ? current.attempt + 1 : current.attempt,
    approvedAt: update.status === "approved" ? updatedAt : current.approvedAt,
    deliveryStartedAt:
      update.status === "delivering" ? updatedAt : current.deliveryStartedAt,
    deliveredAt: update.status === "delivering"
      ? null
      : update.status === "delivered"
        ? current.deliveredAt ?? updatedAt
        : current.deliveredAt,
    updatedAt,
  };
  writeMutableAtomic(path, receiptJson(next));
  return next;
}
