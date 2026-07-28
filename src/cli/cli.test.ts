import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeSessionMarker,
  configFingerprint,
  loadConfig,
  defaultConfig,
  CONFIG_FILENAME,
} from "../config.ts";
import type { AgentStatus, StatusResponse } from "../types.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { daemonPidFile } from "../paths.ts";
import { up, launchCommand, daemonHealthy } from "./up.ts";
import { down } from "./down.ts";
import { attach } from "./attach.ts";
import { formatAge, renderBoard, top } from "./top.ts";

const SOCKET = `bridge-test-cli-${process.pid}`;
const SESSION = `bridge-cli-${process.pid}`;
const PORT = 4800 + (process.pid % 150);
const LEGACY_ACCEPT_PORT = 5100 + (process.pid % 100);
const LEGACY_PREFIX_PORT = 5300 + (process.pid % 100);
const LEGACY_DAEMON_FIXTURE = fileURLToPath(
  new URL("./fixtures/legacy/daemon/index.ts", import.meta.url),
);

afterAll(() => {
  Bun.spawnSync(["tmux", "-L", SOCKET, "kill-server"]);
});

/** Poll an async predicate every 50ms until true or timeout. */
async function pollFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

async function createLegacySession(
  mux: TmuxAdapter,
  session: string,
  cwd: string,
): Promise<void> {
  const panes = [await mux.createSession(session, { cwd })];
  for (let i = 1; i < 4; i++) panes.push(await mux.splitPane(session, { cwd }));
  for (const [index, title] of ["claude", "codex", "agy", "opencode"].entries()) {
    await mux.setPaneTitle(panes[index]!, title);
  }
}

async function startLegacyDaemon(
  port: number,
  pidFile: string,
  configDirArg: string,
) {
  const child = Bun.spawn([
    "bun",
    LEGACY_DAEMON_FIXTURE,
    "--port",
    String(port),
    "--pid-file",
    pidFile,
    "--dir",
    configDirArg,
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const ready = await pollFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(200),
      })).ok;
    } catch {
      return false;
    }
  });
  if (!ready) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    throw new Error(`legacy daemon fixture failed to bind port ${port}`);
  }
  return child;
}

async function stopFixture(child: Awaited<ReturnType<typeof startLegacyDaemon>>): Promise<void> {
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // already stopped by bridge down
  }
  await Promise.race([child.exited, Bun.sleep(3000)]);
}

function agentStatus(partial: Partial<AgentStatus> & Pick<AgentStatus, "agent">): AgentStatus {
  return {
    kind: "claude",
    enabled: true,
    state: "idle",
    sessionId: null,
    lastEvent: null,
    activeAttention: null,
    pendingPermission: null,
    ...partial,
  };
}

function fixtureStatus(now: number): StatusResponse {
  return {
    daemon: {
      startedAt: now - 60_000,
      port: 4770,
      pid: 1234,
      configDir: "/fixture",
      sourceRoot: "/bridge",
      sourceFingerprint: "fixture-source",
      configFingerprint: "fixture",
    },
    agents: [
      agentStatus({
        agent: "claude-main",
        kind: "claude",
        state: "working",
        sessionId: "abcd1234efgh",
        lastEvent: { type: "turn.start", nativeType: "UserPromptSubmit", ts: now - 3_000 },
      }),
      agentStatus({
        agent: "codex",
        kind: "codex",
        state: "needs_you",
        pendingPermission: "shell",
        lastEvent: { type: "permission.request", nativeType: "PermissionRequest", ts: now - 12_000 },
        activeAttention: { type: "permission.request", nativeType: "PermissionRequest", ts: now - 12_000 },
      }),
    ],
  };
}

describe("formatAge", () => {
  test("seconds / minutes / hours", () => {
    expect(formatAge(3_000)).toBe("3s");
    expect(formatAge(90_000)).toBe("1m");
    expect(formatAge(3_720_000)).toBe("1h2m");
    expect(formatAge(-5)).toBe("0s");
  });
});

