import { existsSync, readFileSync, rmSync } from "node:fs";
import type { BridgeConfig } from "../config.ts";
import { daemonPidFile } from "../paths.ts";
import type { MuxAdapter } from "../mux/adapter.ts";
import type { StatusResponse } from "../types.ts";

export interface DownOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
}

/**
 * The only PID we ever signal is the one the daemon itself reports over
 * 127.0.0.1:<daemonPort>/status. A pidfile alone is never trusted: after a
 * crash or reboot its PID may have been recycled to an unrelated process —
 * possibly an agent — and signalling that would violate CLAUDE.md
 * constraint 1. Stale pidfiles are removed, never acted on.
 */
async function liveDaemonPid(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(900),
    });
    if (!res.ok) return null;
    const status = (await res.json()) as StatusResponse;
    return Number.isInteger(status.daemon.pid) && status.daemon.pid > 1 ? status.daemon.pid : null;
  } catch {
    return null;
  }
}

export async function down(cfg: BridgeConfig, opts: DownOptions): Promise<number> {
  const print = opts.print ?? console.log;

  if (await opts.mux.hasSession(cfg.session)) {
    await opts.mux.killSession(cfg.session);
    print(`session "${cfg.session}" killed`);
  } else {
    print(`session "${cfg.session}" not running`);
  }

  const pidFile = daemonPidFile(cfg.daemonPort);
  const filePid = existsSync(pidFile)
    ? Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    : null;

  const livePid = await liveDaemonPid(cfg.daemonPort);
  if (livePid !== null) {
    try {
      process.kill(livePid, "SIGTERM");
      print(`daemon: sent SIGTERM to pid ${livePid} (verified via /status on port ${cfg.daemonPort})`);
    } catch (e) {
      print(`daemon: could not signal pid ${livePid}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (filePid !== null && filePid !== livePid) {
      print(`daemon: pidfile said ${filePid} but the live daemon is ${livePid} — removing stale pidfile`);
      rmSync(pidFile, { force: true });
    }
  } else {
    print(`daemon: not reachable on 127.0.0.1:${cfg.daemonPort} — nothing to stop`);
    if (filePid !== null) {
      print(`daemon: removing stale pidfile (pid ${filePid} not verified as the daemon — not signalled)`);
      rmSync(pidFile, { force: true });
    }
  }
  return 0;
}
