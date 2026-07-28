# Agent Bridge — Claude Code + Codex v0 Design

**Updated:** July 13, 2026 · **Status:** active design

Phase 0 has been reopened on `codex/phase-0-two-agent`. This document replaces the original four-provider v0 scope while preserving its native-TUI architecture.

---

## 1. Goal

Agent Bridge coordinates **Claude Code and Codex in their native TUIs**, side by side in tmux. The human can focus either pane and type normally. A local daemon observes both agents through their semantic hook events, shows their current state, and later delivers inspectable handoffs and pair-workflow coordination without re-hosting either agent.

The first useful workflow is deliberately narrow:

1. launch Claude Code and Codex in two real panes;
2. know when each is working, idle, blocked, done, or errored;
3. hand work in either direction at the visible terminal boundary;
4. let them cooperate in isolated worktrees with a human-reviewable integration branch.

The core should leave room for configurable agent instances later, but v0 supports exactly two adapter kinds and defaults to one instance of each.

### Non-goals for active v0

- A unified chat UI that replaces either native TUI.
- OpenCode, Antigravity (`agy`), Grok, or another provider matrix.
- Headless/API/ACP operation as a substitute for an interactive agent pane.
- A general N-agent scheduler before the two-agent workflow is proven.
- Graphify, Obsidian, a web dashboard, or a second multiplexer backend.

---

## 2. Non-negotiable constraints

1. **Native TUIs stay alive and unmodified in real tmux panes.** The daemon dying must not terminate, pause, or corrupt either agent.
2. **Events over scraping.** Agent state comes from Claude Code and Codex hooks. `capture-pane` is reserved for previews, shell readiness, and injection echo-verification, never lifecycle inference.
3. **Injection happens at the terminal boundary.** Both agents receive text through tmux bracketed paste plus a single Enter. A handoff is never injected unless the target is idle.
4. **Local-only control plane.** The daemon and any future bridge-bus bind `127.0.0.1` only.
5. **Safe configuration writes.** Every writer prints a diff first, backs up an existing file, preserves unrelated settings, and is idempotent.
6. **Same behavior on macOS and WSL2 Ubuntu.** There is no native-Windows path and no `/mnt/c` assumption.
7. **Integration fidelity over mocks.** Mux tests use a real throwaway tmux server. Authenticated live-agent checks stay behind `BRIDGE_LIVE_TESTS=1` or an interactive verification script.

---

## 3. The architectural finding

The multiplexer is the body; hooks are the nervous system.

tmux provides real PTYs, native step-in, durable panes, previews, focus, and terminal injection. It does not decide whether an agent is working or waiting. Claude Code and Codex already emit semantic lifecycle events, so the daemon can observe them without guessing from prompt characters.

| Tool | Working / turn complete | Needs approval or input | Push path | Transcript | Input to live TUI |
|---|---|---|---|---|---|
| **Claude Code** | `UserPromptSubmit`, `Stop`, `StopFailure` | `PermissionRequest`; `Notification:permission_prompt`; `Notification:agent_needs_input` | Repo-local HTTP hooks; command shim for command-only `SessionStart` | `~/.claude/projects/<proj>/<session>.jsonl` | tmux terminal injection |
| **Codex** | `UserPromptSubmit`, `Stop` | `PermissionRequest`; `PostToolUse` clears a pending approval | Project-local `hooks.json` command shims POST to the daemon | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | tmux terminal injection |

Claude's passive `Notification:idle_prompt` reminder is stored as `raw` if an
already-loaded hook delivers it and never changes lifecycle state. It is not a
request for action: only permission prompts and explicit
`agent_needs_input` notifications move Claude to `needs_you`.

For a Claude tool approval, `PermissionRequest` supplies the authoritative
detail such as `Bash`. Claude may emit a generic
`Notification:permission_prompt` several seconds later; that notification
remains a fallback for notification-only consent prompts, but it cannot replace
an already-active, more specific pending detail or its displayed event source.
Daemon status retains the notification as the literal `lastEvent` while
`activeAttention` identifies the unresolved event that `bridge top` should
render. This keeps the pending row stable as `PermissionRequest … ⚠ Bash`
without hiding event recency from status consumers or SQLite history.