describe("renderBoard", () => {
  test("shows the configured roster with state, age, badge, and kind", () => {
    const now = Date.now();
    const board = renderBoard(fixtureStatus(now), now);
    expect(board).toContain("claude-main");
    expect(board).toContain("(claude)");
    expect(board).toContain("working");
    expect(board).toContain("UserPromptSubmit");
    expect(board).toContain("3s ago");
    expect(board).toContain("sess abcd1234");
    expect(board).toContain("NEEDS YOU");
    expect(board).toContain("⚠ shell");
    expect(board).toContain("127.0.0.1:4770");
  });

  test("explains Codex's unobserved launching state without inventing an event", () => {
    const now = Date.now();
    const status = fixtureStatus(now);
    status.agents = [
      agentStatus({
        agent: "claude",
        kind: "claude",
        state: "launching",
      }),
      agentStatus({
        agent: "codex",
        kind: "codex",
        state: "launching",
      }),
    ];

    const board = renderBoard(status, now);
    const lines = board.split("\n");
    expect(lines.find((line) => line.includes("claude"))).toContain(
      "no events yet",
    );
    expect(lines.find((line) => line.includes("codex"))).toContain(
      "awaiting first observed turn",
    );
  });

  test("keeps the unresolved attention source visible when a later advisory event arrives", () => {
    const now = Date.now();
    const status = fixtureStatus(now);
    status.agents = [
      agentStatus({
        agent: "claude",
        kind: "claude",
        state: "needs_you",
        sessionId: "s1",
        pendingPermission: "Bash",
        activeAttention: {
          type: "permission.request",
          nativeType: "PermissionRequest",
          ts: now - 12_000,
        },
        lastEvent: {
          type: "permission.request",
          nativeType: "Notification:permission_prompt",
          ts: now - 6_000,
        },
      }),
    ];

    const line = renderBoard(status, now)
      .split("\n")
      .find((candidate) => candidate.includes("claude"));
    expect(line).toContain("PermissionRequest");
    expect(line).toContain("12s ago");
    expect(line).toContain("⚠ Bash");
    expect(line).not.toContain("Notification:permission_prompt");
  });
});

describe("launchCommand", () => {
  test("returns the configured native-TUI command", () => {
    const cfg = defaultConfig("/x");
    expect(launchCommand(cfg.agents[0]!)).toBe("claude");
    expect(launchCommand({ ...cfg.agents[1]!, command: "codex --profile pair" })).toBe(
      "codex --profile pair",
    );
  });
});

