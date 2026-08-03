# Agent Bridge

Local coordinator for **Claude Code and Codex in their native TUIs**, running side by side in tmux. A loopback daemon observes semantic lifecycle hooks and later injects inspectable handoffs at the terminal boundary. The human can focus either pane and type normally.

`DESIGN.md` is authoritative. Log deviations in `DECISIONS.md` before implementation. Track the active phase in `PROGRESS.md`. Current work is Phase 1 approve-mode bidirectional handoffs on `codex/phase-1-handoffs`.

## Non-negotiable constraints

1. Agent TUIs run unmodified in real tmux panes. Never replace them with headless/API/ACP sessions. Daemon failure must not affect either TUI.
2. State comes from Claude Code and Codex hooks, not prompt scraping. `capture-pane` is for previews, shell readiness, and injection echo-verification only.
3. Injection uses one tmux bracketed paste, adapter-aware exact-single-paste verification, and one Enter. The only automatic retry is a second observation window; never paste the bytes twice. Never inject unless the target is idle.
4. Daemon and future bridge-bus services bind `127.0.0.1` only.
5. Config writers print diffs, back up originals, preserve unrelated settings, and are idempotent.
6. Behavior must match on macOS and WSL2 Ubuntu. No native-Windows or `/mnt/c` paths.

## Active model

- `AgentId` is a configured instance identity used for panes, state, tasks, and history.
- `AgentKind` selects an adapter. Active v0 kinds are `claude` and `codex`.
- Defaults are one instance of each, with IDs `claude` and `codex`.
- Keep the core count-aware, but do not build generalized N-agent scheduling in Phase 1.
- Normalized states are `launching | working | idle | needs_you | done | error`.

## Stack and conventions

- TypeScript on Bun (`bun test`, `bun:sqlite`); no framework or ORM. Ask before adding dependencies beyond the existing toolchain.
- Layout: `src/cli`, `src/daemon`, `src/mux`, `src/adapters`, `scripts/`, and `docs/`.
- Default daemon port: `4770`, loopback only.
- Tests use a real throwaway tmux server, not mux mocks. Authenticated live tests require explicit opt-in.
- Small commits, imperative messages, one phase per branch.

## Active integration surfaces

- **Claude Code:** repo-local `.claude/settings.json`; native `http` hooks; transcripts under `~/.claude/projects/<proj>/<session>.jsonl`.
- **Codex:** project-local `.codex/hooks.json` command handlers for lifecycle events; sessions under `~/.codex/sessions`; `/hooks` trust is bound to the exact hook definition, so changed definitions require review. Do not install or replace the user's global `notify` setting.
- **Claude Code:** `SessionStart` is command-only; the remaining active lifecycle handlers use repo-local HTTP hooks and expect empty 2xx responses.
- Phase 1 attributes hooks to the exact bridge-launched process and binds each pane to validated native-session events. Reuse requires an exact daemon/tmux config and load-time source-content fingerprint; teardown may accept a stale fingerprint only when the config directory still proves the same target.
- Both receive live-TUI input through tmux at the terminal boundary.

## Phase order

- Phase 0 — Dual-TUI foundation.
- Phase 1 — Bidirectional handoffs.
- Phase 2 — Shared task plane.
- Phase 3 — Pair workflow with worktrees and an integration branch.
- Phase 4 — Rate-aware routing between Claude and Codex.
- Phase 5 — Multi-project operator layer and proven extensibility.

## Parked

OpenCode, Antigravity (`agy`), Grok, Graphify, Obsidian, Zellij, web dashboards, additional adapter kinds, and generalized N-agent scheduling are not active v0 scope. Grok was never implemented. Preserve historical research in Git and the decision log, but do not keep parked providers wired into defaults, daemon startup, UI, or acceptance tests.
