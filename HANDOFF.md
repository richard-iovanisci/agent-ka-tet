# Agent Bridge — Phase 0 Two-Agent Reframe

This is the implementation handoff for the active branch:

```
codex/phase-0-two-agent
```

Start from the implemented and reviewed four-provider Phase 0 baseline at `origin/phase-0`, but treat [DESIGN.md](DESIGN.md) and the July 13 decisions in [DECISIONS.md](DECISIONS.md) as the current contract. Do not complete or verify the old four-agent acceptance target.

---

## 1. Outcome

Phase 0 is complete when:

- `bridge up` launches **Claude Code and Codex only** in deterministic side-by-side tmux panes;
- both are their ordinary, interactive native TUIs;
- `bridge init` wires only their semantic lifecycle hooks;
- `bridge top` shows exactly the configured Claude and Codex instances;
- both move through working, idle, and needs-you states from events;
- killing the daemon has no effect on either TUI;
- the live verification passes on macOS, then WSL2.

OpenCode, `agy`, Grok, Graphify, and Obsidian are outside this phase.

---

## 2. Pre-flight

Required on the machine:

- `tmux` 3.2 or newer;
- Bun, jq, curl, and `ps`;
- `claude` installed and authenticated interactively;
- `codex` installed and authenticated interactively;
- the repo and agent tools inside the WSL filesystem on WSL2, never under `/mnt/c`.

Codex hooks require one-time review/trust through `/hooks`.

Before changing code:

1. read `DESIGN.md`, `CLAUDE.md` or `AGENTS.md`, and `DECISIONS.md` completely;
2. confirm the branch is `codex/phase-0-two-agent`;
3. preserve unrelated working-tree changes;
4. do not rewrite the historical OpenCode/`agy` decisions;
5. ask before adding a dependency beyond the existing Bun/TypeScript toolchain.

---

## 3. Implementation brief

### A. Separate instance identity from adapter kind

Replace the closed provider-name model with the conceptual boundary in DESIGN.md:

- `AgentId` identifies a configured pane/status/task instance;
- `AgentKind` selects the `claude` or `codex` adapter;
- defaults are one `claude` instance and one `codex` instance;
- status, pane association, and history are keyed by ID;
- init and event mapping dispatch by kind.

Do not build a plugin framework or arbitrary-provider loader in Phase 0. The goal is a clean seam, not generalized N-agent scheduling.

### B. Make the active provider set exactly two

Remove OpenCode and `agy` from active defaults, common unions, init dispatch, daemon startup, board rendering, and acceptance tests. In particular:

- the daemon must not start the OpenCode SSE reconnect loop;
- common registry logic must not special-case `agy`;
- active configuration must not require an OpenCode port;
- disabled parked-provider cards must not appear in `bridge top`.

Historical adapter code may be deleted or clearly archived, but it must not remain active runtime behavior.

### C. Launch deterministic side-by-side panes

`bridge up` must:

1. create one login-shell pane;
2. split one second pane;
3. select `even-horizontal`;
4. store `AgentId` in durable pane metadata and set it as a best-effort initial title;
5. wait for each shell to draw;
6. type the configured native TUI command with echo verification and one retry.

The pane survives if its agent exits. Re-running `bridge up` against an existing session must not disturb either pane.

### D. Initialize only the two hook surfaces

Claude Code uses repo-local `.claude/settings.json`. `SessionStart` is command-only in the current Claude hook contract, so it uses a short nonblocking command shim; the other active events use native HTTP handlers pointed at:

```
http://127.0.0.1:4770/events/<agent-id>
```

The active events cover session start/end, prompt submission, stop/failure, permission requests, auto-mode permission denial, post-tool permission clearing, and selected notifications. `permission_prompt` and `agent_needs_input` are actionable; the passive one-minute `idle_prompt` reminder is not subscribed, and a stale already-loaded handler delivering it maps to `raw` without leaving `idle`. A native `PermissionRequest` always supplies or upgrades the pending tool detail, while a later generic `permission_prompt` notification can supply detail only when no request is already active. Successful HTTP ingestion returns an empty `204` so Claude does not parse an arbitrary response as hook output.

Status keeps the literal newest event in `lastEvent` and separately tracks the
event responsible for unresolved human attention in `activeAttention`.
`bridge top` renders the latter while `needs_you`, so Claude's delayed generic
notification cannot change either `PermissionRequest` or `⚠ Bash`; event
history remains complete. Manual denial or Escape emits no Claude lifecycle
hook, so it cannot be cleared immediately without unsafe inference. The next
trusted progress/end event clears it. Do not replace that gap with a timeout,
pane scraping, transcript-derived lifecycle, or key interception.

Codex uses command handlers in the configured instance's project-local `.codex/hooks.json` for:

