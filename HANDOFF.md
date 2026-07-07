# Agent Bridge — Handoff to Claude Code

Everything you need to hand this project to Claude Code for implementation. Targets: **macOS (iTerm2)** and **Windows via WSL2** — which means tmux is the only mux backend v0 needs; the Zellij backend from DESIGN.md Phase 5 is parked.

---

## 1. Pre-flight checklist (you, ~15 min)

**Repo setup**

- [ ] Create the repo (e.g., `agent-bridge`), clone it locally
- [ ] Copy `DESIGN.md`, `CLAUDE.md`, and this `HANDOFF.md` into the repo root; commit as `docs: design + handoff`
- [ ] Create empty `DECISIONS.md` (deviation log) and `PROGRESS.md` (phase tracker with `Current phase: 0`)

**Each machine (macOS, and inside WSL2 on Windows)**

- [ ] `tmux -V` (≥3.2; brew on Mac, `apt install tmux` in WSL) · `git --version` (≥2.5 for worktrees) · `bun --version` · `jq --version`
- [ ] All four agents installed **and authed once interactively**: `claude`, `codex`, `agy`, `opencode` (with Copilot connected via `/connect`)
- [ ] WSL2 only: repo and agents live **inside WSL** (`~/`, not `/mnt/c/...` — file-watch and I/O perf are bad on the mount, and hooks can't cross the Windows/WSL boundary). Windows Terminal profile just opens the WSL shell.
- [ ] macOS optional: iTerm2 if you want `tmux -CC` native panes later — irrelevant to the code

**One manual research task (5 min, browser)**

- [ ] Open `https://antigravity.google/docs/hooks` and `https://antigravity.google/docs/cli-overview` (JS-rendered; machines can't fetch them). Note the **exact hook event names**, hook JSON schema, and any transcript/session file location. Paste findings into `docs/agy-notes.md` in the repo. This is the single unverified integration surface in DESIGN.md — worth doing before Claude Code builds the agy adapter, but Phase 0 can start without it (agy degrades to mux-observed).

---

## 2. Kickoff prompt (paste into Claude Code in the repo)

```text
Read DESIGN.md and CLAUDE.md in full before writing any code.

You're implementing Phase 0 of Agent Bridge: the "see everything" milestone.
Deliverable: a daemon + CLI such that `bridge up` launches my four agent TUIs
(claude, codex, agy, opencode) in a 2x2 tmux session, `bridge init` wires
their hook/event surfaces to the daemon, and `bridge top` shows live per-agent
state (working / idle / needs-you / done) driven by events — zero screen
scraping (agy excepted, mux-fallback allowed).

Non-negotiable constraints (from DESIGN.md §1–2):
- The agent TUIs run unmodified in real tmux panes. Never wrap them in a
  headless/API mode. I step in by focusing a pane and typing.
- Agent state comes from their native hooks/servers: Claude Code hooks with
  the `http` handler type; Codex hooks.json (command shims that curl the
  daemon) + notify; OpenCode via SSE on its own server's /event endpoint.
- Daemon binds 127.0.0.1 only. TypeScript on Bun, bun:sqlite, no frameworks.
- Must work identically on macOS and WSL2 (Ubuntu). No native-Windows paths.

Build order:
1. Scaffold (src/{cli,daemon,mux,adapters}, bin/bridge, strict TS, bun test).
2. tmux adapter: new-session/split/send-keys/capture-pane/list-panes behind a
   MuxAdapter interface. Unit-test against a real tmux server (CI: tmux in
   a headless job), not mocks.
3. bridge.config.(jsonc): agent launch commands, cwd/worktree, daemon port
   (default 4770), opencode port (default 4096).
4. `bridge up` / `bridge down` / `bridge attach`.
5. Daemon: POST /events/:agent ingest → normalized event
   {agent, type, sessionId, ts, payload} → SQLite + in-memory state machine
   per agent (states: launching, working, idle, needs_you, done, error).
6. `bridge init`: idempotent writers for
   - .claude/settings.json hooks (Stop, StopFailure, Notification,
     PermissionRequest, SessionStart) with type "http" → http://127.0.0.1:4770/events/claude
   - ~/.codex/hooks.json (Stop, PermissionRequest, SessionStart) as command
     shims + notify=["bridge-notify-shim"] for agent-turn-complete
   - agy: ~/.gemini/antigravity-cli/hooks.json best-effort (see
     docs/agy-notes.md if present; otherwise skip and mark agy mux-observed)
   - opencode: ensure fixed --port in launch command; daemon subscribes to
     GET /event (SSE), maps session.idle / permission.asked / session.error.
   Print a diff of every config file before writing; back up originals.
7. `bridge top`: single-pane ANSI board (agent, state, last event, age,
   needs-you badge). Polling the daemon over HTTP is fine for v0.
8. scripts/verify-phase0.sh: the exit test from DESIGN.md §6 — walks me
   through prompting each agent and asserts the daemon saw SessionStart,
   turn-complete, and a permission request for each (agy may be partial).

Work in small commits. If you must deviate from DESIGN.md, stop and log the
what/why in DECISIONS.md first. Ask me before adding any dependency beyond
Bun built-ins. When you need a real agent authed or a real TUI running to
test, ask me rather than mocking around it — integration fidelity is the
whole point of this project.
```

---

## 3. Phase 0 acceptance checklist (you, after Claude Code says done)

- [ ] `bridge up` on a scratch repo → 2x2 tmux grid, all four TUIs interactive; I can Ctrl-b-arrow into any pane and type — nothing feels different from my manual setup
- [ ] `bridge init` printed diffs, backed up configs, and is safe to re-run
- [ ] Prompt each agent with something trivial → `bridge top` flips it working → idle within a few seconds of the turn ending
- [ ] Trigger a permission prompt (e.g., ask codex to run a shell command in on-request mode) → needs-you badge appears
- [ ] Kill the daemon → agents completely unaffected (they must never depend on bridge)
- [ ] `scripts/verify-phase0.sh` passes on **both** macOS and WSL2
- [ ] Nothing in the repo scrapes pane content except the agy fallback path

---

## 4. Per-phase kickoff one-liners (later sessions)

Each phase = fresh Claude Code session (or `/clear`), one branch, re-read DESIGN.md:

| Phase | Prompt seed |
|---|---|
| 1 | "Implement Phase 1 (handoffs) per DESIGN.md §4: packet builder from transcript JSONL + diffstat into .bridge/handoffs/, `bridge handoff <from> <to>` with approve mode, send-keys injection with bracketed paste + echo-verify + one retry; OpenCode injection via POST /tui/append-prompt + /tui/submit-prompt. Auto mode gated on the target's idle event." |
| 2 | "Implement Phase 2: the bridge-bus MCP server (create_task, claim_task, post_update, read_handoff, lock_paths/release_paths, read_peer) over stdio + streamable HTTP, storage as markdown/JSON in .bridge/; register it in all four agents' MCP configs via `bridge init`; add graphify server wiring per DESIGN.md §4." |
| 3 | "Implement Phase 3 (rate-limit router) per DESIGN.md §4 table: pollers as plugins with graceful degradation — Claude statusline tee + OAuth usage endpoint (180s min, claude-code UA), Codex JSONL token_count tail + app-server account/rateLimits/read, copilot_internal/user, antigravity-usage --json; bars in bridge top; `bridge assign` by weekly headroom." |
| 4 | "Implement Phase 4 (pair mode): `bridge pair <task> <a> <b>` → two worktrees off an integration branch, role-framed briefs, lock_paths leases via bridge-bus, merge choreography (first done → merge; second gets conflicts as a task). Per-task autonomy frontmatter." |

---

## 5. Standing process notes

**One phase per branch.** Merge only after the phase's verify script passes on both platforms. Update `PROGRESS.md` at merge.

**DESIGN.md is authoritative; DECISIONS.md is the release valve.** Claude Code proposes, logs, then implements deviations — this keeps drift visible instead of silent.

**Integration tests over mocks.** tmux is scriptable and free — tests should spin a real tmux server. Real-agent tests (auth required) live behind `BRIDGE_LIVE_TESTS=1` and `verify-phaseN.sh` scripts you run by hand.

**Cross-platform cadence.** Develop wherever you are; run the verify script on the other platform before merging each phase. The likely WSL2-specific bugs: PATH differences in tmux default-shell, `notify` shims needing `#!/usr/bin/env bash`, and anything accidentally touching `/mnt/c`.

**Known sharp edges to remind Claude Code about when it hits them** (all in DESIGN.md §7): send-keys losing trailing Enter (hence echo-verify), Codex hooks needing one-time `/hooks` trust approval per repo, Claude Code hooks requiring settings.json (the `/hooks` menu is read-only), OpenCode's random port unless pinned at launch.
