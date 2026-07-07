# Agent Bridge — Design Doc & v0 Plan

**Date:** July 7, 2026 · **Status:** proposal for review
**Inputs:** the two attached deep-research reports (ChatGPT's "Native Multi-Agent Terminal Control Room", Gemini's "Puppeteer & Blackboard"), plus independent research across ~45 primary sources, with load-bearing claims re-verified against official docs this session.

---

## 1. Goal and constraints

A local supervisor for four coding agents running in their **native TUIs** — Claude Code, Codex CLI, Antigravity CLI (`agy`), and OpenCode (Copilot-backed models) — that lets you observe all of them at once, step into any session with your keyboard, hand context between them, let two of them pair on a task, and lean on whichever tool has rate-limit headroom.

Hard constraints, from your prompt and answers:

- The agent TUIs stay alive and unmodified. No re-hosting them behind an API the way gsd-review, LangChain-style wrappers, or ACP clients do. Stepping in means literally focusing the pane and typing.
- Autonomy is a **per-task dial**: some tasks you approve every handoff, some tasks two agents coordinate on their own (worktrees, locks, coordinated merge — your instinct, and it holds up).
- Local-only is fine. Personal tool. macOS (iTerm2) is primary; Windows (Windows Terminal) should have a path. You're open to adopting a multiplexer.
- Rate-limit-aware routing across the four subscriptions.
- graphify considered as shared-context glue; Obsidian considered for the human-consumption side.

Non-goal: another unified chat UI over agent event streams. That product exists several times over (Conduit, Crystal/Nimbalyst, vibe-kanban, Conductor, every ACP client) and every one of them kills the native TUI.

---

## 2. The finding that changes the design

Both prior reports assume the supervisor learns agent state by watching the terminal — Gemini's report by scraping the screen buffer for idle prompts (`">" in bottom_text`), ChatGPT's via multiplexer streams. That was true in 2025. It isn't anymore, and it's the single most consequential thing my research turned up:

**Every tool except `agy` now emits real, documented, semantic events a local daemon can consume directly.**

| Tool | Turn finished | Needs approval / input | Push mechanism | Transcript on disk | Local input into the live TUI |
|---|---|---|---|---|---|
| **Claude Code** | `Stop`, `StopFailure` hooks | `PermissionRequest`, `Notification` (matchers: `permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`) | 30 hook events; handler types include **`http`** — hooks can POST JSON straight to a local daemon | `~/.claude/projects/<proj>/<session>.jsonl` (path handed to every hook) | None official → tmux `send-keys` |
| **Codex CLI** | `Stop` hook (includes `last_assistant_message`), `notify` = `agent-turn-complete` | `PermissionRequest` hook — can even auto-allow/deny | 10 Claude-compatible hook events (`command` handlers; shim posts to daemon) + `codex app-server` JSON-RPC | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | None official → `send-keys` |
| **OpenCode** | `session.idle` event | `permission.asked` / `permission.replied`; answerable via `POST /session/:id/permissions/:permissionID` | TUI always runs on a local HTTP server; **SSE `/event` bus** (~80 event types); plugins; OpenAPI 3.1 + TS SDK | `~/.local/share/opencode/storage/` | **First-class:** `POST /tui/append-prompt` + `/tui/submit-prompt` — the visible TUI types and submits |
| **Antigravity `agy`** | `Stop`-class hook (names unverified) | hook on pre-tool-use (`allow_tool: false` blocks) | hooks.json at `~/.gemini/antigravity-cli/` and `<repo>/.agents/hooks.json` | Undocumented/opaque | None → `send-keys` |

(Copilot CLI, if you ever add it as a fifth: 6 hooks but notably **no Stop/turn-complete event**, plus a tailable `~/.copilot/session-state/<id>/events.jsonl`. OpenCode-via-Copilot already covers that quota anyway.)

