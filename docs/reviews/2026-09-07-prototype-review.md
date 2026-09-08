# macOS prototype: phase review

2026-09-07. For Fable/Claude review. Implementation baseline: `15b6f4d` on
`codex/native-messaging-pilot`, compared with `a2482b1`. Later documentation commits contain this packet.
[DESIGN.md](../../DESIGN.md) remains the contract; this is a review snapshot, not another specification.
[Draft PR #2](https://github.com/richard-iovanisci/agent-ka-tet/pull/2) tracks the implementation.

**Verdict: the successful-path macOS 1+1 prototype is validated.** Close this testing round and
review the next plan. This is not qualification of the full failure matrix, a configurable fleet,
or operation with permission bypass. Both agents' Bridge delivery is paused; native sessions and
the accepted patch are retained. No new authenticated telemetry or failure pilots ran during planning.

## Implemented

| Area | Current behavior | Main code |
|---|---|---|
| Native runtimes | Real Claude and Codex TUIs in tmux; direct argv startup and verified wrapper/child ownership; independent private Codex host. | `src/pilot/{panes,process,processState}.ts`, `src/mux/tmux.ts` |
| Messaging | Claude development Channel and exact-thread Codex `turn/start`, empty input plus tool output; authenticated message read/ACK; no unattended composer injection. | `src/native/{codex,mcp,hook,unixWebSocket}.ts`, `src/pilot/server.ts` |
| Coordination | Exact runtime/session binding, persisted intent before I/O, scoped idempotency, separate transport/read/ACK/reply receipts, held ambiguity, explicit recovery. | `src/coordination/{store,types}.ts` |
| Task loop | Claude implementer / Codex reviewer; expected-version claim, submit, accept or request changes; task transition and peer notice commit together. | `src/coordination/store.ts`, `src/run/prompts.ts` |
| Operator console | Select, enter native TUI, pause/resume, start once, inspect task/messages/expiry, exit without ending sessions. Entry pauses the selected recipient. | `src/run/console.ts`, `src/pilot/cli.ts` |
| Artifact | Clean committed source cloned without shared Git objects; separate worktrees; exact committed review; accepted linear history exports as a patch. | `src/pilot/config.ts`, `src/run/artifact.ts` |

Task runs allow nine Bridge tools. Native permissions remain in force in the tested version:
Claude launched in default mode and the operator later selected accept-edits; Codex's tested
thread used Astra/ultra, read-only sandbox and on-request approvals. Default bypass is next work.

Key commits: native pilot `3e2eb80`; qualified nonce/startup `ee2cdb1`; task prototype `5378bc3`;
expiry display `5fbcc85`; direct pane startup `b18ad69`; clearer entry-pause notice `15b6f4d`.
The rework also removed obsolete retirement/migration paths; legacy commands still exist and are
included in the total test count. This phase did not replace every historical module.

## Evidence and limits

| Check | Result | Qualification |
|---|---|---|
| Full automated suite | 367 passed, 0 failed; 2,768 assertions, 29 files; typecheck passed. | At `b18ad69`; includes legacy tests. Saved log: `.bridge/direct-start-final-check-2.log`. |
| Latest console change | 15 passed, 0 failed; 208 assertions; typecheck passed. | Pause-notice wording at `15b6f4d`; includes real tmux/PTY attach/detach. |
| Suite directory split | 13 native/coordination/pilot/run files: 180 tests; 16 shared/earlier files: 187 tests. | Parsed from the saved full-suite log; shared files also contain rework changes. |
| September 5 nonce | Channel PING / Codex PONG read and acknowledged; active-turn Codex ingress; owned shutdown verified. | Run `8b3fa7aa256f`; Claude 2.1.261 / Codex 0.153.4. |
| September 5 task | Implement → review → accept, three ACKed messages, one operator ingress and one correlated peer tool-output item. | Run `d215cc7c163f`; both unsent drafts survived peer delivery and were absent from submitted records. |
| Coordinator recovery | Native TUIs, host and exact identities survived; same prepared review notice/request dispatched once after confirmation. | Live proof covers never-sent work. Ambiguous in-flight recovery is fixture-only. |
| Codex native approval | Peer-origin review produced command approval request 146 and resolution 147; operator approval is visible in the supplied screenshot. | One live on-request case; broader request classes and failure handling remain unqualified. |
| September 7 manual test | Focus, pause/resume, detach draft preservation, complete task cycle and final ACK passed. | Run `32fe38630f90`; Claude 2.1.263 / Codex 0.153.4. Peer-turn draft preservation was not repeated manually. |
| Export | Both task patches passed eight normal Bun tests in separate clones. Latest patch exactly matches the accepted Git tree. | Source and reviewer remained clean at the recorded base. |

Latest run: `5860b165-159e-40fe-9ab2-789c0e88560a`; task `342e3821-3224-4b55-8a4f-8b69d8b1c545`,
accepted v4. Base `a875fc206fe040bf105f09d7f298d56852e2c3a9`; artifact
`32f8c1c76381a305880c0fbbaf67a5b271a0f94e`. Exactly three messages and delivery records; all messages
read/ACKed, with the review request also replied. Codex's peer item matches the stored envelope
byte-for-byte. Independent review ran eight committed callbacks plus four additional assertions
in memory; exported-patch validation subsequently used the normal runner.

Private evidence under the repository root:

- `.bridge/pilots/2026-09-05-{native-round-trip,shutdown,task-native-evidence}.json`
- `.bridge/pilots/2026-09-05-task-{before-recovery,after-recovery,export-verification}.json`
- `.bridge/pilots/2026-09-07-{operator-checks,task-export-verification,round-closed}.json`
- Draft captures, direct-start failure evidence and ready snapshots alongside those files.

The retained run is `/Users/richardiovanisci/Projects/agent-ka-tet-manual-run-2026-09-07-2`;
its `result.patch` is the accepted export. Do not read `pilot.json`, credential/key files or raw
environment dumps when reviewing; they are unnecessary to verify these results.

### Corrections incorporated during this audit

- Normal completion does not pause delivery. Native entry pauses the selected agent; the old
  footer obscured the cause. Exact historical operator action sequences lack a durable pause audit.
- Current runtime rows have mutable state; host/pane ownership uses separate files. Recovery and
  delivery resume preserve the attempt. General runtime replacement/adoption is not implemented.
- Writer exclusion is within a SQLite store. Private clones prevent current cross-run sharing;
  there is no global checkout lease.
- Generated configuration permits identical regeneration and refuses conflicts. General locked
  merge/backup reconciliation is a future requirement. Claude receives run-local `--settings`.
- Claude-to-Claude fleet routing, optional roster behavior and additional throttles are targets,
  not completed pair features. Historical handoff commands are separate from the nine task-run tools.

## Proposed next features and strategy

The operator's priorities are firm: better UI; model and thinking controls before task start;
default bypass/YOLO for both; shared quota visibility and per-session context. macOS remains the
execution platform. The implementation order and acceptance gates are proposed for review:

1. **N1a — launch policy.** Versioned per-agent settings, supported model/effort choices, bypass
   default with explicit override, native settings evidence, correct writer capability and reviewer
   checkout validation. Run the revision-loop pilot immediately afterward, before N2.
2. **N2 — console and native telemetry.** Account quota strip and agent details; context and model
   state; explicit pause reasons, local expiry and readable message/task detail. Native data first.
3. **N3 — qualify the pair.** Revision loop, interruption/disconnect cases and uncertain-send
   recovery, including a rerun of the task/draft checks under the new permission defaults.
4. **N4 — configurable 2+2.** Separate instance identity from kind/role throughout launcher,
   host routing, credentials, tasks, hooks and workspaces. Prove exact repeated-kind attribution.

Detailed contract: [next phase](../../DESIGN.md#next-phase-operator-controls). Defer browser UI,
hidden quota-admin TUIs, shared hosts, cross-run shared checkouts and Windows/Linux/WSL2.
Observational scraping remains available for a demonstrated native-data gap; it never becomes a
lifecycle or delivery source. No usage command is typed into a working agent's composer.

## Native capability research

Access date for every source below: **2026-09-07**. D = documented interface; S = pinned-source
behavior; P = proposed integration. None of these findings is a live Bridge telemetry pass.
Codex source pin: `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (0.153.4), cross-checked against
installed schema caches. Claude installed help/version: 2.1.263.

| Capability | Finding and consequence | Evidence |
|---|---|---|
| Claude controls | D: explicit model and effort launch flags; environment can override effort; thinking is model-dependent. Select supported values, preserve requested/observed distinction. | [Model configuration](https://code.claude.com/docs/en/model-config.md), [environment](https://code.claude.com/docs/en/env-vars.md), [CLI](https://code.claude.com/docs/en/cli-reference.md) |
| Claude bypass | D: `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` selects bypass; the allow flag only makes it available. Native setup/managed restrictions still apply. | [Permission modes](https://code.claude.com/docs/en/permission-modes.md) |
| Claude telemetry | D: status-line JSON exposes session ID, live model/effort/thinking, context and conditional quota windows. Quota follows an API response; fields may be absent or reset. No account ID or permission mode is included. P: compose a bounded collector with the existing status line; group through a non-secret account reference. | [Status-line schema](https://code.claude.com/docs/en/statusline.md) |
| Claude permission state | D: native hooks expose permission mode; filtered OpenTelemetry can report mode changes and account attributes. P: reuse hooks first and add OTel only for a demonstrated gap. | [Hooks](https://code.claude.com/docs/en/hooks.md), [monitoring](https://code.claude.com/docs/en/monitoring-usage.md) |
| Codex controls | S: paginated `model/list` reports supported efforts; thread creation/read exposes configured model/effort. Settings notifications are experimental; configured model is not proof of every response's served model. | [Model schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/model.rs#L53-L154), [thread metadata](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/README.md#L355-L364) |
| Codex YOLO | S: set private-host `approval_policy="never"`, `sandbox_mode="danger-full-access"` and matching explicit thread policy before creation. Existing read-only fields override defaults; subscribed-thread resume can ignore overrides. | [Host dispatch](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/cli/src/main.rs#L1245-L1302), [resume handling](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_processor.rs#L4166-L4216) |
| Codex quota | D/S: `account/rateLimits/read` and sparse update notifications expose account buckets; API-key-only authentication is unsupported by this handler. Merge by account/limit; do not sum snapshots or invent model/bucket mappings. | [App-server docs](https://learn.chatgpt.com/docs/app-server), [handler](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/account_processor.rs#L1131-L1208) |
| Codex context | S: `thread/tokenUsage/updated` separates cumulative usage from latest context and capacity. Native percentage uses its own baseline; do not divide cumulative tokens by context capacity. | [Usage schema](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1830-L1910), [TUI calculation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tui/src/token_usage.rs#L9-L53) |

Codex integration should reuse the owned client's existing observations: process account events
before thread filtering and stop discarding token-usage updates. Keep telemetry as bounded latest
snapshots, separate from delivery observations. Read-only metadata polling must not call resume,
which can advance queued work. Account changes invalidate prior account associations.

Unknown is not zero. Context, quota, cumulative consumption and estimated cost are different values.
Record collection time and source age separately where possible: rerunning a status-line script
does not establish that its cached provider data was refreshed. Native support makes hidden admin
sessions unnecessary for the first collector; installed-account field coverage still needs a pilot.

## Reconciliation with Claude (round 2)

Claude's feedback is preserved verbatim at `.bridge/reviews/2026-09-07-claude-prototype-feedback.md`,
copied from its isolated worktree. Codex accepts the narrower N1a milestone and early revision
pilot. The corrections below were checked against existing evidence, source and current docs;
Claude accepted C1–C6 and all U1–U7 dispositions in its final round-2 feedback.
Consensus is complete; N1a implementation follows in `codex/n1a-launch-policy`. No live pilot ran
during reconciliation. The exact acceptance is preserved at
`.bridge/reviews/2026-09-07-round-2-feedback.md`. Claude disclosed non-Astra delegation;
Codex independently verified the consequential findings with Astra/ultra agents.

| Decision | Codex response |
|---|---|
| R1: sequence | Accept N1a → revision pilot → N2 → N3 → N4; macOS and terminal console first. |
| R2: launch evidence | Accept explicit controls and requested/configured/observed records. Correct model precedence, hook effort coverage and exhaustive model allowlisting (C2). Missing startup fields stay pending; later native evidence completes the gate. |
| R3: permissions | Accept wider wire allowlists, configured host/thread policy, both bypass runtimes as writers and a clean-at-base reviewer check. Rewrite the prompt as a no-edit instruction, not a read-only enforcement claim. Normalize native response shape (C3). |
| R4: telemetry | Accept native collection, composed status line, account scoping and latest snapshots. Preserve null/reset/compaction distinctions. Several U items are closed by source below. |
| R5: console | Accept durable pause reasons and clearer labels. Withdraw the claimed permanent-pending defect: resolution already forwards and passed live (C1). Prepared policy refreshes; completed receipt policy does not. |
| R6: pilots | Accept the coverage goals with corrected revision, interruption, host-loss and settings procedures (C4). No unexecuted case becomes a pass. |
| R7: audit | Accept the fixed-pair inventory. Correct reversed file counts, approval coverage and the purported undocumented MCP knob (C1/C5/C6). |

### Accepted corrections

- **C1 — approval handling works in the recorded case.** Bridge's generic forwarding persists
  exact-thread `serverRequest/resolved`, and `activity()` removes that request. September 5 task
  observations **146 → 147**, request `0`, belong to peer review turn
  `01a07401-d0e4-7e32-946d-339b63939c41`, not the kickoff. The operator approved the Bun preload
  command. The [native producer](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L816-L838)
  emits the resolution to subscribers. Add a focused request/resolution regression; do not clear
  requests by assuming that turn termination resolved them. Broader approval failures remain open.
- **C2 — Claude controls.** `--model` overrides `ANTHROPIC_MODEL`; the effort environment variable
  instead overrides `--effort`. Tool-context hooks can report effective effort after a turn begins.
  N1a can show configured effort initially and observed effort later without the N2 collector.
  Record stripped variable names/disposition, not raw values. Use known presets plus explicit IDs;
  reject thinking-off for documented Fable 5/5.1, not unknown future models. Bypass may be entered
  later if enabled at startup. Sources: [CLI](https://code.claude.com/docs/en/cli-reference.md),
  [hooks](https://code.claude.com/docs/en/hooks.md), [environment](https://code.claude.com/docs/en/env-vars.md),
  [model configuration](https://code.claude.com/docs/en/model-config.md), [permission modes](https://code.claude.com/docs/en/permission-modes.md).
- **C3 — wire values and stable reads.** Request: `approvalPolicy:"never"`,
  `sandbox:"danger-full-access"`. Response: `approvalPolicy:"never"`,
  `sandbox:{type:"dangerFullAccess"}`, camelCase `reasoningEffort` and `modelProvider`.
  Rust member names are not JSON keys. Use private-host configuration overrides plus explicit
  thread fields. `account/rateLimits/read` is stable; backend/account access is the gate.
  Its public response has `accountId`, not `userId`. Sources: [policy inputs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/shared.rs#L171-L309),
  [thread response](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L178-L207),
  [stable request](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/common.rs#L1234-L1238),
  [quota response](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L311-L325).
- **C4 — pilot mechanics.** See the corrected procedures below. A live revision was not performed;
  two task runs accepted first submissions, while the third cited run was a nonce exchange.
- **C5 — test counts.** The directory split is **13 new-module files / 180 tests** and
  **16 shared/earlier files / 187 tests**, not the reverse. Evidence:
  `.bridge/reviews/2026-09-07-test-counts.json`, derived from the saved full-suite log.
- **C6 — MCP compatibility is documented.** `MCP_PROTOCOL_NEGOTIATION=legacy` preserves the
  earlier stdio handshake. With `auto`, negotiation of revision `2026-07-28` prevents Channel
  registration. Preserve the launch setting and requalify upgrades; it is not necessarily needed
  when the environment is otherwise unset. [MCP runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes),
  [Channel negotiation](https://code.claude.com/docs/en/mcp#push-messages-with-channels).

All sources in this reconciliation were accessed **2026-09-07**; Codex remains pinned to 0.153.4.

### Unresolved-ID disposition

| ID | Disposition |
|---|---|
| U1 | Closed from installed schema/source: exact request and response values in C3. |
| U2 | Closed as a strategy: host `-c` overrides plus matching explicit thread policy. Live N1a retention remains to test. |
| U3 | Operator-provided, non-secret account reference for N1/N2. Native identity integration later if needed. |
| U4 | Experimental-gate question closed: stable API. Actual account coverage/payload completeness still needs a pilot. |
| U5 | Implementation work: compose the effective status-line command, preserve multiline output/settings, and use bounded atomic snapshots. Fixtures and a live check remain. |
| U6 | One peer-origin command approval passed live; requests fan out to subscribers. Other tool classes, overrides and disconnect behavior remain gated. |
| U7 | Documentation question closed by C6; retain the versioned Channel compatibility regression. |

### Corrected pilot requirements

These are unexecuted procedures for the next testing round, using named disposable runs.
The completed fixture remains evidence for this review.

| Pilot | Setup/action and required evidence |
|---|---|
| P-YOLO (N1a) | Fresh pair with explicit settings. Validate launch/start responses, available hooks and one bounded peer turn each. Missing startup observations stay pending; substitutions stay visible. Inspect with read-only metadata/native events, never `thread/resume` as a probe. |
| P-REV (before N2) | In a controlled fixture, have the reviewer request one real missing requirement, then revise and accept. Expect v1→v2→v3→v4→v5→v6→v7; notices only at v3/v4/v6/v7, plus any separate kickoff. Verify distinct commits, final patch and no duplicate notices. |
| P-INT | Interrupt an active peer turn before review acceptance. Expect `turn/completed` with `turn.status:"interrupted"` and exact turn identity. Preserve prior committed task state and accepted transport; no replay or invented transition. Native entry's pause is separate. |
| P-AMB | Suspend only the owned disposable host after verifying its PID/birth identity; dispatch one already-prepared notice and allow the RPC timeout. Restore it in a guaranteed cleanup path. Expect ambiguous/held receipt and no resend even if a late item arrives. |
| P-DISC | Separate coordinator recovery with a live host from host-loss containment. A killed host must make the route unavailable and preserve held/uncertain work. `run recover` only restarts a dead coordinator; native host replacement is a separate unimplemented contract. |
| P-APPR / P-DRAFT-PEER | Extend the existing successful command-approval case across offered permission profiles; preserve exact native routing/resolution. Independently repeat unsent-draft survival through peer turns under the new defaults. |
| P-TELEM-CL / P-TELEM-CX / P-ACCT | Compare native samples, compaction, reset and unavailable values. Use a separate approved account fixture for login/auth changes, not the operator's shared live account. Validate account invalidation and status-line composition. |

N1a also needs a reviewer-check fixture: dirty checkout or HEAD away from base refuses both review
decisions without writing a task transition or notification. This is a current-state check, not a
sandbox. Do not treat an arbitrary `workspace-write` operation as guaranteed to request approval;
P-APPR must select a command that the configured native policy actually prompts for.

## N1a review follow-up — September 8

Claude accepted N1a for P-YOLO after two fixes. Its verbatim feedback is preserved at
`.bridge/reviews/2026-09-07-n1a-feedback.md`. The follow-up on `codex/n1a-launch-policy`, compared
with `444e2da`, addresses both required changes and the merge recommendations. No live session
was touched. [Draft PR #3](https://github.com/richard-iovanisci/agent-ka-tet/pull/3) remains stacked on #2.

| Finding | Resolution |
|---|---|
| Effort choices | Add Claude xhigh and Codex max. Persistent is deferred: it enables additional native instructions and no model advertises it at the pin. Native model support still applies. |
| Codex observations | Read model from exact-session native hooks. This reports native turn configuration, not backend-served model proof. Keep observed effort and permission unset. |
| Optional settings | Bind a valid thread UUID even if settings parsing fails; show a fixed `unparsed` status. Preserve malformed-identity ambiguity and never retry creation. |
| Binding response | Retain settings from the existing `thread/resume` binding response, without adding an RPC. Sparse metadata preserves the timestamped creation snapshot; explicit parse failure stays visible. |
| Reviewer Git | Bound each artifact/reviewer Git command to five seconds. Failed validation precedes task/notice mutation. |
| Vertex thinking | Reject thinking-off for documented Fable 5/5.1 Vertex IDs; do not guess future-model constraints. |
| Documentation | Correct stdout redirection, fixed-budget semantics and historical whitespace-check attribution. Document same-user credential access under bypass. |

Sources rechecked **2026-09-08**: Claude [model/effort configuration](https://code.claude.com/docs/en/model-config.md),
[thinking environment](https://code.claude.com/docs/en/env-vars.md), and
[Vertex IDs](https://code.claude.com/docs/en/google-vertex-ai.md); Codex
[effort enum](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/openai_models.rs#L47-L78),
[advertised models](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/models-manager/models.json),
[persistent instructions](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/context/world_state/persistent_mode.rs#L57),
[hook model source](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/hook_runtime.rs#L151-L157), and
[permission mapping](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/hook_runtime.rs#L1003-L1010).
One precision correction: Codex hook permission mode is a coarse approval-policy mapping,
not a universal placeholder. It still cannot represent the complete native permission profile.

Offline validation: **419 tests passed, 0 failed**, 3,197 assertions across 32 files; typecheck
and whitespace checks passed. P-YOLO and then P-REV remain unexecuted. Missing native evidence
does not become a pass through source inspection or these fixtures.

## Prompt for Claude

```text
Review N1a in the sibling agent-ka-tet-n1a worktree on codex/n1a-launch-policy.
Read this packet's September 8 follow-up, DESIGN.md's launch configuration and
PROGRESS.md's checks. Compare the follow-up against 444e2da; the original N1a
review and C1-C6 are settled.

Focus on the two required fixes, optional-settings failure versus thread identity,
retention of the existing binding response, bounded reviewer checks, and the
documentation corrections. Report concrete blockers or accept for P-YOLO, then P-REV.
Source/offline passes do not qualify native settings retention or a live revision loop.

Keep the implementation worktree read-only. Do not launch, drive, stop or send to
any authenticated session. Use only GPT-6 Astra with ultra reasoning if delegating;
otherwise review directly. Write feedback in your own worktree's ignored
.bridge/reviews/2026-09-08-n1a-followup-feedback.md and return its exact path.
```
