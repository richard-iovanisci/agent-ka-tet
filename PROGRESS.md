# Implementation status

Updated: 2026-09-05. Active platform: **macOS only**.

## Current baseline

The reconciled baseline is `eb8f515`: native Claude/Codex tmux launch, hook-derived state,
exact-session operator-approved handoffs, packet/receipt persistence, and diff-backed config updates.
The previous documentation recorded macOS manual-handoff acceptance; those historical checks
do not validate the new native routes or task plane.

The architecture has been rewritten around [DESIGN.md](DESIGN.md). Old designs and checkout
snapshots are preserved outside the active source tree; they are not implementation authority.

## Work remaining

1. Build the small authenticated, durable pilot harness and protocol fixtures.
2. Run named macOS pilots for private Codex hosting/binding, attached-TUI tool output,
   Claude Channels, peer-triggered hooks, application ACK, and uncertain delivery outcomes.
3. Complete versioned tasks/review, writer exclusion, pause/resume and limits; connect proven
   routes to the API and console. Complete a native 1+1 implement/review loop
   without manual relay, then prove 2+2 with separate worktrees and repeated-kind addressing.

**No new native-route pilot or pair/fleet gate has passed.** Windows and Linux, including WSL2,
remain deferred until the working macOS prototype.

## Validation

Documentation rewrite: CLI and hook installation source inspected; no authenticated runtime
exercised. `bun run typecheck` passed during reconciliation; the full test suite has not been rerun.
`scripts/check.sh` runs both standard checks. Record native pilot versions and evidence here.
