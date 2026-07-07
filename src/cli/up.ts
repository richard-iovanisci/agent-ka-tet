import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "../config.ts";
import { daemonLogFile } from "../paths.ts";
import { AGENT_NAMES, type AgentName } from "../types.ts";
import type { MuxAdapter } from "../mux/adapter.ts";
import { composeOpencodeCommand } from "../adapters/opencode/init.ts";

export interface UpOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
  /** Override the daemon entrypoint (tests). */
  daemonScript?: string;
  /** Skip daemon spawn entirely (tests that bring their own). */
  skipDaemon?: boolean;
}

function defaultDaemonScript(): string {
  return fileURLToPath(new URL("../daemon/index.ts", import.meta.url));
}

export async function daemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(cfg: BridgeConfig, print: (l: string) => void, script: string): Promise<boolean> {
  if (await daemonHealthy(cfg.daemonPort)) {
    print(`daemon: already running on 127.0.0.1:${cfg.daemonPort}`);
    return true;
  }
  const log = daemonLogFile(cfg.daemonPort);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  // The daemon is its own process: the CLI exiting (or dying) never touches
  // it, and it never touches the agents (CLAUDE.md constraint 1).
  // --dir is where the CONFIG lives, not cfg.repo (which may point elsewhere) —
  // the daemon must re-load the exact config the CLI is operating with.
  const child = Bun.spawn(["bun", script, "--dir", cfg.configDir], {
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  child.unref();
  print(`daemon: starting on 127.0.0.1:${cfg.daemonPort} (log: ${log})`);
  for (let i = 0; i < 30; i++) {
    if (await daemonHealthy(cfg.daemonPort)) return true;
    await Bun.sleep(100);
  }
  print(`daemon: FAILED to become healthy within 3s — check ${log}`);
  return false;
}

/** Launch command for an agent pane; opencode gets its port pinned. */
export function launchCommand(cfg: BridgeConfig, agent: AgentName): string {
  return agent === "opencode" ? composeOpencodeCommand(cfg) : cfg.agents[agent].command;
}

export async function up(cfg: BridgeConfig, opts: UpOptions): Promise<number> {
  const print = opts.print ?? console.log;
  const mux = opts.mux;

  if (await mux.hasSession(cfg.session)) {
    // Recovery path: session alive but daemon possibly dead (crash, reboot).
    // Re-running `bridge up` revives the daemon without touching the panes.
    print(`session "${cfg.session}" already exists — leaving panes untouched`);
    if (!opts.skipDaemon) {
      const ok = await ensureDaemon(cfg, print, opts.daemonScript ?? defaultDaemonScript());
      if (!ok) return 1;
    }
    print(`use \`bridge attach\` to enter it, or \`bridge down\` to tear it down`);
    return 0;
  }

  if (!opts.skipDaemon) {
    const ok = await ensureDaemon(cfg, print, opts.daemonScript ?? defaultDaemonScript());
    if (!ok) return 1;
  }

  const agents = AGENT_NAMES.filter((a) => cfg.agents[a].enabled);
  if (agents.length === 0) {
    print("no agents enabled in bridge.config — nothing to launch");
    return 1;
  }

  // One pane per agent. Panes run the user's login shell and the launch
  // command is typed into them (bracketed paste + echo-verify + Enter), so
  // the TUI is exactly what the user would have started by hand, and the
  // pane outlives the agent process.
  const first = agents[0]!;
  const firstPane = await mux.createSession(cfg.session, {
    cwd: cfg.agents[first].cwd ?? cfg.repo,
    width: 220,
    height: 60,
  });
  const panes: Array<{ agent: AgentName; paneId: string }> = [{ agent: first, paneId: firstPane }];
  for (const agent of agents.slice(1)) {
    const paneId = await mux.splitPane(cfg.session, { cwd: cfg.agents[agent].cwd ?? cfg.repo });
    panes.push({ agent, paneId });
  }
  await mux.selectLayout(cfg.session, "tiled");

  for (const { agent, paneId } of panes) {
    await mux.setPaneTitle(paneId, agent);
    const cmd = launchCommand(cfg, agent);
    const sent = await mux.sendText(paneId, cmd, { submit: true });
    print(`${agent}: launched \`${cmd}\` in pane ${paneId}${sent.verified ? "" : " (echo-verify failed — check the pane)"}`);
  }

  print("");
  print(`session "${cfg.session}" is up (${panes.length} panes) — \`bridge attach\` to enter, \`bridge top\` to watch`);
  return 0;
}
