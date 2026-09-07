# Agent Bridge design

This is the implementation contract. `PROGRESS.md` separates implemented behavior from outstanding work and pilots.

## Product and scope

One local console coordinates Claude Code and Codex while retaining their exact native
interactive sessions in tmux. Prove an implementer/reviewer loop with **1 Claude + 1 Codex**,
then a configurable **2 Claude + 2 Codex** fleet with separate worktrees and exact addressing.
The existing terminal console is first; actions use one authenticated project API. A later
browser uses that API and enters the existing session rather than creating another chat.
All development and execution are **macOS-only until the working prototype passes**.
Windows and Linux, including WSL2, follow. Other harnesses, general runtime adoption, shared
Codex hosts, dependency scheduling, and multi-project orchestration are outside this slice.

The operator sets the brief, required/optional roster, workspaces, permissions, collaboration
scope, and limits. Peer work proceeds within that policy. Trust prompts, unavailable routes,
ambiguity, and exhausted limits surface as Needs you. Completion requires an artifact and
reviewer acceptance; idle turns and process exits never complete tasks.

The first prototype fixes the roster to a Claude implementer and read-only Codex reviewer.
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
- An immutable `RuntimeAttempt` records run, AgentId, kind, host mode, owned host/pane, exact native
  session, credential reference/revocation, canonical checkout, and access mode. Each launch/resume
  creates a new attempt; same-process conversation changes require an explicit validated binding
  transition. Pending messages never follow a replacement silently.
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
| Claude → Claude | Native `SendMessage`/`ListAgents`; observe sender `PostToolUse`, never intercept. |
| Agents → Bridge | Authenticated MCP send/read/ACK, handoff, and minimal task tools. |
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
per canonical checkout from the first concurrent writers, including 1+1. Separate worktrees,
harness-enforced read-only access, or serial assignment suffice; a reviewer label does not.

Task states are `ready → working → review → accepted`, with `changes_requested → working` for
revisions. Roles and brief are immutable. Submit and review atomically persist their notification;
reply chains enforce the same message and hop limits. Submission verifies a clean implementer
HEAD descended from the recorded base. The reviewer inspects that exact commit, not its own base checkout.

Bridge enforces ownership among its assignments; harness sandbox/permissions enforce filesystem
boundaries. Record those launch settings. Credential revocation ends Bridge access, not the native
process. Expired ownership means unknown ownership. Reassignment requires verified exit of the old
runtime or explicit operator reconciliation; revocation and logical rebinding do not free a checkout.

Enter/pause blocks new Bridge dispatch to the target and preserves visibility of in-flight work;
it does not interrupt tools or native peer traffic. Explicit resume revalidates binding and policy.
Apply message/task/run budgets, expiry, throttles, and a follow-up limit. Missing required roster
members fail launch; only explicitly optional members may be skipped with a warning.
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
operator and agent actions separately. Config writes lock the effective destination, print diffs,
back up originals, preserve unrelated settings, and publish atomically with stale-original rejection.
Stable instance-neutral hooks and `/events` definitions contain no AgentIds or secrets.

Claude uses worktree-local `.claude/settings.json`; **`SessionStart` is command-only**. Other active
lifecycle handlers use HTTP hooks with allowlisted environment authentication headers and empty 2xx
responses. Codex linked-worktree hooks redirect each discovered project layer to the corresponding
main-checkout `.codex` destination, preserving nested paths. Ordinary worktree MCP/model config
remains local. Honor native project/hook trust; install `SessionEnd` and `Interrupt` within their
timeout budgets.

Prepare secret-free Codex hook definitions before launch. Establish native project and definition
trust in a setup TUI, then exit before creating the private host: an already-loaded untrusted
project layer may keep its hooks disabled. Pilot Claude settings allow the five Bridge MCP tools
explicitly; other native permissions remain unchanged.

Task runs add four role-gated task tools. The private Codex host enables and pre-approves only
those nine Bridge tools; Claude uses the same explicit allowlist with native default permissions.
The console shows persisted start/task/receipt state, pauses on native entry, and requires explicit
resume after detach or recovery. Closing the console leaves native sessions running.

## Next iteration: operator controls

These are required follow-ups to manual validation; the current launch settings above remain implemented behavior.

- Configure each agent's model and supported reasoning/thinking level before the task starts.
  Show requested and observed settings separately when they differ or cannot be confirmed.
- Default new runs to Claude's permission bypass and Codex's YOLO mode, with an explicit override.
  Apply settings to the actual native runtime/host and display the effective mode. Reviewer roles
  remain task restrictions; bypass mode provides no sandbox-enforced read-only boundary.
  Separate checkouts, Bridge writer exclusion, scoped credentials, and delivery limits still apply.
- Show shared quota/usage by provider and account, including reset time when available. Preserve
  model-specific limits when the provider separates them; do not multiply shared quota per agent.
- Show context usage for each exact live session. Prefer native APIs/events; observational TUI
  scraping is an acceptable fallback. Label source, freshness, estimates, and unavailable values.
- Improve the console around these controls, task progress, held-message reasons, and native entry.
  Persist pause reasons and timestamps so operator actions and automatic holds are distinguishable.
  Hidden admin sessions for quota commands remain a research option. Do not run telemetry commands
  in an active agent's composer or infer lifecycle from scraped output.

## Proof gates

1. Native 1+1 pilots: private host/binding/trust, Channel, attached-TUI Codex tool output,
   peer-triggered hooks, read/ACK, drafts, interruption/reconnect, and ambiguous outcomes.
2. Durable macOS pair: implement → review → accept without manual relay, with correct restart,
   writer exclusion, pause/resume, limits, held inbox, console receipts, and native entry.
3. macOS 2+2 fleet: repeated-kind launch/config/attribution, separate worktrees, exact addressing,
   and observed native Claude peer traffic without concurrent Bridge-assigned checkout writers.

Prepare named authenticated pilot procedures. Offline fixtures and source support cannot satisfy native gates.
