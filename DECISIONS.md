# Decisions — deviation log

Deviations from DESIGN.md are logged here **before** implementation. Format: date, what, why, impact.

---

## 2026-07-07 — Dev-only dependencies: `typescript` + `@types/bun`

**What:** package.json carries two devDependencies. Runtime remains Bun built-ins only.
**Why:** the kickoff requires *strict TS*; Bun transpiles but does not typecheck, so `tsc --noEmit` needs the compiler and Bun's type declarations. Neither ships at runtime.
**Impact:** none on the running tool; `bun install` fetches dev tooling only.

## 2026-07-07 — Claude/Codex hook sets extended with `UserPromptSubmit` + `PostToolUse`

**What:** `bridge init` registers `UserPromptSubmit` and `PostToolUse` in addition to HANDOFF.md's five (Stop, StopFailure*, Notification*, PermissionRequest, SessionStart). (*Codex has no StopFailure/Notification events — verified against developers.openai.com/codex/hooks July 2026.)
**Why:** the Phase 0 exit test requires `bridge top` to flip *working → idle*. Without `UserPromptSubmit` there is no event that ever puts an agent in `working`; without `PostToolUse` a granted permission leaves the board stuck on `needs_you` until end of turn.
**Impact:** two more low-cost localhost POSTs per turn/tool-call; state board reflects reality.

## 2026-07-07 — OpenCode launch always pins `--port` + `--hostname 127.0.0.1`

**What:** DESIGN.md says "pin it with `--port`"; docs claim `serve` defaults to 4096. Verified against the local binary (v1.17.15): the default is port **0 (random)** for both TUI and serve. Writers/launchers therefore always pass both flags explicitly.
**Why:** daemon must find the SSE `/event` bus deterministically.
**Impact:** none for the user; `bridge up` composes the flags if absent from the configured command.

## 2026-07-07 — OpenCode permission events: subscribe to v1 *and* v2 names

**What:** v1.17.15 emits both `permission.asked`/`permission.replied` and `permission.v2.asked`/`permission.v2.replied` (different payload shapes). The mapper handles both; `permission.updated` (older name in some docs) does not exist and is not used.
**Why:** missing either family drops needs-you events across OpenCode versions.
**Impact:** duplicate events for one prompt are possible; the state machine is idempotent under them.
