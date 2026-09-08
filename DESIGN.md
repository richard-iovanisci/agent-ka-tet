# Agent Bridge design

This is the implementation contract and proposed next-phase plan. `PROGRESS.md` records what has passed.
The current prototype is a fixed pair; fleet, shared configuration reconciliation, and telemetry remain planned.

## Product and scope

One local console coordinates Claude Code and Codex while retaining their exact native
interactive sessions in tmux. Prove an implementer/reviewer loop with **1 Claude + 1 Codex**,
then a configurable **2 Claude + 2 Codex** fleet with separate worktrees and exact addressing.
The existing terminal console is first; actions use one authenticated project API. A later
browser uses that API and enters the existing session rather than creating another chat.
Development and execution remain **macOS-only for the next phase**.
Windows and Linux, including WSL2, follow the usable macOS pair. Other harnesses, general runtime adoption, shared
Codex hosts, dependency scheduling, and multi-project orchestration are outside this slice.

The operator sets the brief, required/optional roster, workspaces, permissions, collaboration
scope, and limits. Peer work proceeds within that policy. Trust prompts, unavailable routes,
ambiguity, and exhausted limits surface as Needs you. Completion requires an artifact and
reviewer acceptance; idle turns and process exits never complete tasks.

The prototype fixes the roster to a Claude implementer and Codex reviewer in separate worktrees.
New bypass runs treat both as writers; the earlier validated runs used a read-only Codex sandbox.
Preparation clones a clean committed source into a private run directory outside that checkout,
with independent Git objects and separate worktrees. Accepted linear commits export as a patch;
the bridge never applies, merges, or pushes the result into the source project.
Discard inherited Git environment overrides for both source inspection and native launches.
Tracked Codex hook conflicts are refused before preparation until configuration reconciliation is implemented.

## Native runtime and identity

- Each agent is an unmodified native TUI in a real tmux pane. Supported control endpoints address
  that same session; headless, print/resume, or API conversations are not substitutes.
  Coordinator failure leaves the TUIs usable.
- Launch wrappers directly through tmux argv. Publish pane ownership before native startup, verify
  both wrapper and child processes, and retain exited panes for diagnosis without automatic relaunch.
- `RuntimeAttempt` records run, AgentId, kind, exact native session, canonical checkout, access,
  credential hash, and mutable readiness/pause/revocation flags. Private process/pane records hold
  host ownership separately. Delivery resume and coordinator recovery retain the same attempt.
  The prototype refuses root-session replacement; general replacement/adoption is not implemented.
  Pending messages never follow a replacement silently.
- Mint a scoped credential before launch, initially permitting binding only. Enable agent tools
  after validating the exact root session on the owned host; revoke on replacement. Derive identity
  and authority server-side. Process ancestry or cwd alone is insufficient.
- Keep repository/common metadata, individual writable checkout, effective config destination,
  and runtime attempt/native session as four separate identities. External discovery is read-only.
- Give each Codex runtime an independently supervised private app-server using
  `--listen unix://<state>/codex/<attempt>.sock` and a native TUI attached through `--remote`.
  Place the credential in that host's environment and explicitly allowlist forwarding to MCP.
  Bind hook `session_id` and RPC thread UUID; pane environment is not session evidence.
  Never implicitly use the default user daemon or share a loaded thread between owners.

## Routes and delivery authority

Source investigation used Claude Code **2.1.261** and Codex **0.153.4 (`3d2ee51`)**.
The installed versions passed an authenticated nonce round trip and task/review loop; see `PROGRESS.md`.
This Codex build required experimental `historyMode: legacy` at startup and a native thread name
to persist the empty thread before TUI resume. Peer ingress itself remains `turn/start` + `toolOutput`.

| Traffic | Contract |
|---|---|
| Claude → Claude (fleet target) | Native `SendMessage`/`ListAgents`; observe sender `PostToolUse`, never intercept. |
| Agents → Bridge | Nine authenticated task-run MCP tools for messages, receipts, and task transitions. |
| Bridge → Claude | Per-session stdio Channel prototype under its development flag; no permission relay. Persist before notification; read/ACK provides application evidence. |
| Bridge → Codex | `turn/start` with `input: []` and `toolOutput` on the exact owned thread attached to the native TUI. Omit optional model/cwd/sandbox/settings overrides. |
| Operator → composer | Manual handoff with frozen packet, digest, reservation, and receipt. |
| Unavailable/uncertain route | Hold the durable message and surface Needs you. |

