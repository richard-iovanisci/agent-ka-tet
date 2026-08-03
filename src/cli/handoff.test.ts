import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeSessionMarker,
  configFingerprint,
  defaultConfig,
  type BridgeConfig,
} from "../config.ts";
import { startDaemon, type DaemonHandle } from "../daemon/server.ts";
import type { NormalizedEvent } from "../types.ts";
import type { MuxAdapter } from "../mux/adapter.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { handoff } from "./handoff.ts";
import { launchCommand } from "./up.ts";
import { parseManagedProcessMarker } from "../attribution.ts";
import { tryAcquireDeliveryReservation } from "../handoffs/reservation.ts";

const SOCKET = `bridge-handoff-test-${process.pid}`;
const RECEIVER = fileURLToPath(
  new URL("../mux/fixtures/collapsedPasteReceiver.ts", import.meta.url),
);
const roots: string[] = [];
const daemons: DaemonHandle[] = [];
const sessions: Array<{ mux: TmuxAdapter; name: string }> = [];
let sequence = 0;

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const session of sessions.splice(0)) {
    if (await session.mux.hasSession(session.name)) {
      await session.mux.killSession(session.name);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  Bun.spawnSync(["tmux", "-L", SOCKET, "kill-server"]);
});

async function pollFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

function reservePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function event(
  cfg: BridgeConfig,
  agentId: "claude" | "codex",
  type: NormalizedEvent["type"],
  sessionId: string,
  body: Record<string, unknown>,
): NormalizedEvent {
  const agent = cfg.agents.find((candidate) => candidate.id === agentId)!;
  return {
    agent: agent.id,
    kind: agent.kind,
    type,
    sessionId,
    ts: Date.now(),
    payload: {
      nativeType: type === "turn.start"
        ? "UserPromptSubmit"
        : type === "turn.complete"
          ? "Stop"
          : type === "turn.error"
            ? "StopFailure"
          : "SessionStart",
      body: { cwd: agent.cwd ?? cfg.repo, session_id: sessionId, ...body },
    },
  };
}

interface Fixture {
  cfg: BridgeConfig;
  mux: TmuxAdapter;
  daemon: DaemonHandle;
  sourceId: "claude" | "codex";
  targetId: "claude" | "codex";
  targetOutput: string;
  targetAudit: string;
  targetPane: string;
  sourceSession: string;
  targetSession: string;
}

