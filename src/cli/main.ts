import { loadConfig } from "../config.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { up } from "./up.ts";
import { down } from "./down.ts";
import { attach } from "./attach.ts";
import { runInit } from "./init.ts";
import { top } from "./top.ts";

/** `bridge` CLI dispatch: up | down | attach | init | top */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const flags = new Set(argv.slice(1));

  try {
    switch (cmd) {
      case "up":
        return await up(loadConfig(), { mux: new TmuxAdapter() });
      case "down":
        return await down(loadConfig(), { mux: new TmuxAdapter() });
      case "attach":
        return await attach(loadConfig(), { mux: new TmuxAdapter() });
      case "init":
        return runInit(loadConfig(), { dryRun: flags.has("--dry-run") });
      case "top":
        return await top(loadConfig(), { once: flags.has("--once") });
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        console.error(`bridge: unknown command "${cmd}"`);
        printHelp();
        return 1;
    }
  } catch (e) {
    console.error(`bridge ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function printHelp(): void {
  console.log(`agent-bridge — supervisor for native coding-agent TUIs

usage: bridge <command>

commands:
  up               launch the tmux session (one pane per agent) and the daemon
  down             kill the tmux session and stop the daemon
  attach           attach to the tmux session
  init [--dry-run] wire agent hook/event surfaces to the daemon (diff + backup first)
  top [--once]     live per-agent state board (events only, no scraping)
`);
}
