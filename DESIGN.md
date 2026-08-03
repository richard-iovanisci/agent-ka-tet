# Agent Bridge — Claude Code + Codex v0 Design

**Updated:** July 31, 2026 · **Status:** Phase 1 active

Phase 0 passed its complete 44-check authenticated verification on both macOS
and WSL2. Phase 1 is active on `codex/phase-1-handoffs`. This document replaces
the original four-provider v0 scope while preserving its native-TUI
architecture.

---

## 1. Goal

Agent Bridge coordinates **Claude Code and Codex in their native TUIs**, side by side in tmux. The human can focus either pane and type normally. A local daemon observes both agents through their semantic hook events, shows their current state, and later delivers inspectable handoffs and pair-workflow coordination without re-hosting either agent.

The first useful workflow is deliberately narrow:

1. launch Claude Code and Codex in two real panes;
2. know when each is working, idle, blocked, done, or errored;
3. hand work in either direction at the visible terminal boundary;
4. let them cooperate in isolated worktrees with a human-reviewable integration branch.

The core should leave room for configurable agent instances later, but v0 supports exactly two adapter kinds and defaults to one instance of each.

### Operator-console north star

The long-term human surface is a terminal operator console in the spirit of
Claude Code's agents view, but spanning the two native TUI kinds without
absorbing either one. Its durable hierarchy is:

```
project → task/work item → group run → agent run → native session
```

A project owns task and handoff records. A task is the durable unit of human
intent; an individual prompt is only one turn within a native session. A group
run is a launched realization of a configured roster, initially exactly one
Claude Code pane and one Codex pane. An agent run binds one configured
`AgentId` to one managed pane/process and its currently observed native session.

The console is a projection over those records, not a second chat surface. It
may place unresolved permissions, input requests, and handoff approvals in a
global **Needs you** queue, then show working, ready, review, and completed work
under project/task sections. Agent lifecycle and task lifecycle stay separate:
native `Stop` means that an agent turn is idle, not that its task is complete.

Selecting a live agent focuses and attaches to its real tmux pane. If the TUI
is no longer running but its conversation is resumable, a future adapter-owned
action may launch the native tool's own resume/continue command with the exact
recorded session reference. Agent Bridge never reconstructs a conversation by
replaying text, and it never re-hosts the native terminal UI.

### Non-goals for active v0

- A unified chat UI that replaces either native TUI.
- OpenCode, Antigravity (`agy`), Grok, or another provider matrix.
- Headless/API/ACP operation as a substitute for an interactive agent pane.
- A general N-agent scheduler before the two-agent workflow is proven.
- A global multi-project supervisor in the Phase 1 handoff slice.
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

Phase 1 strengthens same-project attribution without changing either native
TUI. `bridge up` gives each managed process the configured `AgentId` and loaded
config fingerprint in process-scoped environment markers. Claude HTTP hook
headers expand the allowlisted process variables, and the Claude/Codex command
shims forward those markers with every event. The
daemon accepts an event only when the route `AgentId`, forwarded `AgentId`, and
forwarded fingerprint agree with its loaded configuration; missing, stale, or
mismatched markers receive the same fast empty success but do not enter history
or state. These markers establish managed-process provenance on the local
machine; they are attribution, not a remote authentication boundary.

The daemon exposes its config directory, source checkout, load-time source-content fingerprint, and composite config fingerprint in `/status`; the tmux session carries the same composite identity in a user option. Reuse, attach, display, and live verification require the exact loaded fingerprint, so a daemon started before an in-place source edit is stale even when its path is unchanged. Teardown is the deliberate exception: `bridge down` may retire a stale fingerprint only when the config directory still proves the same target, so a config edit cannot strand its old runtime; another target is always refused. Hook payloads without the configured working directory are acknowledged but ignored; real paths are compared so equivalent symlinked paths remain valid.

Session-matched transcript reads may enrich Phase 1 packets, but they never
establish lifecycle state.

Each daemon, database, config fingerprint, and tmux session remains an isolated
project runtime. A future multi-project operator console will aggregate a
registry of those cells and tolerate any cell being offline; Phase 1 does not
turn the current daemon into a machine-wide supervisor or allow one project's
identity, events, or failure to leak into another.

