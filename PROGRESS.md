# Status

Updated: 2026-09-07. **The macOS 1+1 prototype passed the operator's implement/review/accept
cycle, final acknowledgment, and exported-patch validation.**

## Working

- Claude implements; read-only Codex reviews the exact committed artifact in a separate worktree.
- Versioned task claim, submit, and review operations persist with their peer notifications.
- Native Claude Channel and Codex tool output carry messages with separate delivery/read/ACK receipts.
- The console shows tasks and receipts, opens either native TUI, and supports pause/resume.
- Run expiry is shown separately from agent pause; expired runs retain native entry and inspection.
- Native startup uses direct tmux argv with a pane ownership barrier, avoiding interactive shell prompts.
- Coordinator recovery preserves native sessions; uncertain sends remain held.
- Accepted linear commits export as a patch. The source checkout stays unchanged.

## Live validation

Claude Code **2.1.261**, Codex **0.153.4**, Bun **1.3.14**, macOS.

Run `d215cc7c163f` completed **implement → review → accept** with exactly three acknowledged
messages and no manual relay. Codex's idle review turn received one correlated tool-output item;
its transcript retained exactly one operator user message. Claude read and acknowledged the final
acceptance. Both native composers retained distinct unsent drafts, absent from submitted records.

The coordinator was stopped with the review notice prepared and held. Recovery preserved both
TUI processes, the private host, exact session identities, and the pending notice. Reconfirmation
released it once. Console attach/detach and quit preserved the native sessions.

Claude's eight tests passed. Codex independently ran the eight committed test callbacks in memory;
its normal runner attempt failed without diagnostics. Exported patch validation then ran the normal
Bun runner in a separate checkout: **8 passed, 0 failed**. The source remained clean at its original commit.

Native shell/file approvals were answered in the TUIs. The nine Bridge tools required no per-call
approval. This proves automatic peer delivery, not operation without native permission prompts.
The earlier nonce pilot also passed active-turn Codex delivery and owned shutdown.

Private evidence: `.bridge/pilots/2026-09-05-task-native-evidence.json`, draft captures, recovery
snapshots, and `2026-09-05-task-export-verification.json`. The completed pair is paused for inspection.

The September 7 refresh exposed an Oh My Zsh startup prompt intercepting the launcher paste.
That attempt was stopped without an agent or task start. Direct startup then launched Claude **2.1.263**
and Codex **0.153.4**, with both native routes confirmed ready before returning them to paused state.
The operator confirmed pause/resume, correct native focus, and unsent draft preservation across
detach for both agents. Run `32fe38630f90` then reached **accepted v4**, artifact
`32f8c1c76381a305880c0fbbaf67a5b271a0f94e`. Claude reported eight passing tests; Codex reported
eight committed test callbacks plus four additional assertions passing in memory. Operator resume
released the final acceptance once; all three messages were read and acknowledged. The exported
patch applied cleanly in a separate clone, exactly reproduced the accepted Git tree, and passed
the normal Bun runner: **8 passed, 0 failed**. Source and reviewer remained clean at the recorded base.
Draft preservation during peer-triggered turns is not yet manually checked in this run.
Evidence: `.bridge/pilots/2026-09-07-operator-checks.json` and `2026-09-07-task-export-verification.json`.

## Limits and next steps

- Claude uses a development Channel; this Codex build needs experimental legacy history at startup.
- Native project/hook trust must precede the private Codex host. Tracked Codex hook conflicts are
  refused before preparation; automatic configuration merging remains open.
- The run has 32 messages, an eight-hop limit, and four hours. It supports one task and a fixed pair.
- Forced interruption, provider disconnect, and uncertain native outcome matrices remain open.
- Improve the console and add launch-time model/reasoning controls,
  default permission bypass/YOLO, shared provider/account quota visibility, and per-session context.
  These are operator requirements, not implemented features. Native telemetry support needs
  investigation; observational scraping is allowed and hidden admin sessions remain an option.
- Qualify the revision loop before a configurable 2+2 fleet. Windows and Linux/WSL2 remain later work.

## Checks

Pause-notice clarification: **15 console tests passed**, 208 assertions; typecheck passed.

`scripts/check.sh`: **367 passed, 0 failed**, 2,768 assertions across 29 files (56.81 s);
typecheck and whitespace checks passed. Tests cover task roles, version conflicts, atomic notifications,
Git isolation/export, protocol/recovery, and real tmux/PTY console behavior.

Repository history is retained at `archive/pre-native-rework-2026-09-05`; obsolete proposals and
inactive worktrees are archived outside the source tree. [DESIGN.md](DESIGN.md) is the contract.
