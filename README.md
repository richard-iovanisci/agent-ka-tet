# Agent Bridge

Coordinate Claude Code and Codex in their native interactive TUIs, side by side in tmux.
The operator can enter either session and type normally.

Development and execution currently target **macOS only**. The existing implementation
launches one Claude and one Codex, observes semantic lifecycle events, displays their
state, and delivers operator-approved handoffs. Native peer routes and the durable
task/review loop are under implementation; their live acceptance gates have not passed.
Windows and Linux, including WSL2, follow the working macOS prototype.

## Use the current implementation

Install Bun, tmux 3.2 or newer, Claude Code, and Codex; authenticate the native agents.
From this source checkout:

```sh
bun install
bun test
bun run typecheck
```

From the project where the agents will work, use the absolute path to this checkout:

```sh
bun /path/to/agent-bridge/bin/bridge init --dry-run
bun /path/to/agent-bridge/bin/bridge init
bun /path/to/agent-bridge/bin/bridge up
bun /path/to/agent-bridge/bin/bridge top
bun /path/to/agent-bridge/bin/bridge attach
```

`init` prints configuration diffs and creates backups. In the trusted target project,
review the installed Codex hook definitions using `/hooks` inside Codex.
Configuration is optional; see [bridge.config.example.jsonc](bridge.config.example.jsonc).

After both sessions are observed and the source completes a turn, a separate terminal can run:

```sh
bun /path/to/agent-bridge/bin/bridge handoff claude codex --task "Review this result"
bun /path/to/agent-bridge/bin/bridge down
```

`handoff` previews the frozen packet and requires its exact delivery confirmation,
an empty composer, and a semantically idle target. `down` terminates this project's
managed native TUIs and coordinator. Run `bridge --help` for the complete current CLI.

[Design contract](DESIGN.md) · [Implementation status](PROGRESS.md) · [Contributor instructions](AGENTS.md)