describe("bridge ownership guards", () => {
  test("existing-session-only recovery never creates a missing session", async () => {
    const cfg = defaultConfig(mkdtempSync(join(tmpdir(), "bridge-recovery-only-")));
    cfg.session = `bridge-recovery-only-${process.pid}`;
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });
    const lines: string[] = [];
    expect(
      await up(cfg, {
        mux,
        print: (line) => lines.push(line),
        skipDaemon: true,
        existingSessionOnly: true,
      }),
    ).toBe(1);
    expect(await mux.hasSession(cfg.session)).toBe(false);
    expect(lines.join("\n")).toContain("refusing existing-session-only");
  });

  test("all-disabled config fails before creating a session or daemon", async () => {
    const cfg = defaultConfig(mkdtempSync(join(tmpdir(), "bridge-disabled-")));
    cfg.session = `bridge-disabled-${process.pid}`;
    for (const agent of cfg.agents) agent.enabled = false;
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });
    const lines: string[] = [];
    expect(await up(cfg, { mux, print: (line) => lines.push(line) })).toBe(1);
    expect(await mux.hasSession(cfg.session)).toBe(false);
    expect(lines.join("\n")).toContain("no agents enabled");
  });

  test("legacy down requires opt-in, then accepts an exactly identified baseline", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bridge-legacy-accept-"));
    const cfg = defaultConfig(repo);
    cfg.session = `bridge-legacy-accept-${process.pid}`;
    cfg.daemonPort = LEGACY_ACCEPT_PORT;
    const pidFile = daemonPidFile(cfg.daemonPort);
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });
    await createLegacySession(mux, cfg.session, repo);
    const child = await startLegacyDaemon(cfg.daemonPort, pidFile, cfg.configDir);

    try {
      const refused: string[] = [];
      expect(await down(cfg, { mux, print: (line) => refused.push(line) })).toBe(1);
      expect(await mux.hasSession(cfg.session)).toBe(true);
      expect(refused.join("\n")).toContain("rerun with `bridge down --legacy`");
      expect(() => process.kill(child.pid, 0)).not.toThrow();

      const accepted: string[] = [];
      expect(await down(cfg, {
        mux,
        allowLegacy: true,
        print: (line) => accepted.push(line),
      })).toBe(0);
      expect(await mux.hasSession(cfg.session)).toBe(false);
      expect(accepted.join("\n")).toContain("verified legacy baseline");
      expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => -1)])).toBe(0);
    } finally {
      if (await mux.hasSession(cfg.session)) await mux.killSession(cfg.session);
      await stopFixture(child);
      rmSync(pidFile, { force: true });
    }
  });

  test("legacy down refuses a daemon whose --dir only shares a path prefix", async () => {
    const repo = mkdtempSync(join(tmpdir(), "bridge-legacy-prefix-"));
    const otherRepo = `${repo}-other`;
    mkdirSync(otherRepo);
    const cfg = defaultConfig(repo);
    cfg.session = `bridge-legacy-prefix-${process.pid}`;
    cfg.daemonPort = LEGACY_PREFIX_PORT;
    const pidFile = daemonPidFile(cfg.daemonPort);
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });
    await createLegacySession(mux, cfg.session, repo);
    const child = await startLegacyDaemon(cfg.daemonPort, pidFile, otherRepo);

    try {
      const lines: string[] = [];
      expect(await down(cfg, {
        mux,
        allowLegacy: true,
        print: (line) => lines.push(line),
      })).toBe(1);
      expect(await mux.hasSession(cfg.session)).toBe(true);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      expect(lines.join("\n")).toContain("REFUSING");
    } finally {
      if (await mux.hasSession(cfg.session)) await mux.killSession(cfg.session);
      await stopFixture(child);
      rmSync(pidFile, { force: true });
    }
  });
});

