# Progress

Current phase: **1 — Bidirectional handoffs**

Active branch: `codex/phase-1-handoffs`

## Phase 0 acceptance

The Claude Code + Codex dual-TUI foundation is complete. The authenticated
interactive verifier reported **44 pass / 0 fail / 0 warn** on both supported
targets:

- macOS: accepted July 28, 2026;
- WSL2 Ubuntu: accepted July 31, 2026.

The accepted baseline preserves two unmodified native TUIs in real tmux panes,
event-only lifecycle state, stable pane ownership, permission attention,
Codex's honest first-observed-turn state, daemon independence, and safe daemon
recovery. At the Phase 0 gate, 103 Bun tests and strict TypeScript passed, and
`scripts/verify-phase0.sh static` reported 8 pass / 0 fail / 0 warn.

## Phase 1 current slice

The first implementation slice is deliberately approve-mode only:

- attribute lifecycle events to the exact bridge-launched native processes;
- bind each managed `AgentId`/pane to its observed native session;
- snapshot an immutable packet from the source's latest accepted `Stop`;
- preview and approve that exact packet id;
- revalidate target ownership and semantic idle immediately before injection;
- deliver through one bracketed paste, exact native-TUI observable
  verification, one observation-only retry, and one Enter;
- write separate durable terminal-delivery state/receipt;
- support the same path in both directions.

Idle-gated auto mode follows only after this path passes its own authenticated
safety checks. The shared task plane, pair/worktree launcher, model/effort and
usage telemetry, native resume actions, and global multi-project operator
console are not part of this first slice.

Current automated gate: **187 Bun tests / 0 failures / 1,195 assertions** in
both the normal UTF-8 environment and plain `LC_ALL=C`; strict TypeScript is
green, and Phase 0 static compatibility reports **8 pass / 0 fail / 0 warn**
in both locales on macOS. The independent review and consensus hardening are
implemented. Authenticated approve-mode acceptance passed on macOS on August 3,
2026, including both delivery directions, frozen preview, non-idle refusal,
managed-session attribution, daemon loss/recovery, ambiguous-delivery safety,
and receipt semantics. The remaining gate for this slice is the same
authenticated acceptance run in WSL2.

The macOS recovery run also confirmed the conservative post-restart behavior:
both still-usable native TUIs remain `launching  awaiting first observed turn`
in the new daemon until each produces a fresh semantic turn and re-establishes
its session binding. This is expected fail-closed state, not process failure.

| Phase | Branch | Status |
|---|---|---|
| 0 — Dual-TUI foundation | `codex/phase-0-two-agent` | complete; 44/44 on macOS and WSL2 |
| 1 — Bidirectional handoffs | `codex/phase-1-handoffs` | active; macOS accepted, WSL2 authenticated acceptance pending |
| 2 — Shared task plane | — | not started |
| 3 — Pair workflow | — | not started |
| 4 — Rate-aware routing | — | not started |
| 5 — Multi-project operator layer + proven extensibility | — | not started |

The operator-console north star remains Claude Code and Codex exclusively. It
will grow incrementally over the proven project-local runtime rather than
replacing either native TUI or broadening the adapter matrix.
