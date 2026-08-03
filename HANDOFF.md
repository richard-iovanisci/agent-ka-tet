# Agent Bridge — Phase 1 Bidirectional Handoffs

This is the implementation handoff for the active branch:

```
codex/phase-1-handoffs
```

Start from the cross-platform accepted two-agent baseline at
`codex/phase-0-two-agent`. Treat [DESIGN.md](DESIGN.md), the July 31 entries in
[DECISIONS.md](DECISIONS.md), and this document as the active contract.

---

## 1. Outcome

The current Phase 1 slice is complete when an operator can:

1. select the latest completed Claude turn, freeze an inspectable handoff to
   Codex, preview it, explicitly approve it, and see that exact packet arrive
   visibly in the idle Codex TUI;
2. perform the same flow from Codex to Claude;
3. inspect durable delivery state/receipt that says exactly what the terminal
   boundary proved; and
4. rely on an unmanaged same-kind TUI in the same repo, a busy/blocked target,
   a daemon restart, or an ambiguous delivery never causing silent
   misattribution or duplicate input.

Both agents remain their ordinary native TUIs in their existing tmux panes.
This slice does not add a shared task bus, worktrees, autonomous routing, a
global multi-project supervisor, generalized agent counts, or another adapter
kind.

---

## 2. Accepted baseline and pre-flight

Phase 0 passed **44 / 44** authenticated checks on macOS and WSL2. Preserve its
invariants:

- native Claude Code and Codex TUIs survive daemon failure;
- lifecycle state comes only from semantic hooks;
- pane identity lives in `@agent-bridge-agent-id`, not a TUI-controlled title;
- injection is one bracketed paste, adapter-aware proof that exactly one input
  landed, and one Enter; a second observation window never re-pastes the input;
- no injection occurs unless the target is semantically idle;
- config writers diff, back up, preserve foreign settings, and remain
  idempotent;
- the daemon binds loopback only;
- authenticated behavior is verified on macOS and WSL2 Ubuntu.

Before implementation:

1. confirm branch `codex/phase-1-handoffs`;
2. read `DESIGN.md`, `AGENTS.md`, `DECISIONS.md`, and this file completely;
3. preserve unrelated working-tree changes;
4. ask before adding dependencies beyond the existing Bun/TypeScript toolchain;
5. record any design deviation in `DECISIONS.md` before implementing it.

---

## 3. Domain boundaries

Phase 1 introduces only the records required for a safe handoff:

- **managed agent run** — configured `AgentId` + kind + pane + validated launch
  markers + current native session;
- **completed source turn** — the latest accepted semantic `Stop` for the
  managed source session;
- **handoff packet** — immutable snapshot of that turn plus explicit target
  instructions and optional session-matched enrichment;
- **delivery state/receipt** — separate record of approval, target revalidation,
  packet SHA-256, attempts, terminal result, and timestamps;
- **target delivery reservation** — create-only serialization guard that makes
  a concurrent contender fail rather than inject through the same idle view.

A prompt is one native turn, not a task. A native `Stop` means the agent is idle,
not that a future bridge task is complete. Formal task threads, assignments,
updates, and completion belong to Phase 2.

---

## 4. Implementation brief

### A. Attribute events to the managed processes

Project-local hooks and cwd validation are insufficient when someone launches a
second Claude or Codex TUI in the same repo. `bridge up` must launch each managed
native process with:

```
AGENT_BRIDGE_AGENT_ID=<configured AgentId>
AGENT_BRIDGE_CONFIG_FINGERPRINT=<loaded config fingerprint>
```

The environment is process-scoped; it must not become a global shell setting.
Claude HTTP hook headers expand these allowlisted process environment values,
and the Claude/Codex command shims forward them as:

```
X-Agent-Bridge-Agent-Id
X-Agent-Bridge-Config-Fingerprint
```

The daemon accepts an event only when all of these agree:

1. the `AgentId` in `/events/<agent-id>`;
2. the forwarded AgentId;
3. the daemon's loaded config fingerprint and forwarded fingerprint;
4. the configured/canonical cwd checks already enforced in Phase 0.

Missing, malformed, stale, or mismatched provenance receives an empty 204 and
does not reach the event store, status registry, or native-session binding.
Hooks remain short and fail-open when the daemon is unavailable. These markers
are attribution among normal local processes, not a security boundary against
an adversarial local user.

### B. Bind each agent run to its native session

After provenance validation, retain enough binding to identify the source turn
unambiguously:

```text
AgentId + AgentKind + paneId + canonical cwd + config fingerprint
        + native sessionId + first/last accepted event provenance
```

The pane mapping comes from tmux's durable AgentId marker. The native session id
comes only from a validated hook. Transcript lookup must use that exact session
id and adapter path convention; “newest transcript in the repo” is never an
acceptable substitute.