Claude Code currently emits no lifecycle hook when the operator presses Escape
or manually declines a permission dialog. `PermissionDenied` covers automatic
permission-mode denial, not a manual dialog decision. Agent Bridge therefore
does not guess that Claude is idle from elapsed time, pane contents, focus, or
an intercepted key: attention clears on the next trusted lifecycle event.
This may leave a stale `needs_you` row after Escape, but it preserves the
idle-only injection invariant. A future hook-only delayed recovery using
`Notification:idle_prompt` requires live proof that the notification cannot
arrive while a permission dialog remains open.

Codex lifecycle hooks are the sole active event path. Agent Bridge does **not** take over the user's global Codex `notify` setting. Active hooks live in the target project and still require one-time trust review through `/hooks`.

A fresh Codex TUI remains `launching` until its first submitted prompt. Current
Codex runs `SessionStart` inside that first turn immediately before
`UserPromptSubmit`, so there is no hook-only event for “the untouched input box
is drawn.” `bridge top` describes this honest pre-event state as `awaiting first
observed turn`; the same wording remains accurate when a restarted in-memory
daemon has not yet re-observed an existing TUI. Agent Bridge does not scrape
the pane or inject a warm-up turn to manufacture `idle`.

---

## 4. Identity model: instance versus adapter

The original code used one closed provider-name union for configuration, panes, adapters, events, and display. That makes “another pane” indistinguishable from “another provider.”

The active design separates two concepts:

- **`AgentId`** — the configured instance identity used by panes, status, tasks, handoffs, and history. It is a string unique within one bridge session.
- **`AgentKind`** — the adapter implementation that knows how to launch, initialize, and map native events. Active v0 kinds are `claude` and `codex`.

The default instances are:

| AgentId | AgentKind | Command |
|---|---|---|
| `claude` | `claude` | `claude` |
| `codex` | `codex` | `codex` |

Status and coordination are keyed by `AgentId`; adapter dispatch is keyed by `AgentKind`. A normalized event conceptually carries:

```ts
{
  agent: AgentId;
  kind: "claude" | "codex";
  type: NormalizedEventType;
  sessionId: string | null;
  ts: number;
  payload: { nativeType: string; body: unknown };
}
```

The lifecycle states remain:

```
launching | working | idle | needs_you | done | error
```

This boundary permits multiple configured instances later without pretending that unimplemented providers already exist. Supporting a new `AgentKind` remains a separate adapter decision.

---

## 5. Architecture

```
┌──────────────────────── tmux session: bridge ────────────────────────┐
│ ┌──────────────────────────┐  ┌──────────────────────────┐           │
│ │ claude (native TUI)      │  │ codex (native TUI)       │           │
│ │ AgentId: claude          │  │ AgentId: codex           │           │
│ └────────────┬─────────────┘  └────────────┬─────────────┘           │
│              │ hooks (HTTP + command)      │ project command shims    │
│ ┌────────────▼──────────────────────────────▼───────────────────────┐ │
│ │ bridged — loopback-only local daemon                             │ │
│ │ ingest · normalize · state registry · SQLite event history       │ │
│ └────────────┬──────────────────────────────┬───────────────────────┘ │
│ ┌────────────▼─────────────┐  ┌─────────────▼─────────────────────┐ │
│ │ bridge top              │  │ .bridge/ task and handoff files   │ │
│ │ two live status cards   │  │ later: bridge-bus coordination    │ │
│ └─────────────────────────┘  └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
        human: focus either pane and type using ordinary tmux
```

### `bridged`

One Bun process binds the daemon HTTP API to `127.0.0.1`. It accepts Claude Code and Codex hook payloads, maps them into the shared event vocabulary, appends them to SQLite, and folds them into an in-memory status registry. Default event databases are namespaced by target-repo path so session-local `AgentId` values cannot mix history across projects. Hook requests must return quickly and must not make an agent depend on daemon health.

