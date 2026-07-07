import { join } from "node:path";
import { stateDir } from "./config.ts";

export function daemonPidFile(): string {
  return join(stateDir(), "daemon.pid");
}

export function daemonLogFile(): string {
  return join(stateDir(), "daemon.log");
}