### Mux adapter

The mux layer creates a detached tmux session, launches one login shell per configured instance, waits for the shell prompt to exist, and types the user's normal TUI launch command into it. With the two defaults, `bridge up` selects a deterministic `even-horizontal` layout. Each pane stores its `AgentId` in durable backend metadata (`@agent-bridge-agent-id` in tmux); the visible pane title is only a best-effort initial label because native TUIs legitimately replace it.

While a bridge-launched native command is live, a separate pane option records
its AgentId, loaded fingerprint, random run token, and foreground wrapper PID.
The wrapper remains the foreground parent of the configured command and clears
the option on normal exit. Idle-gated delivery checks that PID is live and is
still owned by the same pane shell, so stale hook state cannot route a packet
into the shell after a native TUI exits. This marker does not infer lifecycle
state; hooks remain the sole authority for `working`, `idle`, and `needs_you`.

Its responsibilities are intentionally small: create, split, list, capture, send, focus, identify, title, and tear down panes. The existing interface stays count-agnostic even though active v0 launches two panes.

### `bridge top`

The control board shows configured active-kind instances, their normalized state, last event and age, session prefix, and pending approval. A configured-but-disabled instance is shown dimmed; parked provider kinds do not appear.

During the next phases this local, read-only board may gain handoff and task
sections, while `top --once` remains a scriptable status snapshot. The richer
keyboard-driven, multi-project surface is a later operator-console projection.
It enters agents by focusing/attaching their actual tmux panes; it does not draw
or proxy the Claude Code or Codex conversation.

---

## 6. Handoffs and pair coordination

### Handoffs

A handoff is a **file, then an injection**.

The first Phase 1 slice is explicit approve mode. It materializes a handoff from
the source agent's latest accepted semantic `Stop`, not from whichever
transcript happens to be newest when approval occurs. The Markdown packet under
`.bridge/handoffs/` freezes at least its packet id, source and target `AgentId`s,
source native-session id, source event id/sequence/timestamp, exact
`last_assistant_message`, source and target adapter kinds, and creation time.
Transcript context may enrich that snapshot only when it can be tied to the same
source session and completed turn. Git status, changed paths, and diff
statistics are a bounded repository snapshot taken when the packet is created;
they are context for the operator and target, not source-turn provenance.

Packet content is immutable after creation and bound to its receipt by SHA-256.
Preview and injection read that frozen packet by id, verify its persisted
content identity, and never re-resolve “latest”; if the source has progressed
and the operator wants newer context, the bridge creates a new packet. The
packet remains human-readable and its body is exactly what gets injected.

The broader handoff model reserves three autonomy modes; only approve mode is
active in the first Phase 1 slice:

- **observe** — prepare the packet and stop;
- **approve** — prepare it and wait for a human confirmation; this is the
  current/default Phase 1 slice;
- **auto** — wait for the target's semantic idle event, then inject visibly.

Approval names the immutable packet id. Immediately before delivery, the bridge
revalidates target ownership, managed-process liveness, and semantic idle state.
Terminal delivery uses one bracketed paste, adapter-aware verification that
proves exactly one new composer input, then exactly one Enter. The verifier may
open one additional observation window, but it never pastes the bytes twice;
otherwise the bridge fails closed after one paste.
It writes separate durable delivery state/receipt containing the packet id,
content digest, target native session, attempt/outcome, and distinct
approval/delivery timestamps. A create-only target reservation rejects
concurrent delivery attempts and remains held until a later same-session target
`turn.start` contains the packet's unique footer in its submitted prompt; the
provider turn token is stored in the receipt before release.
Missing correlation, any existing reservation, or an ambiguous crash fails
closed for explicit reconciliation; approve mode performs no implicit stale
takeover. The current CLI observes for two seconds after submission; a later
hook remains retained and requires a future explicit reconciliation surface,
which is deliberately outside this slice. That receipt proves
terminal-boundary delivery, not that the target understood or completed the
work. A failed, denied, stale, or crash-ambiguous attempt never mutates the
packet and is never silently replayed; retry or replacement is an explicit
operator action. The human can always focus the pane or interrupt the agent
normally.

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