Peer content cannot grant permissions or manufacture operator approval. Never impersonate
`codex_tui`, `codex_app`, or native delegation metadata. Codex tool output is hidden in the TUI;
the console shows envelopes and receipts. The route has no expected-turn guard or caller
idempotency: it starts idle work or joins the then-current steerable turn. Correlate message ID
→ RPC → returned turn → observed `fco_` item → ACK. Retain raw correlated errors; Debug strings
and timeouts never authorize resend or fallback. `FunctionCallOutput` skips `UserPromptSubmit`
ingress only; later tool/permission hooks apply. Use app-server turn/item events for route
activity. Plan-mode admission never grants execution.

Channel availability, draft survival, peer-triggered hook coverage, and provider acceptance
require separate observations; one active-turn exchange does not cover the matrix. Claude native
inbox socket frames remain research-only. Native Claude
routes may reach same-user sessions outside the fleet; Bridge policy there is advisory and
native controls apply. Record actual inbound policy, including plan mode's bypass-class behavior
when bypass is available. Unknown/stale policy never implies acceptance.

**Unattended composer mutation is disabled.** Manual handoffs require fresh operator confirmation
of an empty composer, exact runtime/session binding, semantic idle, and final ownership revalidation
immediately before one bracketed paste and one Enter. Verify exactly one paste; only observation
may be retried. Never paste twice. Focus, time, or earlier composer observations do not prove
exclusive input. Native-route failure never enables terminal fallback. Embedded Codex may expose
a held/cooperative inbox only.

## Durable messages and receipts

Use existing Bun SQLite with runtime attempts, runs/tasks, immutable messages, and delivery
attempts. Conditional SQL and uniqueness constraints suffice; these records are the outbox.
Messages carry schema version, run/task scope, exact sender/recipient attempt and session,
body/digest, creation/expiry, reply/correlation ID, and sender-scoped idempotency key.
Credentials establish authorship; a digest establishes only content identity.

1. Validate scope/idempotency; atomically insert the message and prepared attempt.
   The same idempotency key with different content is a conflict.
2. Conditionally claim `prepared → sending`, fixing route and exact destination; commit before I/O.
3. Record the correlated native result. Fetch, ACK, and reply are independent, idempotent observations.
4. On restart, revalidate never-sent prepared work. Unresolved sending work becomes ambiguous and held.

| Receipt dimension | Values |
|---|---|
| Policy | ready, held, refused, expired, cancelled |
| Attempt | prepared, sending, channel written, native accepted, rejected, ambiguous |
| Application | unread, fetched, acknowledged, replied |

RPC success, notification write, native send observation, turn completion, and ACK prove different
facts. Ambiguity, disconnect, or missing receipts never trigger resend or transport switching.
Prepared work dispatches only after binding, policy, and pause checks.

## Tasks, ownership, and pause

Use minimal task create/claim/update/review operations with expected-version transitions.
Keep implementer results separate from reviewer acceptance. Enforce one Bridge-assigned writer
per canonical checkout within a coordination database, including 1+1. Separate worktrees,
harness-enforced read-only access, or serial assignment suffice; a reviewer label does not.
Private run clones prevent cross-run checkout sharing today. A global lease is not implemented;
shared checkouts across runs require a shared ownership authority before they can be enabled.

Task states are `ready → working → review → accepted`, with `changes_requested → working` for
revisions. Roles and brief are immutable. Submit and review atomically persist their notification;
reply chains enforce the same message and hop limits. Submission verifies a clean implementer
HEAD descended from the recorded base. The reviewer inspects that exact commit, not its own base checkout.

Bridge enforces ownership among its assignments. Filesystem access follows native policy; bypass
does not restrict access to the assigned checkout. Both agents run as the same OS user and can read
private run configuration and each other's credentials. Scoped credentials and reviewer checks
coordinate cooperating agents; they do not isolate a hostile agent. Record those launch settings.
Credential revocation ends Bridge access, not the native
process. Expired ownership means unknown ownership. Reassignment requires verified exit of the old
runtime or explicit operator reconciliation; revocation and logical rebinding do not free a checkout.

Enter/pause blocks new Bridge dispatch to the target and preserves visibility of in-flight work;
it does not interrupt tools or native peer traffic. Explicit resume revalidates binding and policy.
The pair enforces message count, hop count, and run expiry; both agents are required at launch.
Optional rosters and additional throttles belong to the fleet phase.
Show the run expiry independently of agent pause. Expiry blocks resume/start and peer delivery;
native entry and completed results remain available for inspection.

## Observation and configuration

Track process availability, activity and age, route readiness, attention, task state, and ownership
separately. Use authenticated semantic hooks and supported runtime events. Pane capture supports
previews, shell readiness, observational telemetry, and approved terminal verification, never
lifecycle or authority. Unordered overlapping activity
stays unknown; missing completion may leave it stale indefinitely. Time never creates idle, transfers
ownership, or changes session binding. Reconcile with exact runtime/session evidence and persist
the evidence and decision first. Keep the `SessionStart`-while-working guard.

