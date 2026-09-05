import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { readPrivateJson, pilotFile, writePrivateJson, type PilotEndpoint } from "./config.ts";

export interface ProcessRecord {
  pid: number;
  born: string;
  role: string;
  childPid?: number;
  childBorn?: string;
  exited?: boolean;
  instance?: string;
}

export interface ProcessLock {
  pid: number;
  born: string;
  nonce: string;
}

function inspectProcess(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString().trim();
    if (result.exitCode === 0) return output || undefined;
    if (result.exitCode === 1 && !output && !result.stderr.toString().trim()) return null;
  } catch {}
  return undefined;
}

export function processBirth(pid: number): string | null {
  return inspectProcess(pid) ?? null;
}

export function processRecord(root: string, role: string): ProcessRecord | null {
  const path = pilotFile(root, `${role}.process.json`);
  return existsSync(path) ? readPrivateJson<ProcessRecord>(path) : null;
}

export function processAlive(record: ProcessRecord | null, child = false): boolean {
  if (!record || record.exited) return false;
  const pid = child ? record.childPid : record.pid;
  const born = child ? record.childBorn : record.born;
  return pid !== undefined && typeof born === "string" && born.length > 0 && processBirth(pid) === born;
}

export function processVerifiedGone(record: ProcessRecord | null, child = false): boolean {
  if (!record) return true;
  const pid = child ? record.childPid : record.pid;
  const born = child ? record.childBorn : record.born;
  if (child && pid === undefined) return record.exited === true;
  if (pid === undefined) return false;
  const actual = inspectProcess(pid);
  if (actual === null) return true;
  return typeof born === "string" && born.length > 0 && actual !== undefined && actual !== born;
}

export function recordProcess(
  root: string,
  role: string,
  childPid?: number,
  exited = false,
  instance?: string,
): void {
  const born = processBirth(process.pid);
  if (!born) throw new Error("cannot identify pilot process");
  const previous = processRecord(root, role);
  const savedChildBorn =
    previous?.pid === process.pid && previous.born === born && previous.childPid === childPid
      ? previous.childBorn
      : undefined;
  const childBorn = childPid === undefined ? undefined : (processBirth(childPid) ?? savedChildBorn);
  writePrivateJson(pilotFile(root, `${role}.process.json`), {
    pid: process.pid,
    born,
    role,
    ...(childPid === undefined ? {} : { childPid, ...(childBorn ? { childBorn } : {}) }),
    exited,
    ...(instance === undefined ? {} : { instance }),
  });
}

function readLock(root: string, name: string): ProcessLock {
  const lock = readPrivateJson<ProcessLock>(pilotFile(root, name));
  if (
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0 ||
    typeof lock.born !== "string" ||
    !lock.born ||
    typeof lock.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/.test(lock.nonce)
  )
    throw new Error(`invalid ${name} ownership`);
  return lock;
}

function acquireLock(root: string, name: string): ProcessLock {
  const born = processBirth(process.pid);
  if (!born) throw new Error("cannot identify lock owner");
  const lock = { pid: process.pid, born, nonce: randomUUID() };
  writeFileSync(pilotFile(root, name), JSON.stringify(lock) + "\n", { flag: "wx", mode: 0o600 });
  return lock;
}

function releaseLock(root: string, name: string, expected: ProcessLock): void {
  const actual = readLock(root, name);
  if (actual.pid !== expected.pid || actual.born !== expected.born || actual.nonce !== expected.nonce) {
    throw new Error(`${name} ownership changed; refusing removal`);
  }
  unlinkSync(pilotFile(root, name));
}

export const acquireCoordinatorLock = (root: string): ProcessLock => acquireLock(root, "coordinator.lock");
export const releaseCoordinatorLock = (root: string, lock: ProcessLock): void =>
  releaseLock(root, "coordinator.lock", lock);
export const acquireRecoveryLock = (root: string): ProcessLock => acquireLock(root, "recovery.lock");
export const releaseRecoveryLock = (root: string, lock: ProcessLock): void =>
  releaseLock(root, "recovery.lock", lock);

export function removeDeadCoordinatorLock(root: string): void {
  if (!existsSync(pilotFile(root, "coordinator.lock"))) return;
  const lock = readLock(root, "coordinator.lock");
  const current = inspectProcess(lock.pid);
  if (current === undefined || current === lock.born)
    throw new Error("coordinator lock owner is live or unknown; refusing recovery");
  releaseCoordinatorLock(root, lock);
}

export function coordinatorPublished(root: string): boolean {
  const record = processRecord(root, "coordinator");
  if (
    !record ||
    !processAlive(record) ||
    !record.instance ||
    !existsSync(pilotFile(root, "coordinator.lock")) ||
    !existsSync(pilotFile(root, "endpoint.json"))
  )
    return false;
  const lock = readLock(root, "coordinator.lock");
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(root, "endpoint.json"));
  return (
    record.pid === lock.pid &&
    record.born === lock.born &&
    record.instance === lock.nonce &&
    endpoint.pid === lock.pid &&
    endpoint.born === lock.born &&
    endpoint.instance === lock.nonce &&
    Number.isSafeInteger(endpoint.port) &&
    endpoint.port > 0 &&
    endpoint.port <= 65_535
  );
}