- `SessionStart`
- `UserPromptSubmit`
- `PermissionRequest`
- `PostToolUse`
- `Stop`

The active writer must not install or replace Codex's global `notify` setting. During the reset only, it removes exact entries previously owned by Agent Bridge from the old global hook/notify surfaces. All changes print diffs, back up originals, preserve unrelated content and mixed hook groups, and are idempotent.

Current Codex defers `SessionStart` until the first submitted turn, immediately
before `UserPromptSubmit`. Preserve `launching` before that point and render it
as `awaiting first observed turn`; this also covers an in-memory daemon
restarting behind an existing TUI. Do not infer lifecycle from pane contents or
inject a hidden warm-up prompt.

### E. Keep one shared event/state path

Both hook adapters map native payloads into the common lifecycle vocabulary. The daemon stores the original native body, appends the normalized event to SQLite, and updates the in-memory status for the corresponding `AgentId`.

Daemon status and tmux sessions carry the loaded config plus load-time source-content identity. `up`, `attach`, `top`, and the live verifier require the exact loaded fingerprint, including after in-place source edits. `down` refuses another target but may retire a stale fingerprint from the same config directory, so changing config cannot strand the old runtime. Default SQLite history is namespaced by target-repo path, and hook events with a missing, invalid, or different real `cwd` are ignored.

Unknown native events become `raw`; they are stored but cause no state transition. A malformed hook payload still gets a fast success response so the bridge never blocks an agent.

### F. Render the configured instances

`bridge top` renders two cards by default:

- ID and kind;
- state;
- last native event and age, or the stable unresolved-attention source while
  `needs_you`;
- session prefix;
- pending permission badge.

It must iterate configured instances rather than a hard-coded four-provider tuple.

### G. Reframe verification

Update the Phase 0 tests and interactive verification around Claude and Codex:

- default config contains the two active kinds;
- real-tmux CLI integration creates two panes;
- layout is horizontal;
- status exposes the two configured IDs;
- init is safe and idempotent for both adapters;
- daemon accepts and maps both lifecycle streams;
- the interactive script checks turn completion and permission prompts for both.

Keep generic mux coverage count-agnostic; a low-level test may still create more than two panes to prove the adapter scales.

Align the README, example config, and verification script during the implementation pass; none may retain the old four-provider defaults or acceptance target.

---

## 4. Phase 0 acceptance checklist

- [x] `bun test` passes.
- [x] Type checking passes.
- [x] Static verification finds no lifecycle scraping outside semantic hooks.
- [x] Real-tmux integration creates exactly two panes in an `even-horizontal` layout.
- [x] Claude Code opens normally and accepts direct human input.
- [x] Codex opens normally and accepts direct human input.
- [x] Init tests prove diff/backup behavior, foreign-setting preservation, mixed-group pruning, and idempotency.
- [x] Active Codex init does not install or replace `notify`; exact legacy-owned cleanup is separately covered.
- [x] Prompting Claude changes its board state working → idle.
- [x] Prompting Codex changes its board state working → idle.
- [x] A Claude permission request shows `needs_you`.
- [x] A Codex permission request shows `needs_you`.
- [x] Killing the daemon leaves both TUIs usable.
- [x] Real-tmux integration proves `bridge up` restores a missing daemon without replacing pane ids.
- [x] The live script passes on macOS.
- [ ] The live script passes inside WSL2.

The authenticated macOS run completed all 44 verifier checks again on July 28,
2026, including the idle-reminder and first-observed-turn fixes. Its only
follow-up was the delayed generic Claude permission notification replacing a
better badge and event label; both display-precedence paths now have automated
coverage and need only a targeted restart smoke check. Escape/manual denial is
a documented Claude hook gap and does not invalidate the event-driven
acceptance result.

Do not mark Phase 0 complete or merge it until the live checks pass on both target environments.

---

## 5. Next phases

After Phase 0:

1. **Bidirectional handoffs** — file-backed packets, approve mode, then idle-gated auto mode.
2. **Shared task plane** — task/update records, peer reads, and path locks available to both TUIs.
3. **Pair workflow** — two worktrees, role framing, integration branch, and merge choreography.
4. **Rate-aware routing** — choose between Claude and Codex based on subscription headroom.
5. **Extensibility** — configurable instance counts and optional additional kinds only after the two-agent loop is reliable.

Graphify and Obsidian do not block any of these milestones.

---

## 6. Standing process rules

- One phase per branch.
- Small commits with imperative messages.
- `DESIGN.md` is authoritative; log deviations in `DECISIONS.md` before implementation.
- Run mux behavior against real tmux, not mocks.
- Put authenticated agent checks behind explicit opt-in or the interactive verify script.
- Keep loopback binding and safe config writers non-negotiable.
- Preserve the native-TUI experience: if a design would replace, wrap, or invisibly control either TUI, stop.
