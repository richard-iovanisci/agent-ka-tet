import { loadConfig } from "../config.ts";
import { TmuxAdapter } from "../mux/tmux.ts";
import { up } from "./up.ts";
import { down } from "./down.ts";
import { attach } from "./attach.ts";
import { runInit } from "./init.ts";
import { top } from "./top.ts";

const COMMAND_FLAGS = {
  up: new Set(["--existing-session-only"]),
  down: new Set(["--legacy"]),
  attach: new Set<string>(),
  init: new Set(["--dry-run"]),
  top: new Set(["--once"]),
} satisfies Record<string, ReadonlySet<string>>;

type BridgeCommand = keyof typeof COMMAND_FLAGS;

function isBridgeCommand(command: string): command is BridgeCommand {
  return Object.hasOwn(COMMAND_FLAGS, command);
}

/** `bridge` CLI dispatch: up | down | attach | init | top */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (!isBridgeCommand(cmd)) {
    console.error(`bridge: unknown command "${cmd}"`);
    printHelp();
    return 1;
  }
  const allowedFlags = COMMAND_FLAGS[cmd];

  const args = argv.slice(1);
  // Subcommand help must be handled before loading config or dispatching. In
  // particular, `bridge down --help` must never become a teardown request.
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
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
        const cfg = loadConfigWithMigrationNotice();
        return await up(cfg, {
          mux: new TmuxAdapter(),
          existingSessionOnly: flags.has("--existing-session-only"),
        });
      }
      case "down": {
        const cfg = loadConfigWithMigrationNotice();
        return await down(cfg, {
          mux: new TmuxAdapter(),
          allowLegacy: flags.has("--legacy"),
        });
      }
      case "attach": {
        const cfg = loadConfigWithMigrationNotice();
        return await attach(cfg, { mux: new TmuxAdapter() });
      }
      case "init": {
        const cfg = loadConfigWithMigrationNotice();
        return runInit(cfg, { dryRun: flags.has("--dry-run") });
      }
      case "top": {
        const cfg = loadConfigWithMigrationNotice();
        return await top(cfg, { once: flags.has("--once") });
      }
    }
  } catch (e) {
    console.error(`bridge ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function loadConfigWithMigrationNotice() {
  const cfg = loadConfig();
  if (cfg.legacyAgentsConfig) {
    console.error(
      "bridge: legacy object-shaped agents config detected; using only claude/codex — migrate to the ordered array shown in bridge.config.example.jsonc",
    );
  }
  return cfg;
}

function printHelp(): void {
  console.log(`agent-bridge — supervisor for native coding-agent TUIs

usage: bridge <command>

commands:
  up [--existing-session-only]
                   launch the session + daemon; recovery flag refuses to create panes
  down [--legacy]  kill this repo's tmux session and daemon; --legacy retires a verified four-agent baseline
  attach           attach to the tmux session
  init [--dry-run] wire agent hook/event surfaces to the daemon (diff + backup first)
  top [--once]     live per-agent state board (events only, no scraping)
`);
}
