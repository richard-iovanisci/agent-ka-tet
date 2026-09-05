import { loadConfig } from "../config.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { up } from "./up.ts";
import { down } from "./down.ts";
import { attach } from "./attach.ts";
import { runInit } from "./init.ts";
import { top } from "./top.ts";
import { handoff, type HandoffArgs } from "./handoff.ts";
import { pilotMain } from "../pilot/cli.ts";

const COMMAND_FLAGS = {
  up: new Set(["--existing-session-only"]),
  down: new Set<string>(),
  attach: new Set<string>(),
  init: new Set(["--dry-run"]),
  top: new Set(["--once"]),
} satisfies Record<string, ReadonlySet<string>>;

type BridgeCommand = keyof typeof COMMAND_FLAGS;

function isBridgeCommand(command: string): command is BridgeCommand {
  return Object.hasOwn(COMMAND_FLAGS, command);
}

export function parseHandoffArgs(args: string[]): HandoffArgs {
  const positionals: string[] = [];
  let task: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--task") {
      if (task !== null) throw new Error('duplicate option "--task"');
      const value = args[++i];
      if (value === undefined || value.trim().length === 0) {
        throw new Error('option "--task" requires a non-empty value');
      }
      task = value.trim();
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
    positionals.push(arg);
  }
  if (positionals.length !== 2) {
    throw new Error("expected exactly <from-agent> <to-agent>");
  }
  if (task === null) throw new Error('missing required option "--task"');
  return { from: positionals[0]!, to: positionals[1]!, task };
}

/** `bridge` CLI dispatch for lifecycle, display, and handoff commands. */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (cmd === "pilot") return pilotMain(argv.slice(1));

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (cmd !== "handoff" && !isBridgeCommand(cmd)) {
    console.error(`bridge: unknown command "${cmd}"`);
    printHelp();
    return 1;
  }

  const args = argv.slice(1);
  // Subcommand help must be handled before loading config or dispatching. In
  // particular, `bridge down --help` must never become a teardown request.
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (cmd === "handoff") {
    let handoffArgs: HandoffArgs;
    try {
      handoffArgs = parseHandoffArgs(args);
    } catch (error) {
      console.error(
        `bridge handoff: ${error instanceof Error ? error.message : String(error)}`,
      );
      printHelp();
      return 2;
    }
    try {
      const cfg = loadConfig();
      return await handoff(cfg, handoffArgs, { mux: new TmuxAdapter() });
    } catch (error) {
      console.error(
        `bridge handoff: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  const allowedFlags = COMMAND_FLAGS[cmd];
  const invalid = args.find((arg) => !allowedFlags.has(arg));
  if (invalid !== undefined) {
    console.error(`bridge ${cmd}: unknown option or argument "${invalid}"`);
    printHelp();
    return 2;
  }
  const flags = new Set(args);

  try {
    switch (cmd) {
      case "up": {
        const cfg = loadConfig();
        return await up(cfg, {
          mux: new TmuxAdapter(),
          existingSessionOnly: flags.has("--existing-session-only"),
        });
      }
      case "down": {
        const cfg = loadConfig();
        return await down(cfg, {
          mux: new TmuxAdapter(),
        });
      }
      case "attach": {
        const cfg = loadConfig();
        return await attach(cfg, { mux: new TmuxAdapter() });
      }
      case "init": {
        const cfg = loadConfig();
        return runInit(cfg, { dryRun: flags.has("--dry-run") });
      }
      case "top": {
        const cfg = loadConfig();
        return await top(cfg, { once: flags.has("--once") });
      }
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
  pilot            prepare, inspect, and run a named native-messaging pilot; see pilot --help
  up [--existing-session-only]
                   launch the session + daemon; recovery flag refuses to create panes
  down             kill this repo's tmux session and daemon
  attach           attach to the tmux session
  init [--dry-run] wire agent hook/event surfaces to the daemon (diff + backup first)
  top [--once]     live per-agent state board (events only, no scraping)
  handoff <from> <to> --task <text>
                   prepare, preview, approve, and idle-gated deliver a handoff
`);
}