describe("bridge up/down against real tmux + real daemon", () => {
  test(
    "up creates two horizontal panes, spawns the daemon; down tears both down",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "bridge-cli-"));
      writeFileSync(
        join(repo, CONFIG_FILENAME),
        JSON.stringify({
          session: SESSION,
          daemonPort: PORT,
          db: join(repo, "events.sqlite"),
          agents: [
            // echo markers: lets the test assert the launch command actually
            // EXECUTED in the pane (a paste that lands before the shell is
            // ready echoes to the tty but never runs — a real regression).
            { id: "claude", kind: "claude", command: "echo bridge-launched-claude" },
            { id: "codex", kind: "codex", command: "echo bridge-launched-codex" },
          ],
        }),
      );
      const cfg = loadConfig(repo);
      const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });
      const lines: string[] = [];
      const daemonScript = fileURLToPath(new URL("../daemon/index.ts", import.meta.url));

      const code = await up(cfg, { mux, print: (l) => lines.push(l), daemonScript });
      expect(code).toBe(0);
      expect(await mux.hasSession(SESSION)).toBe(true);
      const panes = await mux.listPanes(SESSION);
      expect(panes).toHaveLength(2);
      expect(
        panes.slice().sort((a, b) => a.index - b.index).map((pane) => pane.agentId),
      ).toEqual(["claude", "codex"]);
      expect(await mux.getSessionMarker(SESSION)).toBe(bridgeSessionMarker(cfg));
      expect(panes[0]?.height).toBe(panes[1]?.height);
      expect(panes.every((pane) => pane.width < 220 && pane.height >= 50)).toBe(true);
      expect(await daemonHealthy(PORT)).toBe(true);

      // Launch commands must have EXECUTED (not just been pasted): the echo
      // marker only appears in output when the shell ran the command.
      for (const pane of panes) {
        const executed = await pollFor(async () => {
          const text = await mux.capturePane(pane.id);
          // marker on a line of its own = command output, not the echoed paste
          return text.split("\n").some((l) => l.trim().startsWith("bridge-launched-"));
        });
        expect(executed).toBe(true);
      }

      // status endpoint contains exactly the configured two-agent roster
      const status = (await (await fetch(`http://127.0.0.1:${PORT}/status`)).json()) as StatusResponse;
      expect(status.agents.map((agent) => agent.agent)).toEqual(["claude", "codex"]);
      expect(status.daemon.configDir).toBe(cfg.configDir);
      expect(status.daemon.sourceRoot).toBe(cfg.sourceRoot);
      expect(status.daemon.sourceFingerprint).toBe(cfg.sourceFingerprint);
      expect(status.daemon.configFingerprint).toBe(configFingerprint(cfg));

      // re-running up leaves the panes alone, re-ensures the daemon, exits 0
      expect(await up(cfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(0);
      expect(await mux.listPanes(SESSION)).toHaveLength(2);
      expect(await daemonHealthy(PORT)).toBe(true);

      // A changed config in the same directory cannot silently reuse stale panes.
      const staleCfg = {
        ...cfg,
        agents: cfg.agents.map((agent) => ({ ...agent })),
      };
      staleCfg.agents[0]!.command = "echo changed-command";
      expect(await up(staleCfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(1);
      expect(await mux.listPanes(SESSION)).toHaveLength(2);
      expect(await daemonHealthy(PORT)).toBe(true);

      // The same default session/port from another target repo is never reused,
      // attached, displayed, or torn down.
      const foreignDir = mkdtempSync(join(tmpdir(), "bridge-foreign-"));
      const foreignCfg = {
        ...cfg,
        repo: foreignDir,
        configDir: foreignDir,
        db: join(foreignDir, "events.sqlite"),
        agents: cfg.agents.map((agent) => ({ ...agent })),
      };
      const foreignPortCfg = {
        ...foreignCfg,
        session: `bridge-foreign-${process.pid}`,
      };
      expect(await up(foreignPortCfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(1);
      expect(await mux.hasSession(foreignPortCfg.session)).toBe(false);
      expect(await attach(foreignCfg, { mux, print: (l) => lines.push(l) })).toBe(1);
      const topFrames: string[] = [];
      expect(await top(foreignCfg, { once: true, print: (frame) => topFrames.push(frame) })).toBe(1);
      expect(topFrames.join("\n")).toContain("another or stale bridge configuration");
      expect(await down(foreignCfg, { mux, print: (l) => lines.push(l) })).toBe(1);
      expect(await mux.hasSession(SESSION)).toBe(true);
      expect(await daemonHealthy(PORT)).toBe(true);

      // Crash only the daemon, then prove `up` revives it without replacing panes.
      const paneIdsBeforeRecovery = (await mux.listPanes(SESSION)).map((pane) => pane.id);
      process.kill(status.daemon.pid, "SIGTERM");
      expect(await pollFor(async () => !(await daemonHealthy(PORT)))).toBe(true);
      expect(await mux.hasSession(SESSION)).toBe(true);
      expect(await up(cfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(0);
      expect((await mux.listPanes(SESSION)).map((pane) => pane.id)).toEqual(
        paneIdsBeforeRecovery,
      );
      expect(await daemonHealthy(PORT)).toBe(true);

      const downCode = await down(cfg, { mux, print: (l) => lines.push(l) });
      expect(downCode).toBe(0);
      expect(await mux.hasSession(SESSION)).toBe(false);
      // daemon exits after SIGTERM (poll up to 3s)
      let healthy = true;
      for (let i = 0; i < 30 && healthy; i++) {
        healthy = await daemonHealthy(PORT);
        if (healthy) await Bun.sleep(100);
      }
      expect(healthy).toBe(false);
    },
    { timeout: 30_000 },
  );
});
