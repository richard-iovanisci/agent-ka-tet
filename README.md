# agent-bridge

Local supervisor for four coding-agent TUIs — Claude Code, Codex CLI, Antigravity (`agy`),
and OpenCode — running **unmodified in real tmux panes**. A localhost daemon observes them
through their native hooks/event surfaces (zero screen scraping) and shows live state in a
single board. You step into any pane and type; the bridge never gets between you and the agent.

Architecture and rationale: [DESIGN.md](DESIGN.md) · constraints: [CLAUDE.md](CLAUDE.md) ·
deviations: [DECISIONS.md](DECISIONS.md) · phase status: [PROGRESS.md](PROGRESS.md)

## Quick start

```sh
bun install
bun test

# in the repo you want the agents working on:
bun /path/to/agent-bridge/bin/bridge init   # wire hooks/events to the daemon (prints diffs, backs up)
bun /path/to/agent-bridge/bin/bridge up     # tmux session, one pane per agent, daemon on 127.0.0.1:4770
bun /path/to/agent-bridge/bin/bridge top    # live state board: working / idle / NEEDS YOU / done
bun /path/to/agent-bridge/bin/bridge attach # enter the session (plain tmux from here on)
bun /path/to/agent-bridge/bin/bridge down   # kill session + daemon (agents never depend on either)
```

Configuration: copy `bridge.config.example.jsonc` to `bridge.config.jsonc` (optional — defaults work).

One-time manual steps after `bridge init`:
- **codex**: run `/hooks` inside codex once to trust the bridge hook (re-runs stay trusted).
- **agy**: point its statusline at the printed forwarder script (see `docs/agy-notes.md` §5).

## Verify

```sh
scripts/verify-phase0.sh          # interactive exit test (DESIGN.md §6)
scripts/verify-phase0.sh static   # static checks only
```

## How state flows

| Agent | Surface | Transport |
|---|---|---|
| claude | native hooks, `http` handlers | POST → `127.0.0.1:4770/events/claude` |
| codex | hooks.json command shims + `notify` | shim curls the daemon |
| agy | statusline stdin feed + PreToolUse/PostToolUse/Stop shims | shim curls the daemon |
| opencode | its own server's SSE `/event` bus | daemon subscribes (port pinned to 4096) |

`capture-pane` is used only inside the mux layer for previews and injection echo-verify — never as a state source.
