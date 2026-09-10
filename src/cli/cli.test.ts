import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  BRIDGE_AGENT_ID_ENV,
  BRIDGE_CONFIG_FINGERPRINT_ENV,
  BRIDGE_MANAGED_PROCESS_OPTION,
  managedProcessMarkerPrefix,
} from "../attribution.ts";
import type { AgentStatus, StatusResponse } from "../types.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { up, launchCommand, daemonHealthy } from "./up.ts";
import { down } from "./down.ts";
import { fetchDaemonStatus } from "./daemonClient.ts";
import { attach } from "./attach.ts";
import { formatAge, renderBoard, top } from "./top.ts";

const SOCKET = `bridge-test-cli-${process.pid}`;
const SESSION = `bridge-cli-${process.pid}`;
const SHELL_ROOT = mkdtempSync(join(tmpdir(), "bridge-cli-shell-"));
const SHELL_ENV = { SHELL: "/bin/zsh", ZDOTDIR: SHELL_ROOT };
writeFileSync(join(SHELL_ROOT, ".zshenv"), "unsetopt GLOBAL_RCS\n");
writeFileSync(join(SHELL_ROOT, ".zshrc"), "PROMPT='bridge-fixture> '\nRPROMPT=''\n");
afterAll(() => {
  Bun.spawnSync(["tmux", "-L", SOCKET, "kill-server"]);
  rmSync(SHELL_ROOT, { recursive: true, force: true });
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

  test("explains either agent's unobserved launching state without inventing an event", () => {
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
      "awaiting first observed turn",
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
  test("exports managed-process attribution around the native-TUI command", () => {
    const cfg = defaultConfig("/x");
    const command = launchCommand(cfg.agents[0]!, cfg, "run-token-1");
    expect(command).toContain(`${BRIDGE_AGENT_ID_ENV}='claude'`);
    expect(command).toContain(
      `${BRIDGE_CONFIG_FINGERPRINT_ENV}='${configFingerprint(cfg)}'`,
    );
    expect(command).toContain(BRIDGE_MANAGED_PROCESS_OPTION);
    expect(command).toContain(
      managedProcessMarkerPrefix("claude", configFingerprint(cfg), "run-token-1"),
    );
    expect(command).toContain(`sh -c \"$1\"`);
    expect(command).toEndWith("bridge-managed 'claude'");

    const custom = launchCommand(
      { ...cfg.agents[1]!, command: "exec codex --profile pair" },
      cfg,
      "run-token-2",
    );
    expect(custom).toContain(
      managedProcessMarkerPrefix("codex", configFingerprint(cfg), "run-token-2"),
    );
    expect(custom).toEndWith("bridge-managed 'exec codex --profile pair'");
  });
});

describe("bridge ownership guards", () => {
  test("existing-session-only recovery never creates a missing session", async () => {
    const cfg = defaultConfig(mkdtempSync(join(tmpdir(), "bridge-recovery-only-")));
    cfg.session = `bridge-recovery-only-${process.pid}`;
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null", environment: SHELL_ENV });
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
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null", environment: SHELL_ENV });
    const lines: string[] = [];
    expect(await up(cfg, { mux, print: (line) => lines.push(line) })).toBe(1);
    expect(await mux.hasSession(cfg.session)).toBe(false);
    expect(lines.join("\n")).toContain("no agents enabled");
  });

  test("down refuses a session and daemon without current ownership evidence", async () => {
    const cfg = defaultConfig(mkdtempSync(join(tmpdir(), "bridge-unowned-")));
    cfg.session = `bridge-unowned-${process.pid}`;
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ daemon: { pid: process.pid }, agents: [] }),
    });
    cfg.daemonPort = fixture.port!;
    const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null", environment: SHELL_ENV });
    await mux.createSession(cfg.session, { cwd: cfg.repo });
    try {
      const lines: string[] = [];
      expect(await down(cfg, { mux, print: line => lines.push(line) })).toBe(1);
      expect(await mux.hasSession(cfg.session)).toBe(true);
      expect(lines.filter(line => line.includes("REFUSING"))).toHaveLength(2);
    } finally {
      await mux.killSession(cfg.session);
      fixture.stop(true);
    }
  });
});