The daemon exposes its config directory, source checkout, load-time source-content fingerprint, and composite config fingerprint in `/status`; the tmux session carries the same composite identity in a user option. Reuse, attach, display, and live verification require the exact loaded fingerprint, so a daemon started before an in-place source edit is stale even when its path is unchanged. Teardown is the deliberate exception: `bridge down` may retire a stale fingerprint only when the config directory still proves the same target, so a config edit cannot strand its old runtime; another target is always refused. Hook payloads without the configured working directory are acknowledged but ignored; real paths are compared so equivalent symlinked paths remain valid.

Transcript tailing can enrich later handoffs, but it is not required for Phase 0 state detection.

### Mux adapter

The mux layer creates a detached tmux session, launches one login shell per configured instance, waits for the shell prompt to exist, and types the user's normal TUI launch command into it. With the two defaults, `bridge up` selects a deterministic `even-horizontal` layout. Each pane stores its `AgentId` in durable backend metadata (`@agent-bridge-agent-id` in tmux); the visible pane title is only a best-effort initial label because native TUIs legitimately replace it.

Its responsibilities are intentionally small: create, split, list, capture, send, focus, identify, title, and tear down panes. The existing interface stays count-agnostic even though active v0 launches two panes.

### `bridge top`

The control board shows configured active-kind instances, their normalized state, last event and age, session prefix, and pending approval. A configured-but-disabled instance is shown dimmed; parked provider kinds do not appear.

---

## 6. Handoffs and pair coordination

### Handoffs

A handoff is a **file, then an injection**.

The engine writes a Markdown packet under `.bridge/handoffs/` with frontmatter such as `from`, `to`, `task`, `worktree`, and `branch`. The body contains a transcript-derived source summary, relevant diff statistics, and explicit instructions for the target. The packet is human-readable and is exactly what gets injected.

Per-task autonomy:

- **observe** — prepare the packet and stop;
- **approve** — prepare it and wait for a human confirmation; this is the default;
- **auto** — wait for the target's semantic idle event, then inject visibly.

Terminal delivery uses one bracketed paste, echo-verification, one retry if needed, then exactly one Enter. The human can always focus the pane or interrupt the agent normally.

### Shared task plane

After bidirectional handoffs work, a small loopback-only bridge-bus lets both TUIs use the same task records without relaying chat. Its tools cover task creation/claiming, progress updates, handoff reads, peer reads, and advisory path locks. Storage remains Markdown/JSON under `.bridge/`.

Graphify is not required for this shared plane.

### Pair workflow

`bridge pair <task> claude codex` creates two worktrees from an integration branch and sends role-framed versions of one brief. Typical roles are implementer/reviewer, implementation/test, or two competing approaches.

Agents post progress through the shared task plane and use advisory path leases when overlap is unavoidable. When both finish, the daemon merges the first branch into the integration branch and hands the second agent any conflict-resolution work. The human reviews the integration branch before it touches the real branch.

---

## 7. Substrate and stack

- **Mux:** tmux on both macOS and WSL2. Zellij remains parked unless native Windows becomes a real requirement.
- **Runtime:** TypeScript on Bun, including `bun:sqlite`. No framework or ORM.
- **CLI layout:** `src/cli`, `src/daemon`, `src/mux`, `src/adapters`, `scripts/`, and `docs/`.
- **Daemon port:** `4770` by default, bound to `127.0.0.1`.
- **Tests:** `bun test`, real tmux on a throwaway socket, authenticated live tests opt-in.

OpenCode's SDK and server were part of the original stack rationale but are no longer active v0 dependencies.

---

## 8. Reframed phase plan

Each phase is independently useful and gets its own branch.

### Phase 0 — Dual-TUI foundation (reopened; current)

`bridge up` launches Claude Code and Codex side by side. `bridge init` safely configures only their hook surfaces. `bridge top` displays two event-driven cards.

**Exit test:** both native TUIs are interactive; both transition working → idle; both surface permission prompts as `needs_you`; killing the daemon leaves both TUIs untouched; no lifecycle state comes from screen scraping. Verify on macOS, then WSL2.