So the architecture inverts: **the multiplexer is the body, hooks are the nervous system.** The mux hosts real PTYs, gives you step-in, previews, and keystroke injection. Agent *state* — working / idle / waiting-on-you / done / erroring — comes from the tools' own hooks and servers, with screen-scraping demoted to a fallback for `agy` and a sanity-check elsewhere. This is exactly the gap in prior art: claude-squad and agent-of-empires have PTY fidelity but dumb (scrape-based) supervision; Conduit/ACP/vibe-kanban have semantic supervision but destroy the TUI. Nothing ships both. That's Agent Bridge's actual contribution.

---

## 3. Scorecard on the two prior reports

**ChatGPT report.** Its architecture (terminal control plane + MCP context plane, worktree isolation, human-directed handoffs by default, graphify as memory-not-orchestrator) survives verification and I adopt most of it. Specific checks: `zellij subscribe` is real — I verified the docs page; it landed in Zellij 0.44.0 (March 2026) and streams rendered pane output as NDJSON, cross-session. Zellij's case is *stronger* than the report knew: 0.44.0 also brought native Windows support. Two corrections: it treats terminal-layer observation as the only observability channel, underusing the hooks story above; and it presents Conduit as the direct precedent, but Conduit does **not** host native TUIs — it renders its own chat UI over the agents' stream-JSON interfaces. The closest real precedents are claude-squad (tmux + worktrees, attach-to-real-session, active, AGPL) and agent-of-empires (tmux-hosted native TUIs + status detection + web view, MIT, supports all four of your tools including `agy`).

**Gemini report.** The tmux + send-keys "puppeteer" skeleton is sound and its step-in story ("the orchestrator doesn't care; it's just waiting") is the right mental model. Three corrections: `wait_for_idle` by scraping for prompt characters is fragile and now unnecessary (hooks); rebuilding graphify from scratch each handoff is outdated (graphify has `--update` incremental re-extraction, `graphify watch`, and git hooks that rebuild AST-only with no API cost); and always-auto-relay conflicts with your per-task dial — injection without an idle-gate will also race against a TUI mid-render.

---

## 4. Architecture

```
┌─────────────────────────── tmux session: bridge ────────────────────────────┐
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐    │
│ │ claude (TUI)  │ │ codex (TUI)   │ │ agy (TUI)     │ │ opencode (TUI)│    │
│ │ worktree A    │ │ worktree B    │ │ worktree C    │ │ worktree D    │    │
│ └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └───────┬───────┘    │
│         │ hooks(http)     │ hooks(shim)     │ hooks(shim)     │ SSE /event │
│ ┌───────▼─────────────────▼─────────────────▼─────────────────▼──────────┐ │
│ │                        bridged  (local daemon)                         │ │
│ │  event ingest · state store (SQLite) · transcript tailers              │ │
│ │  rate-limit pollers · router · handoff engine · pair-mode coordinator  │ │
│ │  mux adapter (tmux now, zellij later): spawn/capture/send-keys/focus   │ │
│ └───────┬─────────────────────────────┬──────────────────────────────────┘ │
│ ┌───────▼───────┐             ┌───────▼──────────────────────────────────┐ │
│ │ bridge top    │             │ shared context plane                     │ │
│ │ (control pane)│             │  bridge-bus MCP  ·  graphify MCP (http)  │ │
│ └───────────────┘             │  .bridge/ handoff files → Obsidian vault │ │
└───────────────────────────────┴──────────────────────────────────────────┴─┘
        you: step into any pane natively (Ctrl-b arrows / iTerm2 -CC)
```

**`bridged`** is one local daemon. It ingests events four ways: Claude Code hooks configured with the native `http` handler type (zero shell shims); Codex and `agy` hooks as tiny `command` shims that `curl` the daemon; OpenCode via an SSE client on its `/event` bus (the TUI always runs a server — pin it with `--port`); transcript JSONL tailers as backfill/detail. State lands in SQLite: per-agent status, current task, last message digest, pending permissions, rate-limit snapshots.

**The mux adapter** does only four jobs: spawn panes (one per agent, each in its own worktree), capture previews (`capture-pane`), inject input (`send-keys` — except OpenCode, where injection goes through `/tui/append-prompt` + `/tui/submit-prompt` so the visible TUI does the typing), and focus panes for step-in. It's an interface (`spawn/capture/stream/send/focus/list`) with a tmux backend first and a Zellij backend later — Zellij 0.44's `subscribe`, `send-keys`, `dump-screen`, and `list-panes --json` map one-to-one, which is what makes the Windows story cheap.

