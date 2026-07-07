/**
 * `bridge` CLI dispatch. Subcommands land here as they are built:
 * up | down | attach | init | top
 */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
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
}

function printHelp(): void {
  console.log(`agent-bridge — supervisor for native coding-agent TUIs

usage: bridge <command>

commands:
  up       launch the tmux session (4 agent panes) and the daemon
  down     stop the daemon and tmux session
  attach   attach to the tmux session
  init     wire agent hook/event surfaces to the daemon (diff + backup first)
  top      live per-agent state board
`);
}
