# agent-bridge

Local supervisor for Claude Code and Codex CLI running **unmodified, side by side in real tmux
panes**. A localhost daemon observes both through their native hooks/event surfaces (zero screen
scraping) and shows live state in a single board. You step into either pane and type; the bridge
never gets between you and the agent. Phase 0's authenticated 44-check verifier passes on macOS
and WSL2; Phase 1's approve-mode handoff path has passed authenticated native-TUI acceptance on
macOS, with the equivalent WSL2 run pending.

Architecture and rationale: [DESIGN.md](DESIGN.md) · constraints: [CLAUDE.md](CLAUDE.md) ·
deviations: [DECISIONS.md](DECISIONS.md) · phase status: [PROGRESS.md](PROGRESS.md)

The long-term terminal operator console will organize work as project → task →
group run → agent run → native session, with a cross-cutting Needs-you queue.
Selecting an agent enters its real tmux pane; future resume actions will use the
native tool's recorded session mechanism. The current implementation remains
one project-local Claude+Codex runtime—there is no replacement chat UI or
multi-project supervisor yet.

## Quick start

```sh
bun install
bun test

# in the repo you want the agents working on:
bun /path/to/agent-bridge/bin/bridge init   # wire hooks/events to the daemon (prints diffs, backs up)
bun /path/to/agent-bridge/bin/bridge up     # Claude + Codex side by side; daemon on 127.0.0.1:4770
bun /path/to/agent-bridge/bin/bridge top    # live state board: working / idle / NEEDS YOU / done
bun /path/to/agent-bridge/bin/bridge attach # enter the session (plain tmux from here on)

# From a separate non-tmux terminal, after the source has completed a turn and
# both native sessions are observed:
bun /path/to/agent-bridge/bin/bridge handoff claude codex --task "Review and continue this result"
bun /path/to/agent-bridge/bin/bridge handoff codex claude --task "Implement the review findings"

bun /path/to/agent-bridge/bin/bridge down   # intentionally terminate both hosted TUIs + daemon
```

`bridge handoff` freezes the source's latest completed turn, prints the exact
packet, and requires `DELIVER <packet-id>` before it can submit to the target.
It rechecks the target's native session, hook-derived idle state, managed pane
process, packet digest, and target delivery reservation immediately before the
single bracketed paste. Adapter-aware verification must prove exactly one input
before Enter; an ambiguous paste fails closed. Artifacts and receipts remain under
`.bridge/handoffs/` for inspection.

Configuration: copy `bridge.config.example.jsonc` to `bridge.config.jsonc` (optional — defaults work).

One-time manual step after `bridge init` (the target project must already be trusted by Codex):

- **Codex**: run `/hooks` inside Codex to trust the exact bridge hook definition.
  Identical re-runs stay trusted; any definition change requires review again.

## Verify

```sh
/path/to/agent-bridge/scripts/verify-phase0.sh static
/path/to/agent-bridge/scripts/verify-phase0.sh full   /path/to/target-repo

# Portability regression for tmux format parsing:
LC_ALL=C bun test
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
begin as soon as a prompt is sent. After a daemon-only restart, either existing
TUI may show that same label until its next genuine semantic turn because the
new in-memory registry does not infer idle or replay stale state. Here,
`launching` describes what the current daemon has observed, not whether the
native TUI process is running or usable.

`capture-pane` is used only inside the mux layer for previews and injection echo-verify — never as a state source.

Phase 0 assumes one live Claude session and one live Codex session in the managed target cwd. Hook payloads from another cwd are ignored; Phase 1 adds managed-process provenance and exact native-session binding before handoff delivery.

## Migrating the old four-agent Phase 0

From the target repo, retire a still-running old baseline with:

```sh
bun /path/to/agent-bridge/bin/bridge down --legacy
```

The old object-shaped `agents` config remains readable for this migration, but replace it with the ordered two-entry array in `bridge.config.example.jsonc`. Then run `bridge init`: it removes only provably Agent-Bridge-owned global Codex `notify`/hook entries and agy blocks, with diffs and backups, before installing project-local Claude/Codex hooks. Modified or foreign entries are left untouched.
