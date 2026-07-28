# agent-bridge

Local supervisor for Claude Code and Codex CLI running **unmodified, side by side in real tmux
panes**. A localhost daemon observes both through their native hooks/event surfaces (zero screen
scraping) and shows live state in a single board. You step into either pane and type; the bridge
never gets between you and the agent. Configurable N-agent coordination can come later; Phase 0
deliberately makes this two-agent loop solid first.

Architecture and rationale: [DESIGN.md](DESIGN.md) · constraints: [CLAUDE.md](CLAUDE.md) ·
deviations: [DECISIONS.md](DECISIONS.md) · phase status: [PROGRESS.md](PROGRESS.md)

## Quick start

```sh
bun install
bun test

# in the repo you want the agents working on:
bun /path/to/agent-bridge/bin/bridge init   # wire hooks/events to the daemon (prints diffs, backs up)
bun /path/to/agent-bridge/bin/bridge up     # Claude + Codex side by side; daemon on 127.0.0.1:4770
bun /path/to/agent-bridge/bin/bridge top    # live state board: working / idle / NEEDS YOU / done
bun /path/to/agent-bridge/bin/bridge attach # enter the session (plain tmux from here on)
bun /path/to/agent-bridge/bin/bridge down   # intentionally terminate both hosted TUIs + daemon
```

Configuration: copy `bridge.config.example.jsonc` to `bridge.config.jsonc` (optional — defaults work).

One-time manual step after `bridge init` (the target project must already be trusted by Codex):

- **Codex**: run `/hooks` inside Codex once to trust the bridge hook (re-runs stay trusted).

## Verify

```sh
/path/to/agent-bridge/scripts/verify-phase0.sh static
/path/to/agent-bridge/scripts/verify-phase0.sh full   /path/to/target-repo
```

`full` is intentionally interactive. It validates target/config ownership before any signal, requires a typed confirmation before stopping the daemon, and installs an exit trap that attempts an existing-session-only daemon restore. If the original tmux identity changes, it refuses automatic recovery instead of recreating panes. Run it once on macOS and once inside WSL2.

## How state flows

| Agent | Surface | Transport |
|---|---|---|
| claude | repo-local hooks; command shim for `SessionStart`, HTTP otherwise | POST → `127.0.0.1:4770/events/claude` |
| codex | repo-local `.codex/hooks.json` command shims | shim curls the daemon |

Claude's one-minute `idle_prompt` notification is a passive reminder, so the
bridge no longer subscribes to it. If an already-loaded older hook still
delivers one, it is recorded without changing an already-idle session to
`NEEDS YOU`. Permission prompts and explicit `agent_needs_input` notifications
remain actionable.

Claude may follow a detailed tool `PermissionRequest` with a generic permission
notification several seconds later. The board keeps the original tool badge
(for example, `⚠ Bash`) and the original `PermissionRequest` label instead of
replacing either with generic notification text; the daemon still records the
notification as its literal latest event. A notification-only consent prompt
still surfaces as `NEEDS YOU`.

Pressing Escape in a Claude permission dialog is not exposed through Claude's
current lifecycle hooks: manual denial does not fire `PermissionDenied`.
Consequently the board may remain `NEEDS YOU` until the next prompt or another
trusted progress/completion hook arrives. The bridge intentionally does not
clear this on a timeout or by scraping/intercepting the native TUI, because a
false `idle` state would make later idle-gated injection unsafe.

Codex does not emit `SessionStart` until its first submitted turn. Before that
first prompt, `bridge top` therefore shows
`launching  awaiting first observed turn`; normal working/idle transitions
begin as soon as a prompt is sent. “Observed” also keeps the label honest after
a daemon-only restart resets its in-memory state behind an existing TUI.

`capture-pane` is used only inside the mux layer for previews and injection echo-verify — never as a state source.

Phase 0 assumes one live Claude session and one live Codex session in the managed target cwd. Hook payloads from another cwd are ignored; binding a pane to a native session id comes later.

## Migrating the old four-agent Phase 0

From the target repo, retire a still-running old baseline with:

```sh
bun /path/to/agent-bridge/bin/bridge down --legacy
```

The old object-shaped `agents` config remains readable for this migration, but replace it with the ordered two-entry array in `bridge.config.example.jsonc`. Then run `bridge init`: it removes only provably Agent-Bridge-owned global Codex `notify`/hook entries and agy blocks, with diffs and backups, before installing project-local Claude/Codex hooks. Modified or foreign entries are left untouched.
