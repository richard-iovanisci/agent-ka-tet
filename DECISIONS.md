# Decisions — deviation log

Deviations from DESIGN.md are logged here **before** implementation. Format: date, what, why, impact.

---

## 2026-07-07 — Dev-only dependencies: `typescript` + `@types/bun`

**What:** package.json carries two devDependencies. Runtime remains Bun built-ins only.
**Why:** the kickoff requires *strict TS*; Bun transpiles but does not typecheck, so `tsc --noEmit` needs the compiler and Bun's type declarations. Neither ships at runtime.
**Impact:** none on the running tool; `bun install` fetches dev tooling only.

## 2026-07-07 — Claude/Codex hook sets extended with `UserPromptSubmit` + `PostToolUse`

**What:** `bridge init` registers `UserPromptSubmit` and `PostToolUse` in addition to HANDOFF.md's five (Stop, StopFailure*, Notification*, PermissionRequest, SessionStart). (*Codex has no StopFailure/Notification events — verified against developers.openai.com/codex/hooks July 2026.)
**Why:** the Phase 0 exit test requires `bridge top` to flip *working → idle*. Without `UserPromptSubmit` there is no event that ever puts an agent in `working`; without `PostToolUse` a granted permission leaves the board stuck on `needs_you` until end of turn.
**Impact:** two more low-cost localhost POSTs per turn/tool-call; state board reflects reality.

## 2026-07-07 — OpenCode launch always pins `--port` + `--hostname 127.0.0.1`

**What:** DESIGN.md says "pin it with `--port`"; docs claim `serve` defaults to 4096. Verified against the local binary (v1.17.15): the default is port **0 (random)** for both TUI and serve. Writers/launchers therefore always pass both flags explicitly.
**Why:** daemon must find the SSE `/event` bus deterministically.
**Impact:** none for the user; `bridge up` composes the flags if absent from the configured command.

## 2026-07-07 — OpenCode permission events: subscribe to v1 *and* v2 names

**What:** v1.17.15 emits both `permission.asked`/`permission.replied` and `permission.v2.asked`/`permission.v2.replied` (different payload shapes). The mapper handles both; `permission.updated` (older name in some docs) does not exist and is not used.
**Why:** missing either family drops needs-you events across OpenCode versions.
**Impact:** duplicate events for one prompt are possible; the state machine is idempotent under them.

## 2026-07-07 — agy: statusline forwarder as primary state feed; hooks at `~/.gemini/config/hooks.json`

