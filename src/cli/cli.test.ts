import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, defaultConfig, CONFIG_FILENAME } from "../config.ts";
import type { AgentStatus, StatusResponse } from "../types.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { up, launchCommand, daemonHealthy } from "./up.ts";
import { down } from "./down.ts";
import { formatAge, renderBoard } from "./top.ts";

const SOCKET = `bridge-test-cli-${process.pid}`;
const SESSION = `bridge-cli-${process.pid}`;
const PORT = 4800 + (process.pid % 150);

afterAll(() => {
  Bun.spawnSync(["tmux", "-L", SOCKET, "kill-server"]);
});

function agentStatus(partial: Partial<AgentStatus> & Pick<AgentStatus, "agent">): AgentStatus {
  return {
    enabled: true,
    state: "idle",
    sessionId: null,
    lastEvent: null,
    pendingPermission: null,
    observedVia: "events",
    ...partial,
  };
}

function fixtureStatus(now: number): StatusResponse {
  return {
    daemon: { startedAt: now - 60_000, port: 4770, pid: 1234 },
    agents: {
      claude: agentStatus({
        agent: "claude",
        state: "working",
        sessionId: "abcd1234efgh",
        lastEvent: { type: "turn.start", nativeType: "UserPromptSubmit", ts: now - 3_000 },
      }),
      codex: agentStatus({
        agent: "codex",
        state: "needs_you",
        pendingPermission: "shell",
        lastEvent: { type: "permission.request", nativeType: "PermissionRequest", ts: now - 12_000 },
      }),
      agy: agentStatus({ agent: "agy", state: "launching", observedVia: "mux" }),
      opencode: agentStatus({ agent: "opencode", enabled: false }),
    },
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
  test("shows every agent with state, age, badge, and markers", () => {
    const now = Date.now();
    const board = renderBoard(fixtureStatus(now), now);
    expect(board).toContain("claude");
    expect(board).toContain("working");
    expect(board).toContain("UserPromptSubmit");
    expect(board).toContain("3s ago");
    expect(board).toContain("sess abcd1234");
    expect(board).toContain("NEEDS YOU");
    expect(board).toContain("⚠ shell");
    expect(board).toContain("(mux-observed)");
    expect(board).toContain("disabled");
    expect(board).toContain("127.0.0.1:4770");
  });
});

describe("launchCommand", () => {
  test("opencode gets port+hostname pinned, others pass through", () => {
    const cfg = defaultConfig("/x");
    expect(launchCommand(cfg, "claude")).toBe("claude");
    expect(launchCommand(cfg, "opencode")).toBe("opencode --port 4096 --hostname 127.0.0.1");
  });
});

describe("bridge up/down against real tmux + real daemon", () => {
  test(
    "up creates a 4-pane session, spawns the daemon; down tears both down",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "bridge-cli-"));
      writeFileSync(
        join(repo, CONFIG_FILENAME),
        JSON.stringify({
          session: SESSION,
          daemonPort: PORT,
          db: join(repo, "events.sqlite"),
          agents: {
            claude: { command: "cat" },
            codex: { command: "cat" },
            agy: { command: "cat" },
            opencode: { command: "cat" },
          },
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
      expect(panes).toHaveLength(4);
      expect(await daemonHealthy(PORT)).toBe(true);

      // status endpoint knows all four agents
      const status = (await (await fetch(`http://127.0.0.1:${PORT}/status`)).json()) as StatusResponse;
      expect(Object.keys(status.agents).sort()).toEqual(["agy", "claude", "codex", "opencode"]);

      // re-running up leaves the panes alone, re-ensures the daemon, exits 0
      expect(await up(cfg, { mux, print: (l) => lines.push(l), daemonScript })).toBe(0);
      expect(await mux.listPanes(SESSION)).toHaveLength(4);
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
