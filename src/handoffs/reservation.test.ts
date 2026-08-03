import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releaseDeliveryReservation,
  tryAcquireDeliveryReservation,
} from "./reservation.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "bridge-reservation-"));
  roots.push(repo);
  mkdirSync(join(repo, ".bridge", "handoffs"), { recursive: true, mode: 0o700 });
  return repo;
}

describe("target delivery reservations", () => {
  test("one target is create-only reserved and released by exact token", () => {
    const repo = fixture();
    const input = {
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: join(repo, ".bridge", "handoffs", "packet-1.receipt.json"),
      baselineEventId: 17,
    };
    const first = tryAcquireDeliveryReservation(input);
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("reservation was not acquired");

    const contender = tryAcquireDeliveryReservation({ ...input, packetId: "packet-2" });
    expect(contender.acquired).toBe(false);
    if (contender.acquired) throw new Error("contender unexpectedly acquired");
    expect(contender.existing?.token).toBe(first.reservation.token);

    expect(releaseDeliveryReservation({
      ...first.reservation,
      token: "another-token",
    })).toBe(false);
    expect(releaseDeliveryReservation(first.reservation)).toBe(true);
    expect(releaseDeliveryReservation(first.reservation)).toBe(false);
    expect(tryAcquireDeliveryReservation({ ...input, packetId: "packet-3" }).acquired)
      .toBe(true);
  });

  test("a malformed existing lock is preserved as unresolved", () => {
    const repo = fixture();
    const lock = join(repo, ".bridge", "handoffs", ".delivery-codex.lock");
    writeFileSync(lock, "{partial-json", { mode: 0o600 });

    const result = tryAcquireDeliveryReservation({
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: join(repo, ".bridge", "handoffs", "packet-1.receipt.json"),
      baselineEventId: 0,
    });

    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error("malformed lock was replaced");
    expect(result.path).toBe(lock);
    expect(result.existing).toBeNull();
  });

  test("oversized or terminal-unsafe locks remain opaque and unresolved", () => {
    const repo = fixture();
    const lock = join(repo, ".bridge", "handoffs", ".delivery-codex.lock");
    const input = {
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: join(repo, ".bridge", "handoffs", "packet-1.receipt.json"),
      baselineEventId: 0,
    } as const;

    writeFileSync(lock, " ".repeat(32 * 1024 + 1), { mode: 0o600 });
    const oversized = tryAcquireDeliveryReservation(input);
    expect(oversized.acquired).toBe(false);
    if (oversized.acquired) throw new Error("oversized lock was replaced");
    expect(oversized.existing).toBeNull();

    writeFileSync(lock, JSON.stringify({
      version: 1,
      token: "00000000-0000-4000-8000-000000000000",
      target: "codex",
      targetSession: "unsafe\u001b[31m",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: input.receiptPath,
      baselineEventId: 0,
      ownerPid: process.pid,
      createdAt: "2026-07-31T12:00:00.000Z",
    }));
    const unsafe = tryAcquireDeliveryReservation(input);
    expect(unsafe.acquired).toBe(false);
    if (unsafe.acquired) throw new Error("unsafe lock was replaced");
    expect(unsafe.existing).toBeNull();
  });

  test("a failed publication removes the partial lock before rethrowing", () => {
    const repo = fixture();
    const lock = join(repo, ".bridge", "handoffs", ".delivery-codex.lock");
    const input = {
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: join(repo, ".bridge", "handoffs", "packet-1.receipt.json"),
      baselineEventId: 0,
    };

    expect(() => tryAcquireDeliveryReservation(input, {
      writeFile(): never {
        throw new Error("simulated publication failure");
      },
    })).toThrow("simulated publication failure");
    expect(existsSync(lock)).toBe(false);
    expect(tryAcquireDeliveryReservation({ ...input, packetId: "packet-2" }).acquired)
      .toBe(true);
  });

  test("two operating-system processes produce exactly one reservation owner", async () => {
    const repo = fixture();
    const start = join(repo, "start-workers");
    const input = {
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-worker",
      receiptPath: join(repo, ".bridge", "handoffs", "packet-worker.receipt.json"),
      baselineEventId: 0,
    };
    const moduleUrl = new URL("./reservation.ts", import.meta.url).href;
    const worker = `
      import { existsSync } from "node:fs";
      import { tryAcquireDeliveryReservation } from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.argv[1]);
      const start = process.argv[2];
      while (!existsSync(start)) await Bun.sleep(5);
      const result = tryAcquireDeliveryReservation(input);
      console.log(JSON.stringify(result.acquired
        ? { acquired: true, token: result.reservation.token }
        : { acquired: false, token: result.existing?.token ?? null }));
    `;
    const children = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", worker, JSON.stringify(input), start],
      stdout: "pipe",
      stderr: "pipe",
    }));
    writeFileSync(start, "go\n");
    const results = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      return JSON.parse(stdout.trim()) as { acquired: boolean; token: string | null };
    }));

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toHaveLength(1);
    expect(results[0]?.token).not.toBeNull();
    expect(results[0]?.token).toBe(results[1]?.token);
  });

  test("refuses a missing artifact directory", () => {
    const repo = mkdtempSync(join(tmpdir(), "bridge-reservation-missing-"));
    roots.push(repo);
    expect(() => tryAcquireDeliveryReservation({
      repo,
      target: "codex",
      targetSession: "target-session",
      configFingerprint: "f".repeat(64),
      packetId: "packet-1",
      receiptPath: join(repo, "packet-1.receipt.json"),
      baselineEventId: 0,
    })).toThrow(/must exist/);
  });
});
