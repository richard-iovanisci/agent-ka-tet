import { existsSync, readFileSync, rmSync } from "node:fs";
import type { BridgeConfig } from "../config.ts";
import { daemonPidFile } from "../paths.ts";
import type { MuxAdapter } from "../mux/adapter.ts";

export interface DownOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
}

export async function down(cfg: BridgeConfig, opts: DownOptions): Promise<number> {
  const print = opts.print ?? console.log;

  if (await opts.mux.hasSession(cfg.session)) {
    await opts.mux.killSession(cfg.session);
    print(`session "${cfg.session}" killed`);
  } else {
    print(`session "${cfg.session}" not running`);
  }

  const pidFile = daemonPidFile();
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
        print(`daemon: sent SIGTERM to pid ${pid}`);
      } catch {
        print(`daemon: pid ${pid} not running — removing stale pidfile`);
        rmSync(pidFile, { force: true });
      }
    } else {
      rmSync(pidFile, { force: true });
    }
  } else {
    print("daemon: not running (no pidfile)");
  }
  return 0;
}
