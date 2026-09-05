# Implementation status

Updated: 2026-09-05. Active platform: **macOS only**.

## Implemented

Reconciled `main` at `a2482b1`; pre-rework history is tagged
`archive/pre-native-rework-2026-09-05`. Old proposals and inactive worktrees are archived
outside the source tree. [DESIGN.md](DESIGN.md) is the implementation contract.

- Isolated 1+1 pilot: disposable worktrees, private Codex host, native tmux TUIs.
- Authenticated MCP send/read/ACK; Claude Channel and exact-thread Codex tool output.
- Durable messages, immutable destinations, writer exclusion, pause, expiry, and limits.
- Correlated native observations, separate delivery/application receipts, held ambiguity.
- Explicit coordinator recovery; runtime ownership and session-switch checks.

The earlier manual-handoff CLI remains available. Obsolete roster migration, global integration
retirement, and legacy teardown paths have been removed.

## Work remaining

1. Run named macOS pilots for private Codex hosting/binding, attached-TUI tool output,
   Claude Channels, peer-triggered hooks, application ACK, and uncertain delivery outcomes.
2. Add versioned tasks/review and connect proven
   routes to the API and console. Complete a native 1+1 implement/review loop
   without manual relay, then prove 2+2 with separate worktrees and repeated-kind addressing.

**No new native-route pilot or pair/fleet gate has passed.** Windows and Linux, including WSL2,
remain deferred until the working macOS prototype.

## Validation

`bun test`: **297 passed, 0 failed**, 1,966 assertions across 25 files (77.69 s).
`bun run typecheck` and `git diff --check` pass. Tests include protocol, coordinator,
configuration, disposable-process, and real-tmux fixtures. `scripts/check.sh` runs the standard checks.
No authenticated native harness has been exercised during this implementation.
