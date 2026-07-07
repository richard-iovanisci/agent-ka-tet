import { join } from "node:path";
import { stateDir } from "./config.ts";

/**
 * Pidfile/log are per-port so two daemons (two configs on different ports)
 * never clobber each other's lifecycle files.
 */
export function daemonPidFile(port: number): string {
  return join(stateDir(), `daemon-${port}.pid`);
}

export function daemonLogFile(port: number): string {
  return join(stateDir(), `daemon-${port}.log`);
}