Network services bind loopback only; Unix sockets use private paths and permissions. Authenticate
operator and agent actions separately. Generated config is private and published atomically;
identical regeneration succeeds and conflicting edits are refused. General config reconciliation
must lock destinations, show diffs, preserve/back up originals, and reject stale writes before
it is enabled. Native hook definitions contain no AgentIds or secrets.

The pilot passes run-local Claude settings through `--settings`; **`SessionStart` is command-only**.
Other active lifecycle handlers use HTTP hooks with allowlisted authentication headers and empty
2xx responses. Codex hooks live in the private clone's root `.codex` directory, where native
linked-worktree discovery resolves them. General nested-project hook reconciliation remains open.
Honor native project/hook trust; installed `SessionEnd` and `Interrupt` handlers keep their timeout budgets.

Prepare secret-free Codex hook definitions before launch. Establish native project and definition
trust in a setup TUI, then exit before creating the private host: an already-loaded untrusted
project layer may keep its hooks disabled. The nonce pilot allows five Bridge MCP tools
and preserves native permissions.

Task runs add four role-gated task tools. The private Codex host enables and pre-approves only
those nine Bridge tools; Claude uses the same explicit allowlist. New task runs apply their
prepared native permission profile, defaulting to bypass/YOLO.
The console shows persisted start/task/receipt state, pauses on native entry, and requires explicit
resume after detach or recovery. Closing the console leaves native sessions running.

## Next phase: operator controls

