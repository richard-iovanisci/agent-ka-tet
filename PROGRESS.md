# Status

Updated: 2026-09-08. **The macOS 1+1 prototype passed the operator's implement/review/accept
cycle, final acknowledgment, and exported-patch validation.**

## Working

- Claude implements; Codex reviews the exact committed artifact in a separate worktree.
- Versioned task claim, submit, and review operations persist with their peer notifications.
- Native Claude Channel and Codex tool output carry messages with separate delivery/read/ACK receipts.
- The console shows tasks and receipts, opens either native TUI, and supports pause/resume.
- Run expiry is shown separately from agent pause; expired runs retain native entry and inspection.
- Native startup uses direct tmux argv with a pane ownership barrier, avoiding interactive shell prompts.
- Live recovery preserves native sessions and prepared messages; fixtures verify uncertain sends stay held.
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
Codex's peer-triggered review also exercised command approval: saved request 146 and resolution 147
correlate to the review turn. This is one live approval case, not coverage of every request class.
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

The operator closed this round. Both agents' Bridge delivery is paused, with native sessions retained.
Evidence: `.bridge/pilots/2026-09-07-round-closed.json`.

## N1a implementation

Design reconciliation is complete. New task runs snapshot per-agent launch settings and default to
bypass/YOLO. Host/thread settings, Claude argv/environment, version-1 compatibility, native settings
status and a clean-at-base reviewer check are implemented on `codex/n1a-launch-policy`.
The September 8 review fixes add Claude xhigh/Codex max, Vertex thinking validation, exact-session
Codex model observations, tolerant optional settings parsing, existing binding-response retention,
and bounded artifact/reviewer Git commands. They preserve thread identity and no-replay behavior.
P-YOLO passed on September 8 using `282517b`: run `06db59ce23a4` reached **accepted v4**,
artifact `20db315a8cd837ad84efb98662a1ad20e851aee4`. Exactly three messages were read/ACKed;
the Codex peer item matched its stored envelope, with no approval requests recorded. Claude hooks
reported high effort/bypass and resolved Fable 5.1; Codex peer hooks reported Astra, matching
the startup Astra/ultra/never/full-access configuration. Codex effort remains configured-only.
Both agents remained unpaused after normal completion. Independent artifact validation in a new
clone passed **9 tests, 0 failures, 13 assertions**; source/reviewer remained clean at base.
Evidence: `.bridge/pilots/2026-09-08-pyolo-{native-evidence,artifact-check}.json`.
P-REV then passed on the same product code: run `32a38542fe44` reached **accepted v7**.
Native tool results confirm all six transitions from v1 through v7. The first commit
`fe752697b581edc55705f251e3cedfaf91e074cf` omitted the fallback as instructed; final commit
`4b1787acec4d29ef45aad05c4f60cc56ef949fac` added it as a direct child. All five messages were
read/ACKed and both Codex peer items matched their immutable envelopes. This proves the controlled
revision workflow, not unaided defect discovery. Both runs' exported patches apply and exactly
reproduce their accepted trees. Independent normal Bun runs passed **6 tests / 6 assertions** for
the first commit and **9 tests / 11 assertions** for the final commit; five separate probes confirmed
the actual fallback correction. Evidence: `.bridge/pilots/2026-09-08-prev-{native-evidence,artifact-check,export-check}.json`.
Peer-turn draft preservation under bypass and the failure matrix remain unexecuted.

## Limits and next steps

- Claude uses a development Channel; this Codex build needs experimental legacy history at startup.
- Native project/hook trust must precede the private Codex host. Tracked Codex hook conflicts are
  refused before preparation; automatic configuration merging remains open.
- The run has 32 messages, an eight-hop limit, and four hours. It supports one task and a fixed pair.
- Forced interruption, provider disconnect, and uncertain native outcome matrices remain open.
- Improve the console, shared provider/account quota visibility, and per-session context.
  These telemetry features remain unimplemented. Research found documented Claude
  status-line fields and Codex app-server APIs/events; installed-session collection is still untested.
  Native collection comes first; scraping and hidden admin sessions are deferred fallbacks.
- Next: N2 telemetry/UI; other launch profiles remain unqualified.
  General failure qualification and configurable 2+2 follow. Windows and Linux/WSL2 remain later work.

Next sequence and gates: [DESIGN.md](DESIGN.md#next-phase-operator-controls).
Phase evidence, capability sources and Claude review prompt: [review packet](docs/reviews/2026-09-07-prototype-review.md).

## Checks

September 8 review fixes: `scripts/check.sh` passed **419 tests, 0 failures**, 3,197 assertions
across 32 files (55.55 s), typecheck and whitespace checks. The script now checks both staged and
unstaged whitespace and records that result. Evidence: `.bridge/reviews/2026-09-08-n1a-review-check.log`.

September 7 N1a `scripts/check.sh`: **405 passed, 0 failed**, 3,051 assertions across 32 files (44.97 s);
typecheck passed. A separate `git diff --check` passed; it was not part of that saved script log.
The first run hit an existing tmux shell-fixture timeout.
The fixture now disables user shell startup files while preserving real tmux/bracketed-paste checks.
Evidence: `.bridge/reviews/2026-09-07-n1a-final-check.log`.

Pause-notice clarification: **15 console tests passed**, 208 assertions; typecheck passed.

Full suite for `b18ad69`, before the pause-notice wording change: `scripts/check.sh` reported
**367 passed, 0 failed**, 2,768 assertions across 29 files (56.81 s);
typecheck passed, with whitespace checked separately. Tests cover task roles, version conflicts, atomic notifications,
Git isolation/export, protocol/recovery, and real tmux/PTY console behavior.
Directory split: **13 native/coordination/pilot/run files, 180 tests**; **16 shared/earlier files,
187 tests**, including shared modules changed during the rework. This is not a new-versus-old test count.

Repository history is retained at `archive/pre-native-rework-2026-09-05`; obsolete proposals and
inactive worktrees are archived outside the source tree. [DESIGN.md](DESIGN.md) is the contract.