**`bridge top`** is the control pane — a small TUI the daemon serves inside the same tmux session. Per-agent cards: state (from events, not scraping), task, last output line, pending approval badges, rate-limit bars. One keystroke: focus an agent's pane, approve a queued handoff, watch a diff. Stepping in remains plain tmux navigation; on macOS you can run the whole session under iTerm2's `tmux -CC` integration so every agent is a native iTerm pane and your muscle memory doesn't change.

### Handoffs

A handoff is a **file, then an injection**. The engine builds a handoff packet — markdown with frontmatter (`from`, `to`, `task`, `worktree`, `branch`) containing a transcript-derived summary of what the source agent just did (from its JSONL, not from asking it), the relevant `git diff --stat`, and optionally a `graphify query` result for the touched area. Packets live in `.bridge/handoffs/` — inspectable, diffable, and exactly what gets injected.

The autonomy dial, per task:

- **observe** — packet is prepared and parked; you do whatever you want with it.
- **approve** (default) — `bridge top` shows the packet; one keystroke sends it into the target pane.
- **auto** — the daemon waits for the target's *idle event* (never a scrape heuristic), then injects, visibly. You watch the prompt get typed and can Ctrl-C it like anything else.

Injection etiquette matters more than it sounds: bracketed paste, single trailing Enter, then verify the echo via `capture-pane` and retry once — the verify-and-retry trick is cribbed from `tmux-cli` in pchalasani/claude-code-tools, which exists because naive `send-keys` intermittently loses the Enter.

### Pair mode

Your sketch — worktrees plus coordinated merge with locks — is the right protocol, and it decomposes into things that already exist:

1. `bridge pair <task> claude codex` creates two worktrees off an integration branch (`task/x/claude`, `task/x/codex`) and injects the same brief with role framing (e.g., implementer / test-writer, or two competing implementations).
2. Coordination runs through the **bridge-bus MCP server** (below): `post_update` for progress notes the other agent can read, `lock_paths` for advisory path leases when both must touch shared files, `read_peer` to pull the other's latest update. Because it's MCP, both agents use it natively from inside their own TUIs — no chat-relaying between their contexts.
3. Merge choreography: when both post `done`, the daemon merges the first branch into the integration branch, then hands agent two a merge task with the conflict list. You review the integration branch before it touches your real branch. Locks make conflicts rare; the merge step makes the remaining ones an agent's problem instead of yours.

### bridge-bus (the tiny MCP server you do build)

Six tools, localhost only: `create_task`, `claim_task`, `post_update`, `read_handoff`, `lock_paths` / `release_paths`, `read_peer`. All four TUIs speak MCP as clients, so this is the one standards-aligned channel where "the agents interact with each other" without anyone leaving their native tooling. Everything it stores is markdown/JSON in `.bridge/` — same files the human-facing layer reads.

### Rate-limit router

Feasible today for all four tools; monitors like CodexBar and ClaudeBar already ship the read paths in production. Normalize everything to `{tool, window, used_pct, resets_at}`:

| Tool | Read path | Fidelity |
|---|---|---|
| Claude Code | statusline stdin JSON carries `rate_limits.five_hour/.seven_day` (official — a statusline script that tees to the daemon gets it for free); `GET api.anthropic.com/api/oauth/usage` (unofficial, needs `claude-code/<ver>` User-Agent, poll ≥180s) for on-demand cross-device truth | High |
| Codex | `token_count.rate_limits` in every session JSONL (server-sent `used_percent` + resets); `codex app-server` → `account/rateLimits/read` for on-demand | High (documented surface) |
| Copilot (via OpenCode) | `GET api.github.com/copilot_internal/user` → `quota_snapshots.premium_interactions.percent_remaining` (unofficial); caveat: GitHub moved to **AI Credits** June 2026, schema in flux | Medium |
| Antigravity | localhost probe of the Antigravity language server (`GetUserStatus` — what the IDE itself displays) or the `antigravity-usage` npm CLI (`--json`, multi-account) | Medium (internal protocol) |