The current live binding may be reconstructed from validated daemon status and
event history. A durable cross-run session catalog for future resume/navigation
is later work and is not required to claim this slice complete.

If the managed TUI starts or resumes a different native session, rebinding must
be driven by its validated semantic session event. Compaction, missing/unknown
SessionStart sources, raw events, and old terminal events do not rebind. A
session start observed while the managed projection is `working` or
`needs_you` is retained as raw rather than rebinding to a possibly nested
provider session. A
provenance-validated first `turn.start` may establish a missing binding for
first-turn Codex timing or daemon-only recovery. Active turn tokens ensure that
a delayed completion cannot overwrite a newer working
turn. A pending packet keeps its frozen source-session reference; it is not
rewritten to follow the agent.

Native attach and native resume are distinct. Phase 1 continues to attach to
live tmux panes. Later resume support must call the adapter's native
resume/continue command with an exact recorded session reference, then validate
the resulting session hook; it must not replay transcript text.

### C. Resolve the latest completed source turn once

Packet creation requires the source to be currently idle and to have an accepted
`Stop` for its currently bound native session. Resolve that event once and
persist its stable database id or sequence. At minimum the packet freezes:

```text
packet id
source AgentId and kind
target AgentId and kind
source native session id
source Stop event id or sequence
source Stop timestamp
exact last_assistant_message
creation timestamp
explicit target instructions
source and target adapter kinds
SHA-256 content identity (in the separate receipt)
```

The source `Stop` is the authority for the completed turn. A transcript-derived
summary or context window may enrich the packet only when the adapter proves it
belongs to the same native session and ends at that same turn. Diff statistics
are captured at creation time. Missing or ambiguous attribution fails closed
with a useful error instead of silently choosing another conversation.

### D. Make the packet immutable and inspectable

Write a human-readable Markdown packet under `.bridge/handoffs/` using an atomic
write. Once creation succeeds, preview and approval load it by packet id and
content identity; they never re-query “latest Stop,” regenerate the summary, or
refresh the diff. If the source has progressed and the operator wants new
context, create a new packet.

Delivery state does not belong inside the immutable approved snapshot. Keep
approval, target-session selection, attempt number, timestamps, verification,
submission, failure, cancellation, and explicit retry state in a separate
durable record/receipt. A terminal receipt must distinguish:

- paste echo-verified and Enter sent;
- paste failed verification after the second observation window;
- target ownership/session/state became stale;
- delivery was denied or cancelled;
- process interruption left the outcome ambiguous.

“Delivered” means delivered at the terminal boundary. It does not mean the
target understood, accepted, or completed the requested work.

### E. Approve and deliver safely

The current/default mode is explicit approval:

1. create and persist packet;
2. render the exact frozen preview;
3. wait for approval naming that packet id;
4. resolve the configured target pane from its durable AgentId marker;
5. revalidate runtime/config ownership, the managed launch PID, and the target's
   current native session;
6. require the target's semantic state to be exactly `idle` (from hooks only);
7. persist delivery intent before touching the pane;
8. inject the packet as one bracketed paste, prove through an adapter-specific
   observable that exactly one input landed, and send exactly one Enter only
   after revalidating the managed process, pane, session, and idle state again;
   if needed, observe once more without re-pasting;
9. persist the terminal outcome separately from the packet.

Only one approved delivery may reserve a target at a time. Keep the reservation
through terminal submission and release it only after a later same-session
target `turn.start` contains the packet's unique footer in its submitted prompt
and its provider turn token has been stored durably in the receipt.
If that exact correlation is absent, a reservation already exists, or the
process dies ambiguously, retain the reservation and require explicit
reconciliation; do not implicitly take it over, queue, or replay a contender.
The current approve command waits two seconds for that correlation. A hook
arriving later does not trigger background release; the lock stays retained
until a later explicit reconciliation command can inspect the receipt, session,
footer, and provider token together.
This observation serializes input but does not mean the agent understood or
completed the handoff.

If the target is `launching`, `working`, `needs_you`, `done`, `error`, missing,
unbound, stale, or owned by another configuration, do not inject. A crash after
delivery intent but before a definitive receipt is ambiguous and must stop for
explicit operator resolution. It must never automatically replay the packet.

Any retry or replacement must be an explicit later operator action and must
revalidate everything again; it never mutates the packet. Idle-gated auto mode
is outside this first slice.

### F. Provide the minimum operator surface

The first Phase 1 CLI surface is one deliberately narrow command:

```text
bridge handoff <from> <to> --task <bounded target instruction>
```

