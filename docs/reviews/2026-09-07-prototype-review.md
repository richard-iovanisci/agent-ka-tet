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
| September 5 nonce | Channel PING / Codex PONG read and acknowledged; active-turn Codex ingress; owned shutdown verified. | Run `8b3fa7aa256f`; Claude 2.1.261 / Codex 0.153.4. |
| September 5 task | Implement → review → accept, three ACKed messages, one operator ingress and one correlated peer tool-output item. | Run `d215cc7c163f`; both unsent drafts survived peer delivery and were absent from submitted records. |
| Coordinator recovery | Native TUIs, host and exact identities survived; same prepared review notice/request dispatched once after confirmation. | Live proof covers never-sent work. Ambiguous in-flight recovery is fixture-only. |
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

1. **N1 — launch controls.** Versioned per-agent settings, supported model/effort choices, bypass
   default with explicit override, effective native policy reporting, and correct writer capability.
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

## Review questions

Please return **accept / amend / reject** for each ID, with concise evidence and an exact amendment:

- **R1 — scope and order:** N1/N2 before N3 and N4; terminal console first; macOS only.
- **R2 — launch contract:** model/effort configuration before native session creation; requested
  versus configured versus observed values; native policy overrides and unsupported settings.
- **R3 — bypass default:** already authorized for both agents; update host/thread policy and
  effective access records without treating a reviewer role as read-only enforcement.
- **R4 — telemetry:** status-line plus existing app-server client; per-session context and shared
  account quota; status-line composition, sparse merges, stale/reset/account-change handling.
- **R5 — UI semantics:** retain pause-on-entry; persist reasons; distinguish current readiness
  from completed receipts; improve detail views without changing native session identity.
- **R6 — proof gaps:** exact revision, uncertain-send and failure procedures required before
  calling the pair durable; account/permission/context pilots before claiming those features work.
- **R7 — implementation audit:** any remaining overstatement, defect or missing boundary in this
  report/current code. Prioritize concrete failure traces over a broader architecture rewrite.

For each new pilot, specify setup, one bounded action, exact observation and pass/fail. Design
only during review. Keep established successful-path evidence separate from unexecuted scenarios.

## Prompt for Claude

```text
Review Agent Bridge's completed macOS prototype and proposed next phase as Fable/Claude.
Repository: /Users/richardiovanisci/Projects/agent-ka-tet (read-only during your review).
Implementation baseline: 15b6f4d; compare against a2482b1. Read current documentation after it.

Start with docs/reviews/2026-09-07-prototype-review.md, then AGENTS.md, PROGRESS.md, DESIGN.md,
and README.md. Inspect the code/evidence cited in the packet as needed. Your older proposal
worktree does not contain the current implementation; do not treat its files as current authority.

Respond specifically to R1-R7: accept/amend/reject, evidence, exact proposed changes, and the
smallest next implementation milestone. Verify load-bearing native capability claims from the
linked primary sources. Label documented, source-inferred, live-tested and unresolved separately.
Use an independent perspective; do not just ratify the plan. Keep the response lean.

This is review/planning only. Do not resume, start, stop, send to or drive native sessions; do not
read credentials or change tracked files, native settings or source/fixture worktrees. Do not
re-run authenticated pilots. No need to rerun the broad suite unless investigating a concrete gap.
User preference: minimal code comments/docs, native TUIs, macOS first, model/effort controls,
default bypass/YOLO for both, quota/context visibility. The bypass preference is already settled.
Review personally; if delegating, use only GPT-6 Astra with ultra reasoning as the user required.

Write feedback to /Users/richardiovanisci/Projects/agent-ka-tet/.bridge/reviews/2026-09-07-claude-prototype-feedback.md.
End with your verdict, unresolved decision IDs, and that path. Confirm tracked files are unchanged.
```
