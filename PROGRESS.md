# Progress

Current phase: **0 — Dual-TUI foundation (reframed)**

Active branch: `codex/phase-0-two-agent`

The original four-provider Phase 0 implementation remains the baseline in Git history. Phase 0 is reopened to make Claude Code + Codex the complete active v0 surface and to revise its live acceptance test accordingly.

Current static gate on macOS: **103 tests pass**, strict TypeScript passes, and `scripts/verify-phase0.sh static` reports **8 pass / 0 fail / 0 warn**. Runtime ownership, repo-local hooks, legacy cleanup, and the safety-hardened live verifier are implemented.

The authenticated macOS verifier completed **44 / 44 checks again on July 28**, validating the pane-identity, idle-reminder, first-observed-turn, permission, and daemon-independence fixes. Its visual follow-up is now covered: Claude's detailed `⚠ Bash` badge and `PermissionRequest` source remain stable when the delayed generic permission notification arrives, while the daemon still retains that notification as its literal latest event. Notification-only consent prompts remain real `needs_you` signals. Manual denial/Escape has no corresponding Claude hook, so attention safely clears on the next trusted lifecycle event rather than an inferred timeout. macOS live acceptance is complete; a targeted restart smoke check remains for the display correction, and WSL2 is still pending.

| Phase | Branch | Status |
|---|---|---|
| 0 — Dual-TUI foundation | `codex/phase-0-two-agent` | reopened; in progress |
| 1 — Bidirectional handoffs | — | not started |
| 2 — Shared task plane | — | not started |
| 3 — Pair workflow | — | not started |
| 4 — Rate-aware routing | — | not started |
| 5 — Extensibility + optional human layer | — | parked until the two-agent workflow is proven |

Phase 0 is complete only after the revised Claude/Codex live verification passes on macOS and WSL2.