Run approve mode from a separate, non-tmux terminal; the command refuses before
focus when the normal `TMUX`/`TMUX_PANE` environment markers show that it was
invoked from tmux, so approval keystrokes cannot be redirected into a managed
agent composer. Intentionally stripping those markers is unsupported and is not
a security boundary. One invocation resolves and freezes the latest accepted source `Stop`, writes
the packet and prepared receipt, prints the exact packet for inspection, asks
for explicit approval tied to its id, and attempts the idle-gated delivery. The
packet and receipt files remain directly inspectable under `.bridge/handoffs/`.
List/show/cancel/retry subcommands and a compact `bridge top` handoff section
are later conveniences, not acceptance requirements for this slice. Scripts
and tests must not rely on implicit “latest” after packet creation, and this
slice does not build the global keyboard-driven operator console.

### G. Keep the future operator-console seam clean

Use distinct identifiers and record types so the later hierarchy can be:

```text
project → task/work item → group run → agent run → native session
```

The eventual console may show a cross-project Needs-you queue and sections for
work in progress or review. It will enter a live agent by focusing/attaching the
real tmux pane. Model and effort fields must eventually distinguish configured
values from semantically observed values; transcript enrichment may never gate
lifecycle or injection.

Each project remains an isolated runtime cell with its own daemon, config
identity, database, and tmux ownership. Future multi-project navigation
aggregates a registry of those cells and treats an offline cell as local
degradation. It does not require or authorize a machine-wide daemon in Phase 1.

---

## 5. Verification

### Automated

- Existing Phase 0 tests and static gate remain green.
- The full automated suite passes under both the normal UTF-8 locale and
  `LC_ALL=C`; tmux pane parsing is locale-independent and validates every field.
- Launch markers are process-scoped and forwarded through both hook paths.
- Missing/mismatched markers return 204 but cannot change store, binding, or
  status.
- A valid managed event still maps and transitions normally.
- Session binding uses the validated native session id.
- Packet creation selects the latest accepted `Stop` for that bound session.
- A packet preview is byte-stable after newer source turns and filesystem
  changes.
- Approval refuses every non-idle target state and stale ownership/binding.
- Delivery proves exactly one adapter-specific paste observable before Enter;
  delayed echo, collapsed placeholders, and any ambiguous observable cannot submit
  duplicate input.
- Delivery outcome is stored separately and ambiguous delivery is never
  automatically retried.
- Concurrent approvals and unresolved prior reservations for one target produce
  at most one terminal submission; approve mode never takes over a stale lock.
- Packet tampering after preview is detected before delivery.
- A stale managed-process marker cannot route a packet into the fallback shell.
- Restart recovery cannot automatically duplicate an ambiguous delivery, and
  only a same-session prompt containing the packet footer releases its lock.
- Real throwaway tmux tests exercise pane resolution and injection; do not mock
  the mux boundary.

### Authenticated live acceptance on macOS, then WSL2

Status: macOS passed on August 3, 2026; the equivalent WSL2 Ubuntu run remains
pending.

- Claude → Codex approve-mode handoff arrives visibly and exactly once.
- Codex → Claude approve-mode handoff arrives visibly and exactly once.
- The previewed packet is the packet delivered even after the source continues.
- A working target defers/refuses delivery without losing the packet.
- A permission-blocked target refuses delivery.
- A second unmanaged same-kind TUI in the same cwd cannot alter managed status
  or session attribution.
- Daemon loss leaves both TUIs usable.
- Recovery after a deliberately ambiguous attempt never silently replays input.
- The receipt describes only terminal delivery, not task completion.

---

## 6. Later phase boundaries

- **Later Phase 1:** consider idle-gated auto mode only after approve-mode live
  acceptance.
- **Phase 2:** file-backed task/update records, bridge-bus tools, peer reads,
  and advisory path locks.
- **Phase 3:** fixed Claude+Codex group runs, worktrees, role briefs,
  integration branch, merge choreography, and native resume actions.
- **Phase 4:** trustworthy model/effort and usage/headroom telemetry plus
  explainable routing.
- **Phase 5:** aggregate isolated project runtimes into the operator console and
  generalize counts only where the proven Claude+Codex workflow needs it.

Claude Code and Codex remain the exclusive active adapter kinds. Additional
providers, custom chat UIs, headless/API/ACP replacements, Graphify, Obsidian,
Zellij, and web dashboards remain parked.

---

## 7. Standing process rules

- One phase per branch; use small imperative commits.
- `DESIGN.md` is authoritative; log deviations before implementation.
- No dependency additions without approval.
- Preserve unrelated user changes and foreign hook settings.
- Use semantic events for lifecycle; transcript reads may enrich packets but
  never establish idle/working/attention state.
- Use `capture-pane` only for preview/readiness/echo verification.
- Never inject unless the exact managed target is semantically idle.
- Keep all control services loopback-only and all hook failures fail-open.
- If a design would wrap, replace, or invisibly control either native TUI, stop.
