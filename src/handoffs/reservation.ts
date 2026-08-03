import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "../types.ts";
import { assertSafeText, HandoffValidationError } from "./context.ts";
import { handoffsDir } from "./packet.ts";

const MAX_RESERVATION_BYTES = 32 * 1024;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SAFE_PACKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface DeliveryReservation {
  version: 1;
  token: string;
  target: AgentId;
  targetSession: string;
  configFingerprint: string;
  packetId: string;
  receiptPath: string;
  baselineEventId: number;
  ownerPid: number;
  createdAt: string;
  path: string;
}

export type DeliveryReservationResult =
  | { acquired: true; reservation: DeliveryReservation }
  | { acquired: false; path: string; existing: DeliveryReservation | null };

function lockPath(repo: string, target: AgentId): string {
  if (!SAFE_AGENT_ID.test(target)) {
    throw new HandoffValidationError("delivery reservation target is not a safe AgentId");
  }
  const dir = handoffsDir(repo);
  for (const component of [dirname(dir), dir]) {
    let stat;
    try {
      stat = lstatSync(component);
    } catch {
      throw new HandoffValidationError(
        "handoff artifact directory must exist before delivery reservation",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HandoffValidationError(
        "handoff artifact directory components must be real directories",
      );
    }
  }
  return join(dir, `.delivery-${target}.lock`);
}

function safeScalar(value: unknown, label: string, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  try {
    return assertSafeText(value, label, maxBytes, { scalar: true });
  } catch {
    return null;
  }
}

function validIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errnoCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

/** Best-effort rollback for a lock this process created but did not publish. */
function removePartialReservation(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return;
  }
  fsyncDirectory(dirname(path));
}

function parseReservation(path: string): DeliveryReservation | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_RESERVATION_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DeliveryReservation>;
    const token = safeScalar(value.token, "reservation token", 128);
    const target = safeScalar(value.target, "reservation target", 256);
    const targetSession = safeScalar(
      value.targetSession,
      "reservation target session",
      512,
    );
    const configFingerprint = safeScalar(
      value.configFingerprint,
      "reservation config fingerprint",
      64,
    );
    const packetId = safeScalar(value.packetId, "reservation packet id", 256);
    const receiptPath = safeScalar(value.receiptPath, "reservation receipt path", 8 * 1024);
    const createdAt = safeScalar(value.createdAt, "reservation createdAt", 128);
    if (
      value.version !== 1 || token === null || !UUID.test(token) ||
      target === null || !SAFE_AGENT_ID.test(target) || targetSession === null ||
      configFingerprint === null || !SHA256_HEX.test(configFingerprint) ||
      packetId === null || !SAFE_PACKET_ID.test(packetId) || receiptPath === null ||
      !receiptPath.endsWith(".receipt.json") || typeof value.baselineEventId !== "number" ||
      !Number.isSafeInteger(value.baselineEventId) || value.baselineEventId < 0 ||
      typeof value.ownerPid !== "number" || !Number.isSafeInteger(value.ownerPid) ||
      value.ownerPid <= 0 || createdAt === null || !validIsoTimestamp(createdAt)
    ) return null;
    return {
      version: 1,
      token,
      target,
      targetSession,
      configFingerprint,
      packetId,
      receiptPath,
      baselineEventId: value.baselineEventId,
      ownerPid: value.ownerPid,
      createdAt,
      path,
    };
  } catch {
    return null;
  }
}

/** Atomically reserve one target. Contenders fail immediately; they never queue. */
export function tryAcquireDeliveryReservation(input: {
  repo: string;
  target: AgentId;
  targetSession: string;
  configFingerprint: string;
  packetId: string;
  receiptPath: string;
  baselineEventId: number;
}, opts: {
  /** Narrow publication seam used to exercise partial-lock rollback. */
  writeFile?: (fd: number, contents: string) => void;
} = {}): DeliveryReservationResult {
  const path = lockPath(input.repo, input.target);
  const targetSession = assertSafeText(
    input.targetSession,
    "delivery reservation target session",
    512,
    { scalar: true },
  );
  const configFingerprint = assertSafeText(
    input.configFingerprint,
    "delivery reservation config fingerprint",
    64,
    { scalar: true },
  );
  if (!SHA256_HEX.test(configFingerprint)) {
    throw new HandoffValidationError(
      "delivery reservation config fingerprint must be 64 lowercase hex characters",
    );
  }
  const packetId = assertSafeText(input.packetId, "delivery reservation packet id", 256, {
    scalar: true,
  });
  if (!SAFE_PACKET_ID.test(packetId)) {
    throw new HandoffValidationError("delivery reservation packet id is not safe");
  }
  const receiptPath = assertSafeText(
    input.receiptPath,
    "delivery reservation receipt path",
    8 * 1024,
    { scalar: true },
  );
  if (!receiptPath.endsWith(".receipt.json")) {
    throw new HandoffValidationError(
      "delivery reservation receipt path must end with .receipt.json",
    );
  }
  if (!Number.isSafeInteger(input.baselineEventId) || input.baselineEventId < 0) {
    throw new HandoffValidationError(
      "delivery reservation baseline event id must be a non-negative safe integer",
    );
  }
  const reservation: DeliveryReservation = {
    version: 1,
    token: randomUUID(),
    target: input.target,
    targetSession,
    configFingerprint,
    packetId,
    receiptPath,
    baselineEventId: input.baselineEventId,
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    path,
  };
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    const contents = `${JSON.stringify(reservation, null, 2)}\n`;
    (opts.writeFile ?? ((targetFd, value) => {
      writeFileSync(targetFd, value, "utf8");
    }))(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    fsyncDirectory(dirname(path));
    return { acquired: true, reservation };
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the publication failure below; rollback is path-based.
      }
    }
    if (errnoCode(error) === "EEXIST") {
      return { acquired: false, path, existing: parseReservation(path) };
    }
    if (created) {
      try {
        removePartialReservation(path);
      } catch {
        // Preserve the original publication failure. The unresolved path, if
        // cleanup itself failed, remains fail-closed for operator inspection.
      }
    }
    throw error;
  }
}

/** Delete only the exact reservation token this process inspected/acquired. */
export function releaseDeliveryReservation(reservation: DeliveryReservation): boolean {
  const current = parseReservation(reservation.path);
  if (current?.token !== reservation.token) return false;
  try {
    unlinkSync(reservation.path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  fsyncDirectory(dirname(reservation.path));
  return true;
}