**What:** (a) agy's primary state signal is a statusline-customization forwarder (stdin JSON carries `agent_state: initializing|idle|thinking|working|tool_use`) teed to the daemon, with `PreToolUse`/`PostToolUse`/`Stop` command-shim hooks as secondary; (b) the canonical global hooks path is `~/.gemini/config/hooks.json` — DESIGN.md's `~/.gemini/antigravity-cli/hooks.json` is the legacy/buggy location (upstream issue #49), so the writer targets the canonical path (details + evidence remain at `origin/phase-0:docs/agy-notes.md`); (c) agy hook shims append `?native=<Event>` when POSTing because agy payloads are not verified to carry an event-name field.
**Why:** agy has no PermissionRequest/SessionStart hook equivalents; the statusline feed is the only verified push-based idle/working signal. Still zero scraping.
**Impact:** agy `needs_you` detection stays partial in Phase 0 (allowed by HANDOFF.md exit criteria); everything else is event-driven.

## 2026-07-13 — Reset v0 around Claude Code + Codex

**What:** The active product and Phase 0 acceptance target are now two native TUIs: Claude Code and Codex, side by side in tmux. OpenCode and Antigravity (`agy`) are parked, and Grok was never implemented. The active model separates a configured agent's `id` from its adapter `kind`; v0 supports the `claude` and `codex` kinds and defaults to one instance of each. The existing OpenCode- and agy-specific decisions above remain as implementation history but are superseded for active v0 scope.

**Why:** The project's durable value is coordinating Claude Code and Codex without replacing either native TUI. The four-provider breadth delayed the first useful workflow, made Phase 0 live verification depend on tools outside the primary use case, and coupled common types to provider names. Separating identity from adapter kind preserves a clean path to configurable N instances without keeping speculative providers active.

**Impact:** Phase 0 is reopened as the two-agent foundation: deterministic horizontal panes, two-agent event/status wiring, daemon independence, and live verification on macOS then WSL2. OpenCode SSE, agy fallback logic, their config writers, and their acceptance checks leave the active build. Later phases prioritize bidirectional handoffs and pair workflow before rate-aware routing or additional providers.

## 2026-07-13 — Codex lifecycle hooks are the sole Phase 0 event path

**What:** `bridge init` uses Codex `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, and `Stop` command hooks. It no longer edits the global `notify` setting.

**Why:** Current Codex documentation exposes these lifecycle events directly through `hooks.json`; `Stop` includes the last assistant message. The separate `notify` command is redundant for turn completion and is a single global user setting that may already belong to another tool.

**Impact:** Codex observation stays event-driven while `bridge init` becomes less invasive and avoids notification-config conflicts. Existing hook trust review through `/hooks` remains required.

## 2026-07-13 — Retire only integrations provably owned by the old bridge

**What:** During the two-agent migration, `bridge init` removes the exact legacy Codex `notify` value that points at Agent Bridge's own notify shim and the exact `agent-bridge` agy hook blocks written by the previous Phase 0 initializer. It also removes owned Claude/Codex lifecycle handlers when that configured instance is disabled. Mixed hook groups are pruned handler-by-handler so foreign handlers and group metadata survive.

**Why:** Parking a provider in common types is insufficient if callbacks installed by an earlier checkout keep posting to the new daemon. Conversely, broad cleanup would violate config ownership. Exact path/schema checks give the reset a bounded uninstall path without claiming user-managed settings.

**Impact:** A first post-reframe `bridge init` may print and apply diff-backed, backup-protected removals in `~/.codex/config.toml` and the two legacy agy hook files. Foreign `notify` values, modified agy blocks, foreign handlers, and unrelated settings remain byte-for-byte or structurally preserved. After this one migration, active init manages only Claude Code and Codex lifecycle hooks and does not install or replace `notify`.

## 2026-07-13 — Scope active Codex hooks to the target repo

**What:** New Codex lifecycle handlers are written to the configured Codex instance's `<cwd>/.codex/hooks.json`, not the user-global `~/.codex/hooks.json`. The migration removes only handlers pointing at Agent Bridge's exact legacy global shim paths, including handlers inside mixed groups.

**Why:** Current Codex supports project-local hook layers. A user-global forwarder observes every Codex TUI on the machine and cannot intrinsically identify the one pane managed by this bridge. Project scope plus daemon-side `cwd` validation narrows events to the selected target while preserving the native TUI.

**Impact:** The target project must be trusted by Codex and the project hook definition approved once through `/hooks`. Initial migration may back up and edit the old global hooks file solely to remove Agent Bridge-owned commands; all foreign global hooks remain. Concurrent sessions in another repo no longer call this bridge. Phase 0 still assumes one live session per adapter kind within the same target cwd; binding a pane to a native session id is deferred.

## 2026-07-27 — Keep pane identity outside TUI-owned display titles

**What:** Each managed pane carries its configured `AgentId` in the pane-scoped tmux user option `@agent-bridge-agent-id`. The mux adapter and live verifier use this marker as durable pane identity. `select-pane -T <agent-id>` remains a best-effort initial display label only.

**Why:** The first authenticated macOS run proved that both native TUIs legitimately overwrite `pane_title` through terminal title escape sequences: Claude Code changed it to `✳ Claude Code`, and Codex changed it to the repository name. tmux's `allow-rename` option governs window names, not pane titles, so the verifier's title equality check could never be stable once real TUIs launched.

**Impact:** Native titles remain visible and TUI-controlled, while ownership/layout checks use metadata the child process cannot rewrite accidentally. The destructive daemon-independence test revalidates pane IDs and pane-agent markers before signalling or recovering. Real-tmux coverage now overwrites a visible title and proves the pane marker survives.

## 2026-07-27 — Claude idle reminders do not mean needs-you

**What:** Claude Code's `Notification:idle_prompt` is observational only. New Agent Bridge hook configuration no longer subscribes to that subtype, and the compatibility mapper classifies any `idle_prompt` delivered by already-loaded configuration as `raw`. `permission_prompt` remains a permission request, and `agent_needs_input` remains an explicit needs-input transition.

**Why:** The authenticated macOS run showed Claude emitting `idle_prompt` about sixty seconds after an ordinary completed turn while its TUI remained at the normal input prompt. Treating that reminder as `needs.input` incorrectly changed an already-idle agent to `needs_you`.

**Impact:** Claude remains `idle` after the passive reminder, while real permission and explicit input requests still show `NEEDS YOU`. Re-running `bridge init` updates the matcher; the mapper fallback makes the behavior safe even before a restarted Claude process loads that update.

## 2026-07-27 — Codex with no observed turn remains launching

**What:** Agent Bridge does not synthesize an idle event for a newly opened Codex TUI or after a daemon-only restart. While the current daemon has observed no semantic event, `bridge top` keeps the normalized state `launching` and explains it as `awaiting first observed turn`.

**Why:** Codex 0.145.0 queues `SessionStart` at session construction but executes it inside the first `run_turn`, immediately before `UserPromptSubmit`. The hook therefore marks first-turn startup, not an untouched TUI becoming ready. Inferring idle from pane text or injecting a hidden warm-up prompt would violate the event-only and native-TUI constraints.

**Impact:** A Codex pane with no events in the current daemon visibly reads `launching  awaiting first observed turn`; after the operator submits a prompt, normal `working → idle` hook transitions apply. The wording also remains true when an in-memory registry starts again behind an existing TUI. A future coordinator-owned process/readiness dimension or persisted-state replay may describe availability without falsifying semantic agent state.

## 2026-07-28 — Canonical Claude permission detail outranks its delayed notification

**What:** Claude Code's `PermissionRequest` hook is the authoritative detail source for a tool approval, while `Notification:permission_prompt` remains subscribed as a fallback human-attention signal. A native `PermissionRequest` always sets or upgrades the pending detail; a notification sets it only when no permission detail is already active.

**Why:** The authenticated macOS event history showed four tool approvals where `PermissionRequest` arrived with a specific `tool_name`, followed 6.000–6.021 seconds later by `Notification:permission_prompt` carrying only `Claude needs your permission`. Unconditional replacement downgraded the useful badge. The same history also contains a notification-only `Session paused` model-consent fallback, so removing the notification would miss a real human decision. Claude's hook reference likewise distinguishes the controllable, tool-specific request from the asynchronous alert surface.

**Impact:** A Claude tool approval keeps `⚠ Bash` (or the originating tool name) when the delayed generic notification arrives, while a notification-only consent/input prompt still produces `NEEDS YOU` with its own message. The event remains stored and may appear as the latest native event; only the active human-attention detail has source precedence. Hook configuration does not change.

## 2026-07-28 — Render unresolved attention separately from event recency

**What:** Daemon status keeps `lastEvent` as the literal latest normalized event and adds `activeAttention` as the provenance of the unresolved human-attention state. While an agent is `needs_you`, `bridge top` renders `activeAttention`; otherwise it renders `lastEvent`. A canonical `PermissionRequest` establishes or upgrades both the active detail and its provenance, while Claude's later generic `Notification:permission_prompt` remains recorded as `lastEvent` without replacing either. Notification-only consent and explicit needs-input events still establish their own attention provenance.

**Why:** Preserving only the `⚠ Bash` detail was insufficient: the delayed notification still changed the middle column from `PermissionRequest` to `Notification:permission_prompt`. Rewriting or suppressing `lastEvent` would make daemon status and event history misleading. A separate unresolved-attention projection makes both views truthful and stable.

**Impact:** A pending Claude tool approval remains visually `PermissionRequest … ⚠ Bash` even after its advisory notification arrives. `/status.lastEvent` and SQLite still expose that notification as the most recent observed event. Resolution, progress, completion, and exit events clear both the pending detail and its provenance.

## 2026-07-28 — Do not infer Claude manual permission dismissal

**What:** Agent Bridge does not synthesize `idle` when the user presses Escape or manually declines a Claude permission dialog. It continues to clear attention on the next trusted lifecycle hook. It does not use a timeout, transcript polling, pane scraping, focus changes, or tmux key interception as a substitute for the missing hook.

**Why:** Authenticated session evidence records `toolDenialKind: "user-rejected"` in Claude's transcript for each Escape but shows no corresponding hook event. Claude's current hook reference explicitly says `PermissionDenied` does not run for manual denial, while tool-result hooks cannot run for a tool that never executed. Declaring idle without an observable resolution could violate the idle-only injection safety invariant.

**Impact:** After Escape, `needs_you` may remain visible until the next `UserPromptSubmit`, `Stop`, tool-result, failure, session-end, or other clearing event. Re-subscribing to `Notification:idle_prompt` as a delayed idle observation remains a possible hook-only improvement, but it requires an authenticated proof that the notification fires after dismissal and never while an approval dialog remains open before it can become trusted lifecycle state.

## 2026-07-31 — Attribute events to bridge-launched native processes

**What:** `bridge up` launches each native TUI with process-scoped
`AGENT_BRIDGE_AGENT_ID=<AgentId>` and
`AGENT_BRIDGE_CONFIG_FINGERPRINT=<loaded config fingerprint>`. Claude HTTP hook
headers expand these allowlisted process environment values, and the
Claude/Codex command shims forward them as
`X-Agent-Bridge-Agent-Id` and `X-Agent-Bridge-Config-Fingerprint`. The daemon
accepts an event only when route AgentId, marker AgentId, and its loaded config
fingerprint agree. Missing, stale, or mismatched markers receive an empty 204
and do not mutate event history, native-session binding, or live state.

**Why:** Project-local hooks and cwd validation exclude other repositories but
cannot distinguish an independently launched TUI of the same kind in the same
working directory. Phase 1 handoffs need the source transcript and target idle
state to belong to the actual panes Agent Bridge manages. Process inheritance
provides that provenance while leaving both native TUIs unmodified.

**Impact:** Unmanaged same-project sessions remain fully usable and their hook
failures or rejections remain invisible to the native tool, but they cannot be
mistaken for a managed source or target. The markers are local attribution,
not authentication against an adversarial local process. Config writers must
preserve their existing diff, backup, foreign-setting, and idempotency rules.

The managed launch also owns a tmux pane option containing its AgentId, config
fingerprint, random run token, and foreground wrapper PID. The option is cleared
on normal wrapper exit. Immediately before injection, the bridge requires the
marker PID to be live and still be a child of that pane's long-lived login
shell. This is a terminal-target liveness/ownership check only: semantic
`working`, `idle`, and attention state still come exclusively from native
hooks. Its purpose is to fail closed when a stale `idle` projection outlives a
TUI that has returned to the fallback shell.

## 2026-07-31 — Freeze approve-mode handoffs at the latest accepted Stop

**What:** The first Phase 1 delivery path creates an immutable packet from the
source agent's latest accepted semantic `Stop`. It records packet id, source and
target AgentIds, source native-session id, source event id/sequence/timestamp,
the exact `last_assistant_message`, and creation time. Transcript enrichment
must be tied to that same completed turn; Git status, changed paths, and diff
statistics are explicitly a creation-time repository snapshot and are labeled
as such rather than represented as source-turn provenance. Preview,
approval, and injection resolve the packet id and never fetch “latest” again.
Approval revalidates target ownership and semantic idle immediately before the
bracketed paste and again after its observable is proven, immediately before
the single Enter. The verifier may open one additional observation window, but it never
pastes the bytes a second time; otherwise delivery fails closed after the first
paste.
The packet ends with a unique id marker and its receipt binds the approved bytes
by SHA-256; delivery re-reads and verifies that identity before touching tmux.

Successful or failed delivery writes separate durable delivery state/receipt
with packet id, target native session, attempt/outcome, and timestamps. The
receipt attests only to what the terminal boundary proved; packet immutability
does not require delivery state itself to be immutable. Failed, denied, stale, or
crash-ambiguous delivery does not rewrite the packet and is not automatically
replayed; retry or replacement is explicit.

Approved deliveries also take a create-only reservation scoped to the target
AgentId. A concurrent contender fails immediately rather than queues. The
reservation is released only after a later target `turn.start` in the same
native session contains the packet's unique footer in its submitted prompt,
and its provider turn token is stored durably in the receipt before release,
proving that this exact input entered native processing. A crash, missing
correlation, or any existing reservation leaves it in place for explicit
reconciliation; approve mode never performs implicit stale takeover. This is an
input-serialization guard, not a claim that the target understood the handoff
and not a synthetic lifecycle transition.

**Why:** A source can continue working while a human reviews a handoff. Rebuilding
at approval time would silently change what was approved, while mutating the
packet with delivery state would destroy the approved snapshot. Explicit receipts
also prevent echo verification from being overstated as agent comprehension
and make ambiguous restart recovery fail safely instead of duplicating input.

**Impact:** Approve mode is the current/default implementation slice. If its
snapshot is stale, the operator creates a new packet. Idle-gated auto mode,
shared tasks, and semantic acknowledgement remain separate follow-on work and
cannot weaken the immutable-packet or separate-receipt boundary.

## 2026-07-31 — Correlate lifecycle state before authorizing injection

**What:** Only genuine native-session starts may produce normalized
`session.start`: Claude `startup`, `resume`, `clear`, and `fork`, and Codex
`startup`, `resume`, and `clear`. Compaction, missing, and unknown sources are
stored as `raw` and cannot change state, attention, or session binding. The
registry rejects every session start while the managed projection is already
`working` or `needs_you`, including a different-session start from nested
provider work; it cannot rebind and expose a false idle gate. The
registry tracks the provider turn token (`prompt_id` for Claude, `turn_id` for
Codex); a completion or error may close only the currently active matching
turn, and a previously seen start token cannot later roll correlation backward.
`raw` and terminal events cannot rebind a live session. A
provenance-validated `turn.start` may establish a missing binding so Codex
remains honestly `launching` until its first observed semantic turn and either
managed TUI can recover after a daemon-only restart without restarting its
native session.

**Why:** Both providers can emit compaction-related SessionStart events while a
turn is still active, and hook delivery may be concurrent or out of order.
Mapping every SessionStart to idle or accepting a delayed older Stop can expose
a busy native TUI as idle to the delivery gate.

**Impact:** Lifecycle ambiguity now fails closed instead of authorizing
terminal input. Compaction remains visible in retained history without
pretending that the agent is idle, and normal first-turn Codex binding remains
supported without pane scraping or synthetic prompts.

Projection commits only after the exact accepted or demoted event has been
appended durably; an append failure cannot advance `/status` without matching
history. Stale, renamed, or disabled hook routes return the same empty 204 as
other ignored hook input so observation never becomes a native-TUI dependency.

## 2026-07-31 — Keep approve mode outside the managed tmux session

**What:** The first Phase 1 `bridge handoff` command is a third-terminal
operation. It refuses before focusing a managed pane when conventional
`TMUX`/`TMUX_PANE` markers identify a tmux client; deliberately stripping those
markers is unsupported rather than treated as a security boundary. Packet
creation additionally requires the source to be currently
idle, even though its immutable content comes from the latest accepted Stop.
The managed tmux window is pinned by identity rather than inferred from the
session's current window. Missing or inconsistent reciprocal session/window
markers fail closed; current-window fallback exists only inside explicitly
verified legacy teardown.

**Why:** Focusing the target before reading approval can redirect the
operator's `DELIVER <id>` keystrokes when the CLI itself runs inside tmux.
Requiring current source idle keeps this first approve-mode slice simple while
still allowing the source to continue after the packet is frozen. Pinning the
window lets scratch windows coexist without changing which panes are eligible
for delivery.

**Impact:** Run `bridge handoff` beside `bridge top` and `bridge attach` in a
separate terminal. In-session orchestration and source-working packet creation
remain possible later UX extensions, not implicit behavior in this safety
slice.

## 2026-07-31 — Grow an operator console over isolated project runtimes

**What:** The north-star terminal UI is a control-plane projection organized as
`project → task/work item → group run → agent run → native session`. It may
surface a cross-cutting Needs-you queue, but agent lifecycle, task lifecycle,
and handoff lifecycle remain distinct. Entering a live agent focuses and
attaches its real tmux pane. Re-entering a stopped conversation, when added,
uses the adapter's native resume/continue command and exact recorded session
reference; the bridge does not replay conversation text.

Each project keeps its own daemon, config identity, event database, and tmux
ownership. A later multi-project console aggregates a registry of those
isolated runtime cells instead of replacing them with one machine-wide daemon.

**Why:** This yields the useful Claude-agents-view ergonomics without building
a unified chat client or making one project's runtime/failure authoritative for
another. Separating task from prompt and task completion from native `Stop`
also prevents the board from presenting an idle turn as completed work.

**Impact:** Phase 1 adds only the local handoff records and visibility required
for its exit test. The shared task plane, group/worktree launcher, native resume
actions, trustworthy observed model/effort telemetry, and global multi-project
navigation remain in their later phases. Active adapter kinds remain Claude
Code and Codex exclusively.

## 2026-08-03 — Explain unobserved recovery state for either adapter

**What:** When the current daemon has no accepted semantic event for a managed
agent, `bridge top` keeps the normalized state `launching` and explains it as
`awaiting first observed turn` for either Claude Code or Codex. It does not
reconstruct an idle state from the pane, transcript, or a previous daemon.

**Why:** Authenticated Phase 1 recovery testing on macOS showed that both native
TUIs remain usable after a daemon-only restart, but the new in-memory registry
cannot know what happened while it was offline and neither already-running TUI
must immediately emit another `SessionStart`. Calling either agent idle before
a fresh trusted lifecycle event would weaken the idle-only injection gate.

**Impact:** A fresh untouched Codex TUI retains its existing first-turn behavior.
After daemon-only recovery, either agent may temporarily read
`launching  awaiting first observed turn`; its next real semantic turn safely
re-establishes the native-session binding and normal state transitions. Here,
`launching` describes the daemon's unobserved lifecycle projection, not whether
the native process is running or usable.