### Phase 1 — Bidirectional handoffs

Build packets from transcript context plus diff statistics. Support Claude → Codex and Codex → Claude in approve mode, then idle-gated auto mode.

**Exit test:** either agent can finish a turn and visibly hand the next bounded task to the other without losing or racing terminal input.

### Phase 2 — Shared task plane

Add the minimal bridge-bus, file-backed task/update records, peer reads, and advisory path locks. Register it in both TUIs.

**Exit test:** both agents read and update one task thread without the human relaying messages.

### Phase 3 — Pair workflow

Add worktree creation, role-framed briefs, an integration branch, lock leases, and merge/conflict choreography.

**Exit test:** Claude Code and Codex build one feature in parallel worktrees and produce a human-reviewable integration branch.

### Phase 4 — Rate-aware routing

Use Claude and Codex's high-fidelity usage surfaces, show headroom in `bridge top`, and explain automatic placement. Poller failure must degrade gracefully and never block manual assignment.

**Exit test:** a new task routes to the healthier of the two subscriptions and reports why.

### Phase 5 — Extensibility and optional human layer

Generalize configured instance count where the proven workflow requires it. Evaluate additional adapter kinds, Graphify, Obsidian, or another presentation layer only against demonstrated needs.

---

## 9. Risks

**Injection races.** Terminal input can be lost while a TUI redraws. Semantic idle gating, bracketed paste, echo-verification, and one retry are load-bearing.

**Configuration ownership.** Hooks live in user or repo configuration. Writers must preserve unrelated settings and must not seize global Codex `notify`.

**Session attribution.** Project scope and `cwd` checks exclude other repos, but two simultaneous native sessions of the same kind in one target cwd are not distinguishable yet. Phase 0 assumes one live Claude session and one live Codex session in the managed cwd; native-session binding belongs in the handoff foundation.

**Two sessions are not one model context.** The agents coordinate through explicit packets, files, and later the bridge-bus. The design does not pretend to merge their internal conversations.

**Premature generalization.** `AgentId` versus `AgentKind` is the required seam; a dynamic plugin framework is not. The two-agent workflow must pass before N-agent breadth.

**Scope creep.** The project wins when Claude Code and Codex cooperate reliably in the TUIs the human already uses. Additional providers and dashboards are distractions until that loop works.

---

## 10. Explicitly parked

- OpenCode and its SSE/TUI HTTP special cases.
- Antigravity (`agy`) and its statusline/hook fallback research.
- Grok, which was never implemented.
- Graphify and Obsidian integration.
- Additional `AgentKind` adapters and generalized N-agent scheduling.
- Zellij, native-Windows support, web dashboards, and custom chat UIs.
- ACP or any other approach that replaces the native TUI.

The Git history and decision log retain the original research; parked scope is not active product behavior.

---

## 11. Reset and migration boundary

The origin/phase-0 object-shaped roster remains readable long enough to run `bridge down --legacy`, which retires a running four-agent session only after its old status shape, pidfile, process command, config directory, and pane titles agree. The next `bridge init` removes exact Agent-Bridge-owned global Codex notify/hook callbacks and exact agy blocks with the normal diff-and-backup writer. Foreign or modified entries are preserved. New runtime sessions, hook shims, and event databases are target-scoped.

---

## Sources

**Agent surfaces:** [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code statusline](https://code.claude.com/docs/en/statusline) · [Codex hooks](https://developers.openai.com/codex/hooks) · [Codex app-server](https://developers.openai.com/codex/app-server) · [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)

**Terminal substrate:** [tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode) · [tmux man page](https://man7.org/linux/man-pages/man1/tmux.1.html) · [iTerm2 tmux integration](https://iterm2.com/documentation-tmux-integration.html)

**Prior art and coordination:** [claude-squad](https://github.com/smtg-ai/claude-squad) · [agent-of-empires](https://github.com/njbrake/agent-of-empires) · [tmux-cli](https://github.com/pchalasani/claude-code-tools) · [git worktree](https://git-scm.com/docs/git-worktree)