### Phase 0 — Dual-TUI foundation (complete)

`bridge up` launches Claude Code and Codex side by side. `bridge init` safely configures only their hook surfaces. `bridge top` displays two event-driven cards.

**Exit test:** both native TUIs are interactive; both transition working → idle; both surface permission prompts as `needs_you`; killing the daemon leaves both TUIs untouched; no lifecycle state comes from screen scraping. The authenticated 44-check verifier passed on macOS and WSL2.

### Phase 1 — Bidirectional handoffs

Attribute events to the managed processes, bind them to their observed native
sessions, and build immutable packets from the latest accepted `Stop` plus
session-matched context and creation-time repository statistics. Support Claude → Codex and Codex →
Claude in explicit approve mode with durable terminal-delivery receipts. A
later Phase 1 increment may add idle-gated auto mode only after the approve path
passes its live safety checks.

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

### Phase 5 — Multi-project operator layer and proven extensibility

Aggregate isolated project runtimes into the operator console and generalize
configured instance count only where the proven Claude+Codex workflow requires
it. Additional adapter kinds remain outside the active product direction.

---

## 9. Risks

**Injection races.** Terminal input can be lost while a TUI redraws or collapsed
paste placeholders can hide the submitted bytes. Semantic idle gating,
bracketed paste, adapter-aware exact-single-paste verification, and refusing an
ambiguous observable are load-bearing.

**Configuration ownership.** Hooks live in user or repo configuration. Writers must preserve unrelated settings and must not seize global Codex `notify`.

**Session attribution and ordering.** Project scope and `cwd` checks exclude
other repos, while process-scoped markers distinguish the bridge-launched TUI
from another same-kind session in the same cwd. Session binding and idle state
must still reject compaction-sourced starts, stale terminal events, and delayed
completion hooks whose provider turn token does not match the active turn.
Session starts cannot rebind a managed projection while it is already working
or awaiting human input.

**Unmanaged same-project sessions.** Project-local hooks also execute in a TUI
launched independently in the same cwd. Phase 1's process-scoped AgentId and
config-fingerprint markers must be present and agree before such an event can
bind a native session or mutate managed state.

**Delivery ambiguity.** Echo verification proves that the paste reached the
pane, not that the agent accepted or understood it. Packets are immutable,
receipts state exactly what the terminal boundary proved, and a crash around
delivery must stop for explicit operator resolution rather than risk a duplicate
prompt.

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
- A machine-wide daemon that collapses isolated project runtimes.
- Zellij, native-Windows support, web dashboards, and custom chat UIs.
- ACP or any other approach that replaces the native TUI.

The Git history and decision log retain the original research; parked scope is not active product behavior.

---

## 11. Reset and migration boundary

The origin/phase-0 object-shaped roster remains readable long enough to run `bridge down --legacy`, which retires a running four-agent session only after its old status shape, pidfile, process command, config directory, and pane titles agree. The next `bridge init` removes exact Agent-Bridge-owned global Codex notify/hook callbacks and exact agy blocks with the normal diff-and-backup writer. Foreign or modified entries are preserved. New runtime sessions, hook shims, and event databases are target-scoped.

---

## Sources

**Agent surfaces:** [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code statusline](https://code.claude.com/docs/en/statusline) · [Codex hooks](https://learn.chatgpt.com/docs/hooks) · [Codex app-server](https://learn.chatgpt.com/docs/app-server) · [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

**Terminal substrate:** [tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode) · [tmux man page](https://man7.org/linux/man-pages/man1/tmux.1.html) · [iTerm2 tmux integration](https://iterm2.com/documentation-tmux-integration.html)

**Prior art and coordination:** [claude-squad](https://github.com/smtg-ai/claude-squad) · [agent-of-empires](https://github.com/njbrake/agent-of-empires) · [tmux-cli](https://github.com/pchalasani/claude-code-tools) · [git worktree](https://git-scm.com/docs/git-worktree)