Routing policy: rank agents by weekly-window headroom, treat the 5-hour window as a soft gate (defer, don't exclude), let you pin a task to a tool, and paint the bars in `bridge top`. `bridge assign "<task>"` places a task on the best-headroom agent. Pollers are plugins with graceful degradation (fall back to ccusage-style local estimation when an endpoint breaks) because half of these paths are unofficial and will churn.

### graphify (shared memory, not orchestrator)

Verified against the README this session: run **one** server — `python -m graphify.serve graphify-out/graph.json --transport http --port 8080` — and point all four TUIs' MCP configs at `http://localhost:8080/mcp`. Tools exposed: `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, plus PR-oriented `list_prs`/`get_pr_impact`/`triage_prs`. Keep it fresh with `graphify watch` or its git hooks (post-commit AST-only rebuild, no API cost) rather than full rebuilds. Handoff packets embed a targeted `graphify query` result instead of dumping `GRAPH_REPORT.md`. Two caveats: code parsing is local (tree-sitter, offline), but docs/PDFs/images go to a model API unless you use the Ollama backend (local PDF parsing is an open feature request, #259); and every query is logged to `~/.cache/graphify-queries.log` unless you set `GRAPHIFY_QUERY_LOG_DISABLE=1`. The project is healthy — MIT, very active, now YC-backed — but 0.x, so pin versions. Note the PyPI name is `graphifyy` (double y).

### Obsidian (park the plugin, ship the conventions)

A vault is markdown on disk and Obsidian live-reindexes external writes, so agents don't need a plugin to populate it — and a plugin would add an "Obsidian must be running" dependency that's wrong for headless writers. `.bridge/` mirrors into a vault folder: append-only session logs, handoff packets as notes with frontmatter (`agent`, `task`, `status`, `cost`, timestamps), which makes **Bases** (core plugin) a zero-code dashboard over agent activity; `.canvas` files (open JSON spec) can render pipeline boards; `obsidian://open` deep links go in `bridge top`. graphify even ships `--obsidian --obsidian-dir ~/vault` export. If app-context features ever matter (patching a note a human has open, semantic search), adopt the Local REST API community plugin — it now bundles its own MCP server with 15 vault tools — rather than writing plugin code. Revisit a custom plugin only if these conventions demonstrably fall short.

---

## 5. Substrate decision

**macOS (primary): tmux.** Maturity, `send-keys`/`capture-pane`/`pipe-pane`, control-mode `%output` events if raw streams are ever needed, and the pattern is proven by claude-squad and agent-of-empires. Run it under iTerm2's `tmux -CC` so agent panes are native iTerm panes — you keep your terminal, and detach/reattach survives iTerm restarts.

> **Decision update (Jul 7):** Rich confirmed Windows will run via **WSL2**, so tmux is the sole v0 substrate on both platforms and the Zellij backend is parked (revisit only if native Windows becomes a requirement). The paragraph below is kept for the record.

**Windows: Zellij 0.44+ native, or WSL2 tmux.** tmux still doesn't run natively on Windows (the PR for it is open, unmerged). Zellij 0.44.0 (March 2026) runs natively on Windows and its CLI now mirrors everything the daemon needs (`subscribe` — rendered-output NDJSON streaming, arguably a *better* observation primitive than tmux's raw bytes — plus `send-keys`, `dump-screen`, `list-panes --json`, `watch` read-only attach, browser-based session sharing). It's three months old on Windows, hence backend #2 rather than the foundation. If your Windows work already lives in WSL2, identical tmux stack, zero new code. One check needed: OpenCode's docs still carry a "Windows (WSL)" page — verify current native-Windows status for each agent CLI before committing (agy ships native Windows installers; Claude Code and Codex run on Windows).

