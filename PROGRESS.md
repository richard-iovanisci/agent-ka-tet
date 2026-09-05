# Implementation status

Updated: 2026-09-05. Active platform: **macOS only**.

## Implemented

Reconciled `main` at `a2482b1`; history is tagged `archive/pre-native-rework-2026-09-05`.
Old proposals and inactive worktrees are archived outside the source tree.
[DESIGN.md](DESIGN.md) is the contract.

- Disposable 1+1 worktrees, private Codex host, and native tmux TUIs.
- Authenticated MCP send/read/ACK, Claude Channel, exact-thread Codex tool output.
- Durable messages, immutable destinations, writer exclusion, pause, expiry, and limits.
- Separate delivery/application receipts, native observations, held ambiguity, explicit recovery.

The earlier manual-handoff CLI remains. Obsolete migration and global teardown paths are removed.

## Native evidence

Claude Code **2.1.261** and Codex **0.153.4** completed one live nonce round trip on macOS.
Run `8b3fa7aa256f` produced exactly two messages: PING was Channel-written, read, acknowledged,
and replied to; PONG was accepted into Codex's active turn, read, and acknowledged. Its immutable
message ID matched the native `functionCallOutput` item. An optional inbox poll was cancelled;
Codex consumed the pushed output. Both native TUIs remained usable and shutdown completed.

Claude's peer turn emitted `UserPromptSubmit`, tool hooks, and `Stop`. Codex emitted its operator
`UserPromptSubmit`, permission/tool hooks, and `Stop`; peer ingress did not add a user prompt.
Native tool approvals were answered in Codex's TUI. This was not an unattended task loop.

The installed Codex build rejected paginated-history resume (`list_turns is not supported yet`).
The successful attempt used experimental legacy history plus native thread naming. An earlier
attempt also exposed trust-before-host ordering and Claude's inherited `dontAsk` tool gate.
Preparation now exposes Codex hooks for native trust review; private Claude settings allow the
five Bridge tools. Failed attempts are preserved and were not replayed.

Private evidence: `.bridge/pilots/2026-09-05-native-round-trip.json` and final native pane captures.

## Next

1. Validate idle wake, composer drafts, interruption/reconnect, and uncertain native outcomes.
2. Add versioned task/review operations and console receipts; prove an implement → review → accept
   loop with 1+1, then a configurable 2+2 fleet in separate worktrees.

The complete pair/fleet gates remain open. Windows and Linux, including WSL2, follow the working
macOS prototype.

## Checks

`bun test`: **304 passed, 0 failed**, 2,027 assertions across 25 files (72.92 s).
Typecheck and whitespace checks pass. Tests include protocol, durable-state, isolated-process,
and real-tmux fixtures. The extended recovery suite also passes: 18 tests, 152 assertions.
`scripts/check.sh` runs tests and typecheck.