Both lanes accepted the [round-2 reconciliation](docs/reviews/2026-09-07-prototype-review.md#reconciliation-with-claude-round-2).
N1a implements the operator-authorized bypass default and launch controls. P-YOLO passed for
Fable 5.1/high and Astra/ultra with bypass; see `PROGRESS.md` for evidence and observation limits.
The controlled revision pilot also passed, opening N2. Failure qualification remains in N3.

| Step | Deliverable | Acceptance gate |
|---|---|---|
| N1a: launch policy | Per-agent model, supported effort/thinking and permission profile; bypass/YOLO default; explicit overrides; requested/configured/observed status; reviewer checkout check. | Before dispatch: validate configured controls and available startup observations. After bounded peer turns: verify effective settings where supported; missing evidence stays pending. Both possible writers have distinct worktrees. |
| P-REV: early revision pilot | Request changes once, reclaim, revise and resubmit on N1a code before N2. | `ready v1 → working v2 → review v3 → changes_requested v4 → working v5 → review v6 → accepted v7`; four transition notices, no duplicates, final patch verified. |
| N2: console and telemetry | Provider/account quota strip; per-agent model, effort, permission, context and activity; clear pause reason, expiry and message details. | Compare native readings, missing/reset/stale samples and account grouping; collection preserves native status lines and drafts. |
| N3: pair reliability | Requalify revisions plus bounded interruption, disconnect and uncertain-send pilots. | Preserve committed state/artifacts, expose unavailable runtimes and never replay an uncertain send. Host replacement is separate from coordinator recovery. |
| N4: macOS fleet | Configurable 2 Claude + 2 Codex, instance IDs independent of kind/role, per-runtime hosts and worktrees. | Repeated-kind launch, exact targeting, writer exclusion, and native Claude peer observations pass live. |

### Launch configuration

Persist a versioned run specification containing each agent's ID, kind, role, model, effort,
thinking setting where supported, permission profile, workspace and non-secret account reference.
`run defaults` prints JSON; redirect it to a file, edit it, then snapshot it with `run prepare --config`.
New task state is version 2; its launch-settings format is version 1. Generated private state is separate.
Resolve selections before creating native sessions; a private policy digest rejects later edits.
Changing launch settings requires a new run. Unsupported or policy-blocked selections surface
explicitly. Record requested settings, configured native settings and observed changes separately.
Keep existing version-1 runs readable/exportable; apply the new policy only to new run specifications.

Claude receives explicit model/effort/bypass controls. `--model` outranks `ANTHROPIC_MODEL`, while
`CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`. Normalize controls covered by explicit settings,
preserve deliberate inheritance and unrelated provider/auth/network configuration, and test settings
reinjection. Record ignored variable names and disposition, never raw inherited values. Allow native model aliases or explicit IDs; `inherit` preserves Claude's native model selection.
Default Claude effort is high and Codex is Astra/ultra. Claude accepts low/medium/high/xhigh/max or
inherit; Codex accepts none/minimal/low/medium/high/xhigh/max/ultra, subject to native model support.
Codex persistent mode remains outside this launch profile. Reject known incompatible thinking
settings, including thinking-off for Fable 5/5.1 and their Vertex IDs. Explicit thinking-on requests
a Bridge fixed budget of 31,999 tokens. Claude caps fixed budgets against output limits and ignores
the numeric budget under adaptive reasoning; this is neither a native default nor observed use.
Inherit adds no thinking controls.
Unsupported capabilities remain unverified rather than guessed.

Codex host configuration uses `approval_policy="never"` and `sandbox_mode="danger-full-access"`;
thread creation sends `approvalPolicy:"never"`, `sandbox:"danger-full-access"`. The response uses
camelCase fields and `sandbox:{type:"dangerFullAccess"}`. Preserve that configured response in the
client API and run record, including the response from the existing binding operation. Missing or
unparsed optional settings do not invalidate a certain thread UUID: bind it, show the metadata gap,
and retain the explicit readiness gate. Identity failures remain ambiguous and are never replayed.
Attached-TUI flags are insufficient for an already subscribed thread.
Peer delivery never changes these settings; metadata readers never resume a thread merely to inspect it.

Claude effort starts as configured until a supported hook or status-line sample reports it. Optional
SessionStart model data and later hook permission/effort data supplement the launch record; N1a
does not require the N2 collector. Exact-session Codex hooks report the native turn's configured
model, not proof of the model served by the backend. Codex hook permission mode is too coarse to
represent its policy, and effort remains unobserved. Native substitutions stay visible.

Separate reviewer role from effective filesystem capability. With bypass enabled, both agents
must be treated as potential writers even when the reviewer is instructed not to edit. Preserve
separate checkouts, Bridge assignment exclusion, scoped credentials and run/message limits, within
the same-user limitation above.
Before a review transition, verify the assigned reviewer checkout is clean and its HEAD equals
the recorded base; reject without a task/notice write on failure. Each artifact/reviewer Git command
has a five-second timeout. This checks current Git state,
not filesystem immutability. Describe the review-only instruction without claiming sandbox enforcement.

N1a changes `pilot/config.ts`, `pilot/process.ts`, `native/codex.ts`, `pilot/server.ts` and the
artifact/reviewer checks. Validate wire allowlists, argv/environment precedence, effective-response
retention, new/old run loading, writer conflicts and review rejection. The existing transaction
core stays the task authority. Full quota/context collection and console redesign start in N2.

### Telemetry and presentation

Use Claude's documented status-line JSON and Codex's owned app-server reads/notifications first.
The researched surfaces and version/account caveats are in the [review packet](docs/reviews/2026-09-07-prototype-review.md#native-capability-research).
Collect bounded latest snapshots, not full transcripts. Credential and exact-session validation
associate agent samples; telemetry never grants readiness, identity, delivery or permission authority.

Context belongs to the exact runtime/session. Quota belongs to provider/account and limit bucket;
merge sparse updates and deduplicate shared observations. Claude needs an explicit account reference
until a supported identity source is integrated and validated. Never fabricate account identity or sum quota percentages.
Keep cumulative token consumption separate from active context and estimated cost separate from quota.

Show source and collection time, provider sample time when known, and stale/unavailable states.
Receiving cached data again does not make provider data fresh. Handle compaction, resets, account
changes and reconnects explicitly. Missing telemetry does not stop an otherwise valid task.

Compose any existing Claude status-line command without replacing its output or unrelated settings.
Native hooks report permission mode when an event fires; use filtered OpenTelemetry if immediate
mode-change events are required. Scraping is a fallback for demonstrated gaps.
Hidden admin TUIs remain deferred; they cannot measure another session's context. Collection never
types a usage command into a working agent's composer.

The console keeps Enter as pause-and-take-control. Show which agent was paused and why; persist
operator/automatic pause causes with the state change. N2 must add observations at operator pause/resume/native entry; these causes are not written yet.
Queries must retrieve the latest cause independently of the activity window. Native `serverRequest/resolved`
already clears pending approval attention; turn completion is not a substitute resolution receipt.
Show current route readiness separately: prepared-message policy refreshes, while completed
receipts retain history. Show expiry in local time and readable task/message details.
Channel `written` may display as `emitted`.
Retain the terminal console first; a later browser can use the same authenticated project API.

## Proof gates

1. Native 1+1 pilots: private host/binding/trust, Channel, attached-TUI Codex tool output,
   peer-triggered hooks, read/ACK, drafts, interruption/reconnect, and ambiguous outcomes.
2. Durable macOS pair: implement → review → accept without manual relay, with correct restart,
   writer exclusion, pause/resume, limits, held inbox, console receipts, and native entry.
3. macOS 2+2 fleet: repeated-kind launch/config/attribution, separate worktrees, exact addressing,
   and observed native Claude peer traffic without concurrent Bridge-assigned checkout writers.

Prepare named authenticated pilot procedures. Offline fixtures and source support cannot satisfy native gates.