describe("bridge up/down against real tmux + real daemon", () => {
  test(
    "up creates two horizontal panes, spawns the daemon; down tears both down",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "bridge-cli-"));
      const roots = [repo];
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reservation.port!;
      await reservation.stop(true);
      writeFileSync(
        join(repo, CONFIG_FILENAME),
        JSON.stringify({
          session: SESSION,
          daemonPort: port,
          db: join(repo, "events.sqlite"),
          agents: [
            // Output markers prove both that the launch command executed and
            // that its process-scoped attribution reached a native child.
            {
              id: "claude",
              kind: "claude",
              command:
                "printf 'bridge-launched-claude:%s\\nbridge-fingerprint:%s\\n' \"$AGENT_BRIDGE_AGENT_ID\" \"$AGENT_BRIDGE_CONFIG_FINGERPRINT\"",
            },
            {
              id: "codex",
              kind: "codex",
              command:
                "printf 'bridge-launched-codex:%s\\nbridge-fingerprint:%s\\n' \"$AGENT_BRIDGE_AGENT_ID\" \"$AGENT_BRIDGE_CONFIG_FINGERPRINT\"",
            },
          ],
        }),
      );
      const cfg = loadConfig(repo);
      const mux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null", environment: SHELL_ENV });
      const lines: string[] = [];
      const daemonScript = fileURLToPath(new URL("../daemon/index.ts", import.meta.url));

      try {
        const code = await up(cfg, { mux, print: (l) => lines.push(l), daemonScript });
        let startupDetail = lines.join("\n");
        if (code !== 0) {
          const reported = await fetchDaemonStatus(port);
          startupDetail += "\n" + JSON.stringify({
            expectedSource: cfg.sourceFingerprint,
            reportedSource: reported?.daemon.sourceFingerprint,
            expectedConfig: configFingerprint(cfg),
            reportedConfig: reported?.daemon.configFingerprint,
            reportedConfigDir: reported?.daemon.configDir,
          });
        }
        expect(code, startupDetail).toBe(0);
        expect(await mux.hasSession(SESSION)).toBe(true);
        const panes = await mux.listPanes(SESSION);
        expect(panes).toHaveLength(2);
        expect(
          panes.slice().sort((a, b) => a.index - b.index).map((pane) => pane.agentId),
        ).toEqual(["claude", "codex"]);
        expect(await mux.getSessionMarker(SESSION)).toBe(bridgeSessionMarker(cfg));
        expect(panes[0]?.height).toBe(panes[1]?.height);
        expect(panes.every((pane) => pane.width < 220 && pane.height >= 50)).toBe(true);
        expect(await daemonHealthy(port)).toBe(true);

        // Launch commands must have EXECUTED (not just been pasted), with both
        // managed-process markers available to their process trees.
        for (const pane of panes) {
          const executed = await pollFor(async () => {
            const text = await mux.capturePane(pane.id);
            const output = text.split("\n").map((line) => line.trim());
            return (
              output.includes(`bridge-launched-${pane.agentId}:${pane.agentId}`) &&
              output.includes(`bridge-fingerprint:${configFingerprint(cfg)}`)
            );
          });
          expect(executed).toBe(true);
        }
        expect(await pollFor(async () =>
          (await mux.listPanes(SESSION)).every((pane) => pane.managedProcess === null)
        )).toBe(true);

        // status endpoint contains exactly the configured two-agent roster
        const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as StatusResponse;
        expect(status.agents.map((agent) => agent.agent)).toEqual(["claude", "codex"]);
        expect(status.daemon.configDir).toBe(cfg.configDir);
        expect(status.daemon.sourceRoot).toBe(cfg.sourceRoot);
        expect(status.daemon.sourceFingerprint).toBe(cfg.sourceFingerprint);
        expect(status.daemon.configFingerprint).toBe(configFingerprint(cfg));

        // re-running up leaves the panes alone, re-ensures the daemon, exits 0
        expect(await up(cfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(0);
        expect(await mux.listPanes(SESSION)).toHaveLength(2);
        expect(await daemonHealthy(port)).toBe(true);

        // A changed config in the same directory cannot silently reuse stale panes.
        const staleCfg = {
          ...cfg,
          agents: cfg.agents.map((agent) => ({ ...agent })),
        };
        staleCfg.agents[0]!.command = "echo changed-command";
        expect(await up(staleCfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(1);
        expect(await mux.listPanes(SESSION)).toHaveLength(2);
        expect(await daemonHealthy(port)).toBe(true);

        // The same default session/port from another target repo is never reused,
        // attached, displayed, or torn down.
        const foreignDir = mkdtempSync(join(tmpdir(), "bridge-foreign-"));
        roots.push(foreignDir);
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
        expect(await daemonHealthy(port)).toBe(true);

        // Crash only the daemon, then prove `up` revives it without replacing panes.
        const paneIdsBeforeRecovery = (await mux.listPanes(SESSION)).map((pane) => pane.id);
        process.kill(status.daemon.pid, "SIGTERM");
        expect(await pollFor(async () => !(await daemonHealthy(port)))).toBe(true);
        expect(await mux.hasSession(SESSION)).toBe(true);
        expect(await up(cfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(0);
        expect((await mux.listPanes(SESSION)).map((pane) => pane.id)).toEqual(
          paneIdsBeforeRecovery,
        );
        expect(await daemonHealthy(port)).toBe(true);

        const downCode = await down(cfg, { mux, print: (l) => lines.push(l) });
        expect(downCode).toBe(0);
        expect(await mux.hasSession(SESSION)).toBe(false);
        // daemon exits after SIGTERM (poll up to 3s)
        let healthy = true;
        for (let i = 0; i < 30 && healthy; i++) {
          healthy = await daemonHealthy(port);
          if (healthy) await Bun.sleep(100);
        }
        expect(healthy).toBe(false);
      } finally {
        await down(cfg, { mux, print: () => {} });
        const stopped = await pollFor(async () =>
          (await fetchDaemonStatus(port))?.daemon.configDir !== cfg.configDir
        );
        if (stopped) for (const root of roots) rmSync(root, { recursive: true, force: true });
      }
    },
    { timeout: 30_000 },
  );
});