**Stack for the daemon: TypeScript on Bun.** Single process, cross-platform, SSE/JSON native, and OpenCode's official SDK (`@opencode-ai/sdk`) plus its generated OpenAPI types are TS. Hook shims are three-line shell/PowerShell scripts. (Go is the alternative if you later want a single static binary; nothing in the design precludes porting.)

---

## 6. v0 plan

Each phase is independently useful; stop anywhere and you still have a tool.

**Phase 0 — See everything (a weekend).** Repo + daemon skeleton. `bridge up`: tmux session, four panes, one agent each (optionally each in a worktree). `bridge init`: writes Claude hooks (http handlers) into `.claude/settings.json`, Codex `hooks.json` + `notify`, agy `hooks.json` (best-effort), discovers/pins OpenCode's server port and subscribes to `/event`. `bridge top` v0: four cards with live state — working / idle / **needs you** / done — driven entirely by events. *Exit test: all four agents' turn-completions and permission prompts appear in one pane with zero scraping.*

**Phase 1 — Handoffs (week 2).** Packet builder (JSONL summary + diffstat), `.bridge/handoffs/`, approve-mode injection (send-keys with verify-retry; OpenCode via `/tui/*`), `bridge handoff <from> <to>`, auto mode gated on target-idle events. *Exit test: Claude finishes a refactor; you press one key; Codex's TUI visibly receives a briefing and starts writing tests.*

**Phase 2 — Shared plane.** bridge-bus MCP server (six tools) registered in all four TUIs; graphify HTTP server + `watch`; `bridge init` appends a short "how to use the bus" section to `CLAUDE.md`/`AGENTS.md`. *Exit test: two agents in separate TUIs read/write the same task thread without you relaying anything.*

**Phase 3 — Router.** Rate-limit pollers (Claude statusline tee + OAuth endpoint; Codex JSONL tail + app-server RPC; Copilot internal endpoint; `antigravity-usage`), bars in `bridge top`, `bridge assign` placement by weekly headroom. *Exit test: with Claude at 85% weekly, `bridge assign` routes to Codex and says why.*

**Phase 4 — Pair mode.** Worktree spawner + integration branch, `lock_paths` leases, merge choreography, per-task autonomy config (frontmatter in the task file). *Exit test: two agents build one feature in parallel worktrees and the integration branch merges with agent-resolved conflicts.*

**Phase 5 — Human layer (+ parked portability).** Obsidian vault mirroring + a Bases dashboard. The Zellij mux backend is parked per the WSL2 decision above; the `MuxAdapter` interface keeps the door open.

---

## 7. Risks and open questions

**agy is the weak link.** Its hook event names and transcript location are the two things I could not pin to primary docs (antigravity.google is a JS-rendered SPA that resists fetching; the GitHub repo is a docs-mirror). Worst case, agy runs in observe-via-mux mode in Phase 0 while the others are event-driven — the design degrades gracefully. Worth five minutes in a browser on `antigravity.google/docs/hooks` before building its adapter.

**Unofficial endpoints churn.** Claude's OAuth usage endpoint, `copilot_internal/user`, and the Antigravity LSP probe are all undocumented; Copilot's AI-Credits migration (June 2026) is actively reshaping its schema. Hence: pollers as plugins, estimation fallback, and never letting the router hard-fail on a dead poller.

**Injection races.** Typing into a TUI that's mid-render loses keystrokes. Mitigations are in the design (idle-event gating, bracketed paste, echo-verify + retry) but this will still be the fiddliest code in the repo. Claude Code has no local input API at all — send-keys *is* the mechanism — and that's an accepted limitation, not a blocker.

**Two sessions ≠ one session.** OpenCode aside, you can't attach a second programmatic client to a *running* TUI session (Codex app-server threads are separate; Claude's Remote Control rail is vendor-only). The design never needs to — it observes via hooks and injects via the terminal — but don't drift into expecting API-grade control of live TUI sessions.

**Security.** Hooks execute arbitrary local commands; keep `bridge init`'s written configs auditable and the daemon/bus loopback-only. graphify sends non-code assets to model APIs unless configured for Ollama. Auto-mode handoffs inject text into agents that can run tools — keep auto off for tasks touching anything sensitive, which the per-task dial already expresses.