async function fixture(
  sourceId: "claude" | "codex",
  options: { sourceWorkspace?: boolean; targetSessionStarted?: boolean } = {},
): Promise<Fixture> {
  const targetId = sourceId === "claude" ? "codex" : "claude";
  const repo = mkdtempSync(join(tmpdir(), "bridge-handoff-"));
  roots.push(repo);
  const cfg = defaultConfig(repo);
  if (options.sourceWorkspace) {
    const sourceWorkspace = join(repo, "source-workspace");
    mkdirSync(sourceWorkspace);
    Bun.spawnSync(["git", "init", "-q", sourceWorkspace]);
    writeFileSync(join(sourceWorkspace, "source-only.txt"), "source context\n");
    cfg.agents.find((agent) => agent.id === sourceId)!.cwd = sourceWorkspace;
  }
  cfg.session = `bridge-handoff-${process.pid}-${sequence++}`;
  cfg.daemonPort = reservePort();
  const daemon = startDaemon(cfg, { dbPath: ":memory:" });
  daemons.push(daemon);
  const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });

  const firstPane = await mux.createSession(cfg.session, {
    cwd: cfg.agents.find((agent) => agent.id === "claude")?.cwd ?? repo,
    width: 220,
    height: 60,
  });
  sessions.push({ mux, name: cfg.session });
  const secondPane = await mux.splitPane(cfg.session, {
    cwd: cfg.agents.find((agent) => agent.id === "codex")?.cwd ?? repo,
  });
  await mux.selectLayout(cfg.session, "even-horizontal");
  await mux.setSessionMarker(cfg.session, bridgeSessionMarker(cfg));
  const panesById = { claude: firstPane, codex: secondPane };
  await mux.setPaneAgentId(panesById.claude, "claude");
  await mux.setPaneAgentId(panesById.codex, "codex");
  expect(await mux.waitForShellReady(firstPane)).toBe(true);
  expect(await mux.waitForShellReady(secondPane)).toBe(true);

  const targetOutput = join(repo, "target-paste.txt");
  const targetAudit = join(repo, "target-paste-audit.json");
  const receiverCommand = [
    "bun",
    shellWord(RECEIVER),
    targetId,
    "normal",
    shellWord(targetOutput),
    shellWord(targetAudit),
  ].join(" ");
  const targetAgent = cfg.agents.find((agent) => agent.id === targetId)!;
  const launched = await mux.sendText(panesById[targetId], launchCommand(
    { ...targetAgent, command: receiverCommand },
    cfg,
    `fixture-${sequence}`,
  ), {
    submit: true,
  });
  expect(launched.ok).toBe(true);
  expect(
    await pollFor(async () =>
      (await mux.capturePane(panesById[targetId])).includes("COLLAPSED_RECEIVER_READY")
    ),
  ).toBe(true);
  expect((await mux.listPanes(cfg.session)).find((pane) => pane.id === panesById[targetId])
    ?.managedProcess).not.toBeNull();

  const sourceSession = `${sourceId}-session-${sequence}`;
  const targetSession = `${targetId}-session-${sequence}`;
  daemon.ingest(event(cfg, sourceId, "session.start", sourceSession, {
    model: sourceId === "claude" ? "claude-test" : "gpt-test",
    effort: sourceId === "claude" ? { level: "high" } : undefined,
  }));
  daemon.ingest(event(cfg, sourceId, "turn.start", sourceSession, {
    prompt: `Produce the ${sourceId} source result`,
    prompt_id: sourceId === "claude" ? "prompt-1" : undefined,
    turn_id: sourceId === "codex" ? "turn-1" : undefined,
  }));
  daemon.ingest(event(cfg, sourceId, "turn.complete", sourceSession, {
    last_assistant_message: `${sourceId} completed result\n${"fixture payload ".repeat(100)}`,
    prompt_id: sourceId === "claude" ? "prompt-1" : undefined,
    turn_id: sourceId === "codex" ? "turn-1" : undefined,
  }));
  if (options.targetSessionStarted !== false) {
    daemon.ingest(event(cfg, targetId, "session.start", targetSession, {
      model: targetId === "claude" ? "claude-target" : "gpt-target",
    }));
  }

  return {
    cfg,
    mux,
    daemon,
    sourceId,
    targetId,
    targetOutput,
    targetAudit,
    targetPane: panesById[targetId],
    sourceSession,
    targetSession,
  };
}

