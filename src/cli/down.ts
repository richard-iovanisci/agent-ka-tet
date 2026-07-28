import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  configFingerprint,
  parseBridgeSessionMarker,
  type BridgeConfig,
} from "../config.ts";
import { daemonPidFile } from "../paths.ts";
import type { MuxAdapter } from "../mux/adapter.ts";
import { daemonBelongsToConfig, fetchDaemonStatus } from "./daemonClient.ts";

export interface DownOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
  /** Explicitly permit teardown of a positively identified origin/phase-0 runtime. */
  allowLegacy?: boolean;
}

function isLegacyFourAgentStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || Array.isArray(status)) return false;
  const record = status as Record<string, unknown>;
  const daemon = record.daemon;
  const agents = record.agents;
  if (typeof daemon !== "object" || daemon === null || Array.isArray(daemon)) return false;
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return false;
  const daemonRecord = daemon as Record<string, unknown>;
  return (
    daemonRecord.configDir === undefined &&
    daemonRecord.configFingerprint === undefined &&
    Object.keys(agents as Record<string, unknown>).sort().join("|") ===
      "agy|claude|codex|opencode"
  );
}

function processCommand(pid: number): string | null {
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * origin/phase-0 always spawned the daemon with `--dir <configDir>` as the
 * final two argv entries. `ps` exposes argv as one display string, so require
 * that exact terminal suffix (plus a boundary before `--dir`). A substring
 * check would let `/repo/a` claim a daemon actually launched for `/repo/ab`.
 */
function hasExactLegacyConfigDir(command: string, configDir: string): boolean {
  const suffix = `--dir ${configDir}`;
  const start = command.length - suffix.length;
  return start >= 0 &&
    command.slice(start) === suffix &&
    (start === 0 || /\s/.test(command[start - 1]!));
}

function legacyProcessMatches(pid: number, cfg: BridgeConfig): boolean {
  const command = processCommand(pid);
  return command !== null &&
    command.includes("daemon/index.ts") &&
    hasExactLegacyConfigDir(command, cfg.configDir);
}

function legacyPaneTitlesMatch(
  titles: string[],
  status: unknown,
): boolean {
  const agents = (status as { agents: Record<string, { enabled?: boolean }> }).agents;
  const expected = Object.entries(agents)
    .filter(([, value]) => value.enabled !== false)
    .map(([name]) => name)
    .sort();
  return titles.slice().sort().join("|") === expected.join("|");
}

/**
 * The only PID we ever signal is the one the daemon itself reports over
 * 127.0.0.1:<daemonPort>/status. A pidfile alone is never trusted: after a
 * crash or reboot its PID may have been recycled to an unrelated process —
 * possibly an agent — and signalling that would violate CLAUDE.md
 * constraint 1. Stale pidfiles are removed, never acted on.
 */
export async function down(cfg: BridgeConfig, opts: DownOptions): Promise<number> {
  const print = opts.print ?? console.log;
  let refused = false;

  const pidFile = daemonPidFile(cfg.daemonPort);
  const filePid = existsSync(pidFile)
    ? Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    : null;
  const status = await fetchDaemonStatus(cfg.daemonPort);
  const livePid = status?.daemon.pid;
  const legacyOwned =
    opts.allowLegacy === true &&
    status !== null &&
    isLegacyFourAgentStatus(status) &&
    Number.isInteger(livePid) &&
    livePid !== undefined &&
    livePid > 1 &&
    filePid === livePid &&
    legacyProcessMatches(livePid, cfg);

  if (await opts.mux.hasSession(cfg.session)) {
    const rawMarker = await opts.mux.getSessionMarker(cfg.session);
    const marker = parseBridgeSessionMarker(rawMarker);
    const legacySessionOwned =
      rawMarker === null &&
      legacyOwned &&
      legacyPaneTitlesMatch(
        (await opts.mux.listPanes(cfg.session)).map((pane) => pane.title),
        status,
      );
    if (marker?.configDir !== cfg.configDir && !legacySessionOwned) {
      refused = true;
      print(
        `session "${cfg.session}" is not owned by this target repo — REFUSING to kill it`,
      );
      if (rawMarker === null) {
        print("session: use `bridge down --legacy` only for a still-running, verified four-agent baseline");
      }
    } else {
      await opts.mux.killSession(cfg.session);
      print(
        `session "${cfg.session}" killed${legacySessionOwned ? " (verified legacy baseline)" : ""}`,
      );
      if (marker !== null && marker.configFingerprint !== configFingerprint(cfg)) {
        print("session: configuration changed since launch; ownership matched by config directory");
      }
    }
  } else {
    print(`session "${cfg.session}" not running`);
  }

  if (status !== null && !daemonBelongsToConfig(status, cfg) && !legacyOwned) {
    refused = true;
    print(
      `daemon: pid ${status.daemon.pid} on port ${cfg.daemonPort} belongs to another target repo — REFUSING to signal it`,
    );
    if (isLegacyFourAgentStatus(status)) {
      print("daemon: rerun with `bridge down --legacy` to retire it after identity checks");
    }
  } else if (
    status !== null &&
    Number.isInteger(livePid) &&
    livePid !== undefined &&
    livePid > 1 &&
    filePid === livePid
  ) {
    try {
      process.kill(livePid, "SIGTERM");
      print(
        `daemon: sent SIGTERM to pid ${livePid} (verified by ${legacyOwned ? "legacy process identity" : "config identity"}, /status, and pidfile)`,
      );
    } catch (e) {
      refused = true;
      print(`daemon: could not signal pid ${livePid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (status !== null) {
    refused = true;
    print(
      `daemon: live pid ${String(livePid)} does not match pidfile ${String(filePid)} — REFUSING to signal either`,
    );
  } else {
    print(`daemon: not reachable on 127.0.0.1:${cfg.daemonPort} — nothing to stop`);
    if (filePid !== null) {
      print(`daemon: removing stale pidfile (pid ${filePid} not verified as the daemon — not signalled)`);
      rmSync(pidFile, { force: true });
    }
  }
  return refused ? 1 : 0;
}
