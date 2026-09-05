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
}

export async function down(cfg: BridgeConfig, opts: DownOptions): Promise<number> {
  const print = opts.print ?? console.log;
  let refused = false;
  const pidFile = daemonPidFile(cfg.daemonPort);
  const filePid = existsSync(pidFile)
    ? Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    : null;
  const status = await fetchDaemonStatus(cfg.daemonPort);
  const livePid = status?.daemon.pid;

  if (await opts.mux.hasSession(cfg.session)) {
    const marker = parseBridgeSessionMarker(await opts.mux.getSessionMarker(cfg.session));
    if (marker?.configDir !== cfg.configDir) {
      refused = true;
      print(`session "${cfg.session}" is not owned by this target repo — REFUSING to kill it`);
    } else {
      await opts.mux.killSession(cfg.session);
      print(`session "${cfg.session}" killed`);
      if (marker.configFingerprint !== configFingerprint(cfg)) {
        print("session: configuration changed since launch; ownership matched by config directory");
      }
    }
  } else {
    print(`session "${cfg.session}" not running`);
  }

  if (status !== null && !daemonBelongsToConfig(status, cfg)) {
    refused = true;
    print(`daemon: pid ${status.daemon.pid} on port ${cfg.daemonPort} belongs to another target repo — REFUSING to signal it`);
  } else if (
    status !== null &&
    Number.isInteger(livePid) &&
    livePid !== undefined &&
    livePid > 1 &&
    filePid === livePid
  ) {
    try {
      process.kill(livePid, "SIGTERM");
      print(`daemon: sent SIGTERM to pid ${livePid} (verified by config identity, /status, and pidfile)`);
    } catch (e) {
      refused = true;
      print(`daemon: could not signal pid ${livePid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (status !== null) {
    refused = true;
    print(`daemon: live pid ${String(livePid)} does not match pidfile ${String(filePid)} — REFUSING to signal either`);
  } else {
    print(`daemon: not reachable on 127.0.0.1:${cfg.daemonPort} — nothing to stop`);
    if (filePid !== null) {
      // A stale pidfile cannot establish ownership of a recycled PID.
      print(`daemon: removing stale pidfile (pid ${filePid} not verified as the daemon — not signalled)`);
      rmSync(pidFile, { force: true });
    }
  }
  return refused ? 1 : 0;
}
