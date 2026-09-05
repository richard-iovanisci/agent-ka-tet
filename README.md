# Agent Bridge

Coordinate Claude Code and Codex in their native interactive TUIs, side by side in tmux.
The operator can enter either session and type normally.

**macOS prototype in progress.** A live Codex → Claude → Codex nonce exchange passed in
native TUIs. Task/review orchestration and configurable fleets come next.
Windows and Linux, including WSL2, follow a working macOS prototype.

## Develop

Install Bun, tmux 3.2+, Claude Code, and Codex. From this checkout:

```sh
bun install
./scripts/check.sh
```

## Native messaging pilot

Authenticate Claude Code and Codex normally. Prepare a new disposable directory and read
its generated `PLAN.md` before launching authenticated sessions:

```sh
bun bin/bridge pilot prepare /tmp/my-bridge-pilot
```

Follow `PLAN.md` to open the setup Codex TUI, trust the disposable project and its `/hooks`,
then exit without sending a prompt. Trust must precede the private host. Continue with:

```sh
bun bin/bridge pilot launch /tmp/my-bridge-pilot --live
bun bin/bridge pilot attach /tmp/my-bridge-pilot
```

Review native trust, development Channel, MCP, and Codex `/hooks` prompts. Detach with
**Ctrl-b d**, then confirm both TUIs are usable:

```sh
bun bin/bridge pilot ready /tmp/my-bridge-pilot claude
bun bin/bridge pilot ready /tmp/my-bridge-pilot codex
bun bin/bridge pilot start /tmp/my-bridge-pilot
bun bin/bridge pilot status /tmp/my-bridge-pilot
bun bin/bridge pilot stop /tmp/my-bridge-pilot
```

The pilot requests one Codex → Claude → Codex nonce exchange. It uses separate worktrees,
a private Codex host, a Claude development Channel, and authenticated Bridge MCP tools.
It explicitly enables experimental legacy history at Codex startup for the tested build.
Claude's private pilot settings allow only the five Bridge tools; Codex tool approvals stay native.
Receipts distinguish native delivery from recipient read/ACK. Ambiguous attempts stay held.
Native permissions remain in the TUIs; entering a session pauses Bridge delivery to it.

The earlier `init`, `up`, `top`, `attach`, `handoff`, and `down` commands remain available
for operator-approved handoffs. Run `bun bin/bridge --help` for their usage.

[Design contract](DESIGN.md) · [Implementation status](PROGRESS.md) · [Contributor instructions](AGENTS.md)
