import type { BridgeConfig } from "../../config.ts";
import type { InitOptions } from "../initCommon.ts";

/**
 * OpenCode needs no config written: its TUI always runs a local server and the
 * daemon subscribes to the SSE /event bus. The one requirement is a
 * deterministic port — the binary's real default is 0/random (DECISIONS.md
 * 2026-07-07), so the launch command must always pin --port and --hostname.
 */

/** Compose the pane launch command, pinning port/hostname if absent. */
export function composeOpencodeCommand(cfg: BridgeConfig): string {
  let cmd = cfg.agents.opencode.command;
  if (!/(^|\s)--port(\s|=)/.test(cmd)) cmd += ` --port ${cfg.opencodePort}`;
  if (!/(^|\s)--hostname(\s|=)/.test(cmd)) cmd += " --hostname 127.0.0.1";
  return cmd;
}

export function initOpencode(cfg: BridgeConfig, opts: InitOptions = {}): void {
  const print = opts.print ?? console.log;
  print(`opencode: nothing to write — events arrive via SSE on the TUI's own server`);
  print(`opencode: daemon subscribes to http://127.0.0.1:${cfg.opencodePort}/event`);
  print(`opencode: launch command used by bridge up: ${composeOpencodeCommand(cfg)}`);
}
