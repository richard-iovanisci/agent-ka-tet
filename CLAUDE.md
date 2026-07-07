# Agent Bridge

Local supervisor for four coding-agent TUIs (Claude Code, Codex CLI, Antigravity `agy`, OpenCode) running in tmux panes. The human steps into any pane and types; a daemon observes via the agents' native hooks/event surfaces and injects handoffs at the terminal boundary. Full architecture: **DESIGN.md** (authoritative). Deviations: log in **DECISIONS.md** before implementing. Current phase: see **PROGRESS.md**.

## Non-negotiable constraints

1. Agent TUIs run **unmodified in real tmux panes**. Never launch an agent in headless/API/ACP mode as a substitute for its TUI. The daemon dying must never affect the agents.
2. **Events over scraping.** Agent state comes from hooks (Claude, Codex, agy) and OpenCode's SSE `/event` bus. `capture-pane` is for previews, echo-verification, and the agy fallback only.
3. **Injection = the terminal boundary.** tmux `send-keys` (bracketed paste, echo-verify, one retry) for claude/codex/agy; OpenCode via `POST /tui/append-prompt` + `/tui/submit-prompt`. Never inject unless the target's state is `idle`.
4. Daemon and bridge-bus bind **127.0.0.1 only**. Anything writing to a user's config file prints a diff first and backs up the original; all config writers are idempotent.
5. Works identically on **macOS and WSL2 (Ubuntu)**. No native-Windows code paths (WSL2 covers Windows). No `/mnt/c` assumptions.

## Stack & conventions

- TypeScript on **Bun** (`bun test`, `bun:sqlite`). No frameworks, no ORM; dependencies beyond Bun built-ins require asking first.
- Layout: `src/cli` (bridge command), `src/daemon` (ingest, state machine, HTTP), `src/mux` (MuxAdapter interface + tmux impl), `src/adapters` (per-agent: hook writers, event mappers, injection), `scripts/` (verify-phaseN.sh), `docs/`.
- Ports: daemon `4770`, OpenCode pinned `4096`. Normalized event: `{agent, type, sessionId, ts, payload}`. Agent states: `launching | working | idle | needs_you | done | error`.
- Tests run against a **real tmux server** (spawn one per test run with a throwaway socket: `tmux -L bridge-test`), not mocks. Live-agent tests behind `BRIDGE_LIVE_TESTS=1`.
- Small commits, imperative messages, one phase per branch.

## Key reference points (verified July 2026 — details in DESIGN.md §2, §4)

- Claude Code: hooks in `.claude/settings.json`, handler type `http`; transcripts at `~/.claude/projects/<proj>/<session>.jsonl`; statusline stdin JSON carries `rate_limits`.
- Codex: `~/.codex/hooks.json` (Claude-compatible events) + `notify` = `agent-turn-complete`; sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `codex app-server` JSON-RPC has `account/rateLimits/read`. Hooks need one-time `/hooks` trust approval.
- OpenCode: TUI always runs a local server; OpenAPI at `/doc`; SSE `/event`; `session.idle`, `permission.asked`; `@opencode-ai/sdk` exists — prefer it over hand-rolled clients.
- agy: weakest surface; hooks at `~/.gemini/antigravity-cli/hooks.json` and `<repo>/.agents/hooks.json` — check `docs/agy-notes.md` for verified event names before building; if absent, mark agy `mux-observed` and move on.
