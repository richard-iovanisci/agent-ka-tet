import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeSessionMarker,
  type AgentConfig,
  type BridgeConfig,
} from "../config.ts";
import { daemonLogFile } from "../paths.ts";
import type { MuxAdapter } from "../mux/adapter.ts";
import { daemonMatchesConfig, fetchDaemonStatus } from "./daemonClient.ts";

export interface UpOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
  /** Override the daemon entrypoint (tests). */
  daemonScript?: string;
  /** Skip daemon spawn entirely (tests that bring their own). */
  skipDaemon?: boolean;
  /** Recover only behind an already-owned session; never create panes. */
  existingSessionOnly?: boolean;
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
  const existing = await fetchDaemonStatus(cfg.daemonPort);
  if (existing !== null) {
    if (daemonMatchesConfig(existing, cfg)) {
      print(`daemon: already running on 127.0.0.1:${cfg.daemonPort}`);
      return true;
    }
    print(
      `daemon: REFUSING to reuse pid ${existing.daemon.pid} on port ${cfg.daemonPort} — it belongs to another or stale bridge configuration`,
    );
    print("daemon: stop it from its owning target repo, or choose another daemonPort");
    return false;
  }
  if (await daemonHealthy(cfg.daemonPort)) {
    print(
      `daemon: REFUSING to use 127.0.0.1:${cfg.daemonPort} — another service answers there without a matching bridge status`,
    );
    return false;
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
  closeSync(fd);
  child.unref();
  print(`daemon: starting on 127.0.0.1:${cfg.daemonPort} (log: ${log})`);
  for (let i = 0; i < 30; i++) {
    const status = await fetchDaemonStatus(cfg.daemonPort);
    if (status !== null) {
      if (daemonMatchesConfig(status, cfg)) return true;
      print(
        `daemon: REFUSING mismatched process on 127.0.0.1:${cfg.daemonPort} after spawn`,
      );
      return false;
    }
    await Bun.sleep(100);
  }
  print(`daemon: FAILED to become healthy within 3s — check ${log}`);
  return false;
}

/** Launch command for an agent pane. Commands always start the native TUI. */
export function launchCommand(agent: AgentConfig): string {
  return agent.command;
}

export async function up(cfg: BridgeConfig, opts: UpOptions): Promise<number> {
  const print = opts.print ?? console.log;
  const mux = opts.mux;
  const agents = cfg.agents.filter((agent) => agent.enabled);
  if (agents.length === 0) {
    print("no agents enabled in bridge.config — nothing to launch");
    return 1;
  }

  if (await mux.hasSession(cfg.session)) {
    const marker = await mux.getSessionMarker(cfg.session);
    if (marker !== bridgeSessionMarker(cfg)) {
      print(
        `session "${cfg.session}" belongs to another or stale bridge configuration — refusing to reuse it`,
      );
      print(`session marker: ${marker ?? "missing"}`);
      return 1;
    }
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

  if (opts.existingSessionOnly) {
    print(
      `session "${cfg.session}" is missing — refusing existing-session-only daemon recovery`,
    );
    return 1;
  }

  if (!opts.skipDaemon) {
    const ok = await ensureDaemon(cfg, print, opts.daemonScript ?? defaultDaemonScript());
    if (!ok) return 1;
  }

  // One pane per agent. Panes run the user's login shell and the launch
  // command is typed into them (bracketed paste + echo-verify + Enter), so
  // the TUI is exactly what the user would have started by hand, and the
  // pane outlives the agent process.
  const first = agents[0]!;
  const firstPane = await mux.createSession(cfg.session, {
    cwd: first.cwd ?? cfg.repo,
    width: 220,
    height: 60,
  });
  await mux.setSessionMarker(cfg.session, bridgeSessionMarker(cfg));
  const panes: Array<{ agent: AgentConfig; paneId: string }> = [{ agent: first, paneId: firstPane }];
  for (const agent of agents.slice(1)) {
    const paneId = await mux.splitPane(cfg.session, { cwd: agent.cwd ?? cfg.repo });
    panes.push({ agent, paneId });
  }
  await mux.selectLayout(cfg.session, panes.length === 2 ? "even-horizontal" : "tiled");

  let launchFailures = 0;
  for (const { agent, paneId } of panes) {
    await mux.setPaneAgentId(paneId, agent.id);
    await mux.setPaneTitle(paneId, agent.id);
    const cmd = launchCommand(agent);
    // Injection etiquette step 0: text typed before the shell draws its
    // prompt is echoed by the tty but never executes.
    if (!(await mux.waitForShellReady(paneId))) {
      launchFailures++;
      print(`${agent.id}: pane ${paneId} shell never became ready — launch \`${cmd}\` in it manually`);
      continue;
    }
    const sent = await mux.sendText(paneId, cmd, { submit: true });
    if (!sent.ok) launchFailures++;
    print(
      `${agent.id}: ${sent.ok ? "launched" : "FAILED to launch"} \`${cmd}\` in pane ${paneId}${sent.verified ? "" : " (echo-verify failed — check the pane)"}`,
    );
  }

  print("");
  print(`session "${cfg.session}" is up (${panes.length} panes) — \`bridge attach\` to enter, \`bridge top\` to watch`);
  if (launchFailures > 0) {
    print(`${launchFailures} pane launch(es) need manual recovery; the session was left intact`);
    return 1;
  }
  return 0;
}
