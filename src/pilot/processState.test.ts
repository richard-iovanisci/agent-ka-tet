import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { pilotFile, readPrivateJson, writePrivateJson } from "./config.ts";
import {
  acquireCoordinatorLock,
  acquireRecoveryLock,
  coordinatorPublished,
  processAlive,
  processBirth,
  processRecord,
  processVerifiedGone,
  recordProcess,
  releaseCoordinatorLock,
  releaseRecoveryLock,
  removeDeadCoordinatorLock,
  type ProcessLock,
  type ProcessRecord,
} from "./processState.ts";

const DEAD_PID = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]).pid;

function directory() {
  const root = mkdtempSync("/tmp/abps-");
  chmodSync(root, 0o700);
  return root;
}

describe("pilot process ownership", () => {
  test("null or missing child birth never proves liveness", () => {
    const born = processBirth(process.pid)!;
    for (const childBorn of [null, undefined, ""]) {
      const record = {
        pid: process.pid,
        born,
        role: "fixture",
        childPid: DEAD_PID,
        childBorn,
      } as unknown as ProcessRecord;
      expect(processAlive(record)).toBe(true);
      expect(processAlive(record, true)).toBe(false);
      expect(processVerifiedGone(record, true)).toBe(true);
    }
    const unknown = { pid: process.pid, born, role: "fixture", childPid: process.pid };
    expect(processVerifiedGone(unknown, true)).toBe(false);
    expect(processVerifiedGone({ ...unknown, exited: true })).toBe(false);
  });

  test("retains known child identity when recording its verified exit", () => {
    const root = directory();
    try {
      const born = processBirth(process.pid)!;
      writePrivateJson(pilotFile(root, "dummy.process.json"), {
        pid: process.pid,
        born,
        role: "dummy",
        childPid: DEAD_PID,
        childBorn: "previous-child-birth",
        exited: false,
      });
      recordProcess(root, "dummy", DEAD_PID, true);
      expect(processRecord(root, "dummy")).toMatchObject({ childBorn: "previous-child-birth", exited: true });
      expect(processVerifiedGone(processRecord(root, "dummy"), true)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("coordinator locks reject duplicates and cannot release another instance", () => {
    const root = directory();
    try {
      const lock = acquireCoordinatorLock(root);
      expect(readPrivateJson<ProcessLock>(pilotFile(root, "coordinator.lock"))).toEqual(lock);
      expect(() => acquireCoordinatorLock(root)).toThrow();
      expect(() => releaseCoordinatorLock(root, { ...lock, nonce: randomUUID() })).toThrow(
        /ownership changed/,
      );
      expect(existsSync(pilotFile(root, "coordinator.lock"))).toBe(true);
      releaseCoordinatorLock(root, lock);
      expect(existsSync(pilotFile(root, "coordinator.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery checks the actual lock owner rather than a stale process record", () => {
    const root = directory();
    try {
      const live = acquireCoordinatorLock(root);
      writePrivateJson(pilotFile(root, "coordinator.process.json"), {
        pid: DEAD_PID,
        born: "old-record",
        role: "coordinator",
        exited: true,
      });
      expect(() => removeDeadCoordinatorLock(root)).toThrow(/live or unknown/);
      expect(readPrivateJson<ProcessLock>(pilotFile(root, "coordinator.lock"))).toEqual(live);
      releaseCoordinatorLock(root, live);
      writePrivateJson(pilotFile(root, "coordinator.lock"), {
        pid: DEAD_PID,
        born: "old-owner",
        nonce: randomUUID(),
      });
      removeDeadCoordinatorLock(root);
      expect(existsSync(pilotFile(root, "coordinator.lock"))).toBe(false);
      writePrivateJson(pilotFile(root, "coordinator.lock"), { pid: 0, born: "unknown", nonce: randomUUID() });
      expect(() => removeDeadCoordinatorLock(root)).toThrow(/invalid/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery is serialized until matching lock, process, and endpoint are published", () => {
    const root = directory();
    try {
      const recovery = acquireRecoveryLock(root);
      expect(() => acquireRecoveryLock(root)).toThrow();
      const coordinator = acquireCoordinatorLock(root);
      recordProcess(root, "coordinator", undefined, false, coordinator.nonce);
      expect(coordinatorPublished(root)).toBe(false);
      writePrivateJson(pilotFile(root, "endpoint.json"), {
        pid: coordinator.pid,
        born: coordinator.born,
        instance: randomUUID(),
        port: 4770,
      });
      expect(coordinatorPublished(root)).toBe(false);
      writePrivateJson(pilotFile(root, "endpoint.json"), {
        pid: coordinator.pid,
        born: coordinator.born,
        instance: coordinator.nonce,
        port: 4770,
      });
      expect(coordinatorPublished(root)).toBe(true);
      expect(existsSync(pilotFile(root, "recovery.lock"))).toBe(true);
      releaseRecoveryLock(root, recovery);
      expect(existsSync(pilotFile(root, "recovery.lock"))).toBe(false);
      releaseCoordinatorLock(root, coordinator);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