function proxyMux(mux: MuxAdapter, overrides: Partial<MuxAdapter>): MuxAdapter {
  return new Proxy(mux, {
    get(target, property, receiver) {
      if (property in overrides) {
        return Reflect.get(overrides, property, receiver);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function onlyReceipt(repo: string): { path: string; value: Record<string, unknown> } {
  const dir = join(repo, ".bridge", "handoffs");
  const name = readdirSync(dir).find((candidate) => candidate.endsWith(".receipt.json"));
  if (name === undefined) throw new Error("no handoff receipt found");
  const path = join(dir, name);
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

function allReceipts(repo: string): Array<{ path: string; value: Record<string, unknown> }> {
  const dir = join(repo, ".bridge", "handoffs");
  return readdirSync(dir)
    .filter((candidate) => candidate.endsWith(".receipt.json"))
    .map((name) => {
      const path = join(dir, name);
      return { path, value: JSON.parse(readFileSync(path, "utf8")) };
    });
}

describe("approve-mode native-TUI handoffs", () => {
  for (const sourceId of ["claude", "codex"] as const) {
    test(`${sourceId} delivers its exact immutable packet to the other real tmux pane`, async () => {
      const f = await fixture(sourceId);
      const lines: string[] = [];
      const result = await handoff(
        f.cfg,
        {
          from: f.sourceId,
          to: f.targetId,
          task: `Review and continue the ${sourceId} result`,
        },
        {
          mux: f.mux,
          print: (line) => lines.push(line),
          approve: async (expected) => expected,
          reservationObservationMs: 0,
        },
      );

      if (result !== 0) throw new Error(lines.join("\n"));
      expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
      const receipt = onlyReceipt(f.cfg.repo);
      expect(receipt.value.status).toBe("delivered");
      const packetPath = receipt.value.packetPath;
      expect(typeof packetPath).toBe("string");
      const received = readFileSync(f.targetOutput);
      const expected = readFileSync(packetPath as string);
      if (!received.equals(expected)) {
        const firstDifference = received.findIndex((byte, index) => byte !== expected[index]);
        throw new Error(
          `delivered packet differs at byte ${firstDifference} ` +
            `(received ${received[firstDifference]}, expected ${expected[firstDifference]}); ` +
            `received ${received.length} bytes, expected ${expected.length}`,
        );
      }
      expect(lines.join("\n")).toContain(`delivered handoff`);
      expect((await f.mux.listPanes(f.cfg.session)).find((pane) => pane.active)?.id)
        .toBe(f.targetPane);
    }, 15_000);
  }

  test("approval is cancelled if the target starts working before the final gate", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Do not deliver across a race" },
      {
        mux: f.mux,
        print: () => {},
        reservationObservationMs: 0,
        approve: async (expected) => {
          f.daemon.ingest(event(
            f.cfg,
            "codex",
            "turn.start",
            f.targetSession,
            { prompt: "A human got here first", turn_id: "race-turn" },
          ));
          return expected;
        },
      },
    );

    expect(result).toBe(1);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("cancelled");
    expect(existsSync(f.targetOutput)).toBe(false);
  }, 15_000);

  test("the frozen packet still delivers after the source continues working", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Deliver the frozen result" },
      {
        mux: f.mux,
        print: () => {},
        reservationObservationMs: 0,
        approve: async (expected) => {
          f.daemon.ingest(event(f.cfg, "claude", "turn.start", f.sourceSession, {
            prompt: "A newer source turn",
            prompt_id: "prompt-2",
          }));
          f.daemon.ingest(event(f.cfg, "claude", "turn.complete", f.sourceSession, {
            last_assistant_message: "a newer result that was not approved",
            prompt_id: "prompt-2",
          }));
          return expected;
        },
      },
    );

    expect(result).toBe(0);
    expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
    const received = readFileSync(f.targetOutput, "utf8");
    expect(received).toContain("claude completed result");
    expect(received).not.toContain("a newer result that was not approved");
  }, 15_000);

  test("a target already working retains a cancelled packet and receives nothing", async () => {
    const f = await fixture("claude");
    f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
      prompt: "Already working",
      turn_id: "busy-turn",
    }));

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Retain this packet" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    const receipt = onlyReceipt(f.cfg.repo).value;
    expect(receipt.status).toBe("cancelled");
    expect(existsSync(receipt.packetPath as string)).toBe(true);
    expect(existsSync(f.targetOutput)).toBe(false);
  }, 15_000);

  test("a normally exited target cannot receive a packet in its fallback shell", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Never paste this into a shell" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => {
          Bun.spawnSync(["tmux", "-L", SOCKET, "send-keys", "-t", f.targetPane, "C-c"]);
          expect(await pollFor(async () =>
            (await f.mux.listPanes(f.cfg.session))
              .find((pane) => pane.id === f.targetPane)?.managedProcess === null
          )).toBe(true);
          return expected;
        },
      },
    );

    expect(result).toBe(1);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("cancelled");
    expect(existsSync(f.targetOutput)).toBe(false);
  }, 15_000);

  test("a target exiting after the final gate receives no Enter in its fallback shell", async () => {
    const f = await fixture("claude");
    const lines: string[] = [];
    let interrupted = false;
    const racingMux = proxyMux(f.mux, {
      sendText: async (paneId, text, options) => {
        if (!interrupted && paneId === f.targetPane && options?.verification?.mode === "native-tui") {
          interrupted = true;
          Bun.spawnSync(["tmux", "-L", SOCKET, "send-keys", "-t", f.targetPane, "C-c"]);
          expect(await pollFor(async () =>
            (await f.mux.listPanes(f.cfg.session))
              .find((pane) => pane.id === f.targetPane)?.managedProcess === null
          )).toBe(true);
        }
        return f.mux.sendText(paneId, text, options);
      },
    });

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Never submit this to the fallback shell" },
      {
        mux: racingMux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    expect(interrupted).toBe(true);
    expect(existsSync(f.targetOutput)).toBe(false);
    const receipt = onlyReceipt(f.cfg.repo).value;
    expect(receipt.status).toBe("failed");
    expect(String(receipt.detail)).toContain("outcome may be ambiguous");
    expect(lines.join("\n")).toContain("not running in its managed pane");
  }, 15_000);

  test("a SIGKILL-stale target marker fails the live-wrapper PID check", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Never trust a stale marker" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => {
          const pane = (await f.mux.listPanes(f.cfg.session))
            .find((candidate) => candidate.id === f.targetPane)!;
          const marker = parseManagedProcessMarker(pane.managedProcess)!;
          process.kill(marker.pid, "SIGKILL");
          expect(await pollFor(() => {
            try {
              process.kill(marker.pid, 0);
              return false;
            } catch {
              return true;
            }
          })).toBe(true);
          return expected;
        },
      },
    );

    expect(result).toBe(1);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("cancelled");
    expect(existsSync(f.targetOutput)).toBe(false);
  }, 15_000);

  test("packet modification during approval is detected before pane delivery", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Deliver only approved bytes" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => {
          const packet = readdirSync(join(f.cfg.repo, ".bridge", "handoffs"))
            .find((candidate) => candidate.endsWith(".md"))!;
          writeFileSync(join(f.cfg.repo, ".bridge", "handoffs", packet), "tampered\n");
          return expected;
        },
      },
    );

    expect(result).toBe(1);
    const receipt = onlyReceipt(f.cfg.repo).value;
    expect(receipt.status).toBe("cancelled");
    expect(String(receipt.detail)).toContain("content verification");
    expect(existsSync(f.targetOutput)).toBe(false);
  }, 15_000);

  test("two simultaneous approvals reserve the target so at most one submits", async () => {
    const f = await fixture("claude");
    let approvalCount = 0;
    let releaseApprovals!: () => void;
    const approvalsReady = new Promise<void>((resolve) => {
      releaseApprovals = resolve;
    });
    const approve = async (expected: string): Promise<string> => {
      approvalCount++;
      if (approvalCount === 2) releaseApprovals();
      await approvalsReady;
      return expected;
    };
    const options = {
      mux: f.mux,
      print: () => {},
      approve,
      reservationObservationMs: 0,
    };

    const results = await Promise.all([
      handoff(
        f.cfg,
        { from: "claude", to: "codex", task: "Concurrent packet A" },
        options,
      ),
      handoff(
        f.cfg,
        { from: "claude", to: "codex", task: "Concurrent packet B" },
        options,
      ),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
    const receipts = allReceipts(f.cfg.repo);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.value.status).sort())
      .toEqual(["cancelled", "delivered"]);
    const delivered = receipts.find((receipt) => receipt.value.status === "delivered")!;
    expect(readFileSync(f.targetOutput)).toEqual(
      readFileSync(delivered.value.packetPath as string),
    );
  }, 15_000);

  test("repository enrichment follows the configured source cwd", async () => {
    const f = await fixture("claude", { sourceWorkspace: true });
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Use source workspace context" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => expected,
        reservationObservationMs: 0,
      },
    );

    expect(result).toBe(0);
    const receipt = onlyReceipt(f.cfg.repo).value;
    const packet = readFileSync(receipt.packetPath as string, "utf8");
    expect(packet).toContain(
      `Root: ${JSON.stringify(realpathSync(join(f.cfg.repo, "source-workspace")))}`,
    );
    expect(packet).toContain('"source-only.txt"');
  }, 15_000);

  test("target reservations persist the provider turn token before release", async () => {
    for (const sourceId of ["claude", "codex"] as const) {
      const f = await fixture(sourceId);
      const providerToken = `${f.targetId}-delivered-turn`;
      const observeTarget = (async () => {
        expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
        const receipt = onlyReceipt(f.cfg.repo).value;
        const packet = readFileSync(receipt.packetPath as string, "utf8");
        f.daemon.ingest(event(f.cfg, f.targetId, "turn.start", f.targetSession, {
          prompt: packet,
          prompt_id: f.targetId === "claude" ? providerToken : undefined,
          turn_id: f.targetId === "codex" ? providerToken : undefined,
        }));
      })();
      const result = await handoff(
        f.cfg,
        { from: f.sourceId, to: f.targetId, task: "Observe target start" },
        {
          mux: f.mux,
          print: () => {},
          approve: async (expected) => expected,
          reservationObservationMs: 2_000,
        },
      );
      await observeTarget;

      expect(result).toBe(0);
      expect(
        readdirSync(join(f.cfg.repo, ".bridge", "handoffs"))
          .some((name) => name === `.delivery-${f.targetId}.lock`),
      ).toBe(false);
      const receipt = onlyReceipt(f.cfg.repo).value;
      expect(receipt.targetTurnEventId).toBeNumber();
      expect(receipt.targetPromptId).toBe(
        f.targetId === "claude" ? providerToken : null,
      );
      expect(receipt.targetTurnId).toBe(
        f.targetId === "codex" ? providerToken : null,
      );
      expect(receipt.targetTurnObservedAt).toBeString();
    }
  }, 15_000);

  test("unrelated or prompt-less target turns retain the packet reservation", async () => {
    const f = await fixture("claude");
    const lines: string[] = [];
    const observeTarget = (async () => {
      expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
      const receipt = onlyReceipt(f.cfg.repo).value;
      const footer = `Agent Bridge packet ${String(receipt.id)}`;
      const wrongNative = event(f.cfg, "codex", "turn.start", f.targetSession, {
        prompt: footer,
        turn_id: "wrong-native-turn",
      });
      wrongNative.payload.nativeType = "synthetic.turn.start";
      f.daemon.ingest(wrongNative);
      f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
        prompt: `${footer}-not-an-exact-footer`,
        turn_id: "footer-substring-turn",
      }));
      f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
        prompt: footer,
      }));
      f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
        prompt: "An unrelated human prompt",
        turn_id: "unrelated-turn",
      }));
      f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
        turn_id: "missing-prompt-turn",
      }));
    })();
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Retain until this exact packet starts" },
      {
        mux: f.mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
        reservationObservationMs: 250,
      },
    );
    await observeTarget;

    expect(result).toBe(0);
    expect(
      readdirSync(join(f.cfg.repo, ".bridge", "handoffs"))
        .some((name) => name === ".delivery-codex.lock"),
    ).toBe(true);
    const output = lines.join("\n");
    expect(output).toContain("no matching packet-bearing target turn.start");
    expect(output).toContain("managed same-session UserPromptSubmit");
    expect(output).toContain("no later background cleanup occurs");
    expect(output).toContain("evidence to inspect during that reconciliation");
    expect(output).toContain("explicitly reconciled");
  }, 15_000);

  test("a stale observed reservation remains unresolved and blocks a rerun", async () => {
    const f = await fixture("claude");
    const dir = join(f.cfg.repo, ".bridge", "handoffs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const oldReceipt = join(dir, "ambiguous-old.receipt.json");
    const seeded = tryAcquireDeliveryReservation({
      repo: f.cfg.repo,
      target: "codex",
      targetSession: f.targetSession,
      configFingerprint: configFingerprint(f.cfg),
      packetId: "ambiguous-old",
      receiptPath: oldReceipt,
      baselineEventId: 0,
    });
    if (!seeded.acquired) throw new Error("failed to seed unresolved reservation");
    writeFileSync(seeded.reservation.path, `${JSON.stringify({
      ...seeded.reservation,
      ownerPid: 2_147_483_647,
    }, null, 2)}\n`);
    f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
      prompt: "Agent Bridge packet ambiguous-old",
      turn_id: "old-delivered-turn",
    }));
    f.daemon.ingest(event(f.cfg, "codex", "turn.complete", f.targetSession, {
      turn_id: "old-delivered-turn",
      last_assistant_message: "old turn accepted",
    }));
    const lines: string[] = [];

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Do not replay across ambiguity" },
      {
        mux: f.mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    expect(existsSync(f.targetOutput)).toBe(false);
    expect(readFileSync(seeded.reservation.path, "utf8")).toContain("ambiguous-old");
    const output = lines.join("\n");
    expect(output).toContain("owned by packet ambiguous-old");
    expect(output).toContain(oldReceipt);
    expect(output).toContain("automatic takeover is disabled");
    expect(output).toContain("no background cleanup will occur");
    expect(output).toContain("remains until it is explicitly reconciled");
  }, 15_000);

  test("a malformed reservation gets a distinct fail-closed refusal", async () => {
    const f = await fixture("claude");
    const dir = join(f.cfg.repo, ".bridge", "handoffs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, ".delivery-codex.lock");
    writeFileSync(lock, "{partial-json", { mode: 0o600 });
    const lines: string[] = [];

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Never replace a malformed lock" },
      {
        mux: f.mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    expect(readFileSync(lock, "utf8")).toBe("{partial-json");
    expect(lines.join("\n")).toContain("malformed or unreadable unresolved delivery reservation");
  }, 15_000);

  for (const targetState of ["launching", "needs_you", "done", "error"] as const) {
    test(`a ${targetState} target is refused without terminal delivery`, async () => {
      const f = await fixture("claude", {
        targetSessionStarted: targetState !== "launching",
      });
      if (targetState === "needs_you") {
        f.daemon.ingest(event(f.cfg, "codex", "permission.request", f.targetSession, {
          tool_name: "Bash",
        }));
      } else if (targetState === "done") {
        f.daemon.ingest(event(f.cfg, "codex", "agent.done", f.targetSession, {}));
      } else if (targetState === "error") {
        f.daemon.ingest(event(f.cfg, "codex", "turn.start", f.targetSession, {
          prompt: "Enter a turn that will fail",
          turn_id: "target-error-turn",
        }));
        f.daemon.ingest(event(f.cfg, "codex", "turn.error", f.targetSession, {
          error: "simulated",
          turn_id: "target-error-turn",
        }));
      }
      const lines: string[] = [];

      const result = await handoff(
        f.cfg,
        { from: "claude", to: "codex", task: `Refuse ${targetState}` },
        {
          mux: f.mux,
          print: (line) => lines.push(line),
          approve: async (expected) => expected,
        },
      );

      expect(result).toBe(1);
      expect(existsSync(f.targetOutput)).toBe(false);
      expect(lines.join("\n")).toContain(
        targetState === "launching" ? "no observed native session" : `is ${targetState}, not idle`,
      );
    }, 15_000);
  }

  test("a target native-session change during approval is refused", async () => {
    const f = await fixture("claude");
    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Never cross target sessions" },
      {
        mux: f.mux,
        print: () => {},
        approve: async (expected) => {
          f.daemon.ingest(event(f.cfg, "codex", "session.start", "replacement-session", {
            model: "gpt-replacement",
          }));
          return expected;
        },
      },
    );

    expect(result).toBe(1);
    expect(existsSync(f.targetOutput)).toBe(false);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("cancelled");
  }, 15_000);

  test("a foreign tmux ownership marker refuses the handoff", async () => {
    const f = await fixture("claude");
    await f.mux.setSessionMarker(f.cfg.session, "foreign-config");
    const lines: string[] = [];

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Honor tmux ownership" },
      {
        mux: f.mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    expect(existsSync(f.targetOutput)).toBe(false);
    expect(lines.join("\n")).toContain("belongs to another or stale bridge configuration");
  }, 15_000);

  test("interactive approve mode refuses any tmux client context before focus", async () => {
    const f = await fixture("claude");
    const oldTmux = process.env.TMUX;
    const oldPane = process.env.TMUX_PANE;
    process.env.TMUX = "/tmp/tmux-test,1,0";
    process.env.TMUX_PANE = "%999";
    const lines: string[] = [];
    let focusCalls = 0;
    const mux = proxyMux(f.mux, {
      focusPane: async () => {
        focusCalls++;
      },
    });
    try {
      const result = await handoff(
        f.cfg,
        { from: "claude", to: "codex", task: "Run only from a third terminal" },
        { mux, print: (line) => lines.push(line) },
      );
      expect(result).toBe(1);
    } finally {
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
      if (oldPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = oldPane;
    }

    expect(focusCalls).toBe(0);
    expect(lines.join("\n")).toContain("must run from a separate terminal outside tmux");
  }, 15_000);

  for (const failure of ["ambiguous-observable", "verification-timeout"] as const) {
    test(`${failure} retains the reservation with actionable output`, async () => {
      const f = await fixture("claude");
      const lines: string[] = [];
      const mux = proxyMux(f.mux, {
        sendText: async () => ({
          ok: false,
          verified: false,
          retried: true,
          observable: null,
          failure,
        }),
      });

      const result = await handoff(
        f.cfg,
        { from: "claude", to: "codex", task: "Retain failed delivery" },
        {
          mux,
          print: (line) => lines.push(line),
          approve: async (expected) => expected,
        },
      );

      expect(result).toBe(1);
      const receipt = onlyReceipt(f.cfg.repo).value;
      expect(receipt.status).toBe("failed");
      expect(String(receipt.detail)).toContain(
        failure === "ambiguous-observable" ? "ambiguous observable" : "timed out",
      );
      expect(lines.join("\n")).toContain("delivery reservation retained for packet");
      expect(lines.join("\n")).toContain("explicitly reconciled");
    }, 15_000);
  }

  test("a delivery exception retains the reservation with actionable output", async () => {
    const f = await fixture("claude");
    const lines: string[] = [];
    const mux = proxyMux(f.mux, {
      sendText: async () => {
        throw new Error("simulated delivery exception");
      },
    });

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Retain ambiguous exception" },
      {
        mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
      },
    );

    expect(result).toBe(1);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("failed");
    expect(lines.join("\n")).toContain("outcome is ambiguous");
    expect(lines.join("\n")).toContain("delivery reservation retained for packet");
  }, 15_000);

  test("post-delivery focus failure remains a successful delivered handoff", async () => {
    const f = await fixture("claude");
    const lines: string[] = [];
    let focusCalls = 0;
    const mux = proxyMux(f.mux, {
      focusPane: async (session, paneId) => {
        focusCalls++;
        if (focusCalls === 2) throw new Error("simulated focus failure");
        await f.mux.focusPane(session, paneId);
      },
    });

    const result = await handoff(
      f.cfg,
      { from: "claude", to: "codex", task: "Delivery outranks focus cosmetics" },
      {
        mux,
        print: (line) => lines.push(line),
        approve: async (expected) => expected,
        reservationObservationMs: 0,
      },
    );

    expect(result).toBe(0);
    expect(await pollFor(() => existsSync(f.targetOutput))).toBe(true);
    expect(onlyReceipt(f.cfg.repo).value.status).toBe("delivered");
    expect(lines.join("\n")).toContain("was delivered, but focusing pane");
  }, 15_000);
});