**Scope creep is the real risk.** The landscape table from research is a graveyard of over-built agent managers (omnara archived, Crystal deprecated, Pheromind stale). Phase 0+1 alone — live status board + one-keystroke handoffs between native TUIs — already beats everything that exists.

---

## 8. Explicitly parked

The Obsidian **plugin** (conventions + existing Local REST API plugin cover it); a web dashboard (tmux + `bridge top` suffice; Zellij's web client arrives free in Phase 5); Copilot CLI as a fifth agent (OpenCode already spends that quota; add later via the same adapter pattern — noting its missing Stop hook); ACP integration (re-hosts agents — violates the prime constraint); building any bespoke knowledge graph (graphify).

---

## Sources

**Substrate:** [zellij subscribe](https://zellij.dev/documentation/zellij-subscribe.html) · [Zellij CLI actions](https://zellij.dev/documentation/cli-actions) · [Zellij web client](https://zellij.dev/documentation/web-client.html) · [tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode) · [tmux man page](https://man7.org/linux/man-pages/man1/tmux.1.html) · [tmux native-Windows PR (open)](https://github.com/tmux/tmux/pull/4086) · [iTerm2 tmux integration](https://iterm2.com/documentation-tmux-integration.html) · [WezTerm CLI](https://wezterm.org/cli/cli/index.html)

**Agent surfaces:** [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [statusline (incl. rate_limits)](https://code.claude.com/docs/en/statusline) · [remote control](https://code.claude.com/docs/en/remote-control) · [Codex hooks](https://developers.openai.com/codex/hooks) · [Codex app-server](https://developers.openai.com/codex/app-server) · [Codex config](https://developers.openai.com/codex/config-advanced) · [OpenCode server API (verified: /tui/*, /event SSE, permissions)](https://opencode.ai/docs/server/) · [OpenCode plugins](https://opencode.ai/docs/plugins/) · [OpenCode SDK](https://opencode.ai/docs/sdk/) · [Copilot via OpenCode (GitHub changelog)](https://github.blog/changelog/) · [antigravity-cli repo](https://github.com/google-antigravity/antigravity-cli) · [agy docs (SPA — check in browser)](https://antigravity.google/docs/cli-overview) · [Copilot CLI hooks](https://docs.github.com/en/copilot/reference/hooks-configuration)

**Rate limits:** [Claude OAuth usage endpoint write-up](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/issues/202) · [ccusage](https://ccusage.com/guide/) · [codex-ratelimit (JSONL format)](https://github.com/xiangz19/codex-ratelimit) · [CodexBar providers.md (read-path catalog for ~48 providers)](https://github.com/steipete/CodexBar/blob/main/docs/providers.md) · [GitHub AI Credits announcement](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) · [antigravity-usage](https://github.com/skainguyen1412/antigravity-usage)

**Prior art:** [claude-squad](https://github.com/smtg-ai/claude-squad) · [agent-of-empires](https://github.com/njbrake/agent-of-empires) · [Conduit](https://getconduit.sh/) · [Tmux-Orchestrator](https://github.com/Jedward23/Tmux-Orchestrator) · [tmux-mcp](https://github.com/nickgnd/tmux-mcp) · [tmux-cli (verify-retry injection)](https://github.com/pchalasani/claude-code-tools) · [vibe-kanban](https://github.com/BloopAI/vibe-kanban) · [ACP](https://agentclientprotocol.com/) · [omnara (archived)](https://github.com/omnara-ai/omnara) · [happy](https://github.com/slopus/happy)

**Context & human layer:** [graphify (README verified: MCP tools, HTTP mode, --update/watch, --obsidian)](https://github.com/safishamsi/graphify) · [local-PDF feature request #259](https://github.com/safishamsi/graphify/issues/259) · [Obsidian Local REST API (built-in MCP)](https://github.com/coddingtonbear/obsidian-local-rest-api) · [JSON Canvas spec](https://jsoncanvas.org/) · [Obsidian Bases](https://obsidian.md/help/bases) · [git worktree](https://git-scm.com/docs/git-worktree)
