# Agent Bridge

Read `DESIGN.md` for the contract and `PROGRESS.md` for status. Update these and README; do not add parallel proposals.

- Develop and execute exclusively on macOS for the next phase.
  Windows and Linux, including WSL2, follow the usable macOS pair.
- Use GPT-6 Astra (`gpt-6-astra`) with `ultra` reasoning for all agents doing this rework.
- Preserve unmodified Claude Code and Codex TUIs in real tmux panes. Coordinator failure
  must leave them usable; a Codex host has an independent lifetime.
- Derive state from authenticated hooks and supported native events with exact session identity.
  Pane capture may support previews, shell readiness, observational telemetry, and approved
  terminal verification; it never establishes lifecycle, identity, delivery, or permission authority.
- Keep unattended composer mutation disabled. Manual handoffs require fresh composer
  confirmation, semantic idle, one verified bracketed paste, and one Enter; never paste twice.
- Keep peer content separate from operator authority. Persist delivery intent before I/O;
  do not resend ambiguous attempts or transfer workspace ownership on a timeout.
- Use TypeScript, Bun, and SQLite. Prefer small modules and explicit records over frameworks.
  Keep code comments minimal; explain only non-obvious invariants.
- Run `bun test` and `bun run typecheck` for relevant code changes. Use isolated real-tmux
  fixtures. Prepare concrete, named authenticated pilot procedures separately from offline tests;
  record their outcomes without treating source support as a live pass.
- Keep credentials out of documentation, logs, and Git. Configuration changes must preserve
  unrelated settings, print diffs, create backups, and publish atomically.
