# agy (Antigravity CLI) — hook/event surface notes

Researched 2026-07-07. Methods: read-only inspection of the installed binary
(`/home/rich/.local/bin/agy`, v1.0.0, 176MB stripped Go ELF, installed 2026-05-20),
read-only listing of `~/.gemini/`, the `google-antigravity/antigravity-cli` GitHub
docs-mirror repo (README, CHANGELOG, `examples/`), and secondary writeups
(Medium/Google Cloud Community, danicat.dev, GitHub issue #49). The official docs at
`antigravity.google/docs/hooks` are a JS-rendered SPA and could not be fetched directly —
nothing below rests solely on them.

Confidence labels: **verified** = seen in the binary, on local disk, or in the official
repo; **likely** = consistent across ≥2 secondary sources and not contradicted by the
binary; **guess** = single-source or inferred. **Anything not "verified" must be
re-checked live before an adapter depends on it.**

---

## 1. Hook event names

| Event | Fires | Confidence | Evidence |
|---|---|---|---|
| `PreToolUse` | before each tool call; can allow/deny | **verified** (string in binary; docs agree) | `strings` hit `PreToolUse`; Medium + danicat |
| `PostToolUse` | after each tool call | **verified** (string in binary; docs agree) | `strings` hits `PostToolUse`, `kPostToolUse`, `expected PostToolHookArgs (post-tool), got %T` |
| `PreInvocation` | before an agent/model invocation | **verified as existing** (binary: `PreInvocation`, `hooks_go_proto.PreInvocationHookArgs/Result`, `registry.NewPreInvocationHookFn`); exact firing semantics **likely** (per docs: before agent invocation begins) |
| `PostInvocation` | after an agent/model invocation | **verified as existing** (binary: `PostInvocation`, `PostInvocationHookArgs/Result/HookNames`); semantics **likely** |
| `Stop` | on agent termination / stop | **likely** as the JSON key (binary has `StopHookArgs`, `StopHookResult`, `agent.StopHook`, `StopHookDecision`, `map[string]registry.NewStopHookFn` — but the bare string "Stop" is un-greppable; both Medium and danicat name the event `Stop`) |

- **Stop-equivalent:** yes (`Stop`), but **whether it fires at end of every turn
  (Claude-Code-style) or only on conversation/agent termination is NOT verified.**
  Do not build idle-detection on `Stop` alone — use the statusline feed (§5).
- **PermissionRequest-equivalent: none found.** No `PermissionRequest`/`Notification`
  event string exists in the binary. Permission prompts are internal
  (`PermissionInteraction`, `ask_permission` tool matcher exist, but not as hook events).
- **SessionStart-equivalent: none found.** `PreInvocation` is the closest (fires per
  invocation, not per session). Legacy Gemini-CLI-era names (`SessionStart`,
  `BeforeAgent`, `AfterTool`, …) are referenced by the Medium article as consolidated
  away; they do **not** appear as agy hook strings in the binary.
- Binary log lines (useful for echo-verification that hooks loaded):
  `Loaded hooks.json from %s: %d named hooks, %d total handlers`,
  `loaded %d named hooks from %d hooks.json file(s)`,
  `No hooks.json found at %s`, `skipping hooks.json at %s: %v`,
  `failed to parse hooks.json at %s: %v`, `failed to call custom hook %s`.

## 2. hooks.json — locations and schema

### Locations (search order not verified; all three should be considered)

| Path | Status | Confidence |
|---|---|---|
| `~/.gemini/config/hooks.json` | canonical **shared/global** location ("shared between TUI and backend") | **verified** via repo CHANGELOG: "Fixed a bug where the `/hooks` command wrote configurations to `~/.gemini/antigravity-cli/hooks.json` instead of the shared `~/.gemini/config/hooks.json`". `~/.gemini/config/` exists locally (holds `mcp_config.json`, `projects/`). |
| `~/.gemini/antigravity-cli/hooks.json` | **legacy/buggy** write target of `/hooks` in older builds (incl. possibly this v1.0.0 build — the fix's version is unknown) | **verified** as legacy via CHANGELOG + GitHub issue #49 |
| `<workspace>/.agents/hooks.json` | project-scope hooks | **likely** — binary has the customization-file string table `agents.txt agent.json hooks.json rules.json skills.txt` and uses `{workspace}/.agents/...` paths (`{workspace}/.agents/skills/{skill_name}/SKILL.md` is a verified literal); Medium + danicat both name `.agents/hooks.json`. Caveat (Medium): project-local hooks may not show in the `/hooks` TUI panel in early releases even though they run. |

**Bridge config-writer guidance:** write the identical named-hook block to BOTH
`~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/hooks.json` (idempotent,
diff+backup per repo rules) so it works on either side of the path-fix; then verify via
the `Loaded hooks.json from %s` line in `~/.gemini/antigravity-cli/log/cli-*.log`
(note: on this machine that log shows no hook lines because no hooks are configured —
re-check after writing).

### Schema (top level = named hooks; name → event → matcher groups)

Confidence: **likely** (verbatim from Medium example; consistent with binary types
`map[string]jsonhook.JSONHookSpec` / "named hooks", TUI strings `Matcher:` and
`default: 30`, and proto `TimeoutMs`):

```json
{
  "block-run-command": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/script.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- `type`: only `"command"` is evidenced anywhere. **No `http` handler type found**
  (unlike Claude Code). Assume command-only.
- `command`: must be an **absolute path** (relative resolves against the launch cwd) — likely.
- `timeout`: seconds, default 30 (TUI shows `default: 30`) — likely; `timeout: 0` kills
  the subprocess immediately (Medium) — guess.
- `matcher`: regex over tool names; `"*"`/`""` = all. Known tool names for matchers
  (from binary/Medium): `run_command`, `write_to_file`, `call_mcp_tool`,
  `define_subagent`, `ask_permission` — likely.

### Handler I/O

- **Payload: JSON on stdin** (subprocess exec; same pattern as the verified statusline
  examples). Confidence: likely for hooks, verified for statusline/title.
- Payload fields — `session_id`, `transcript_path` are **verified** as JSON tags in the
  binary (`json:"session_id,omitempty"`, `json:"transcript_path,omitempty"`); `cwd`,
  `timestamp`, `hook_event_name`, `toolCall.args.CommandLine` (Go-style nesting; binary
  has `toolCalls` and `command_line`→`commandLine` tags), `workspacePaths` are
  **likely** (Medium/danicat; `hook_event_name` was NOT found in the binary — treat as guess).
- **Response: JSON on stdout.** `allow_tool` (bool) and `deny_reason` (string) are
  **verified** as proto JSON tags in the binary. A string `decision` field
  (`allow`/`deny`/`ask`) also exists — CHANGELOG: "safely handling empty decision
  strings returned by pre-tool hooks instead of failing with an 'unknown pre-tool hook
  decision' error" (verified that a decision-string path exists; exact accepted values
  likely per danicat).
- **Exit code must be 0 even when denying** (Medium); non-zero = hook execution failure.
  Confidence: guess — verify live before relying on deny behavior.

## 3. Transcript / session files on disk (verified locally)

- App data root: `~/.gemini/antigravity-cli/` (`GeminiDir` = `~/.gemini`, hardcoded
  fallback string in binary; app-data subdir configurable via a "relative to GeminiDir" flag).
- **Conversations: `~/.gemini/antigravity-cli/conversations/<uuid>.pb`** — verified
  locally (one 364KB `.pb` file, protobuf `gemini_coder.Trajectory` per binary proto
  strings). **Not JSONL, not tail-able like Claude's transcripts.**
  Newer builds move to **SQLite**: CHANGELOG says `.db`/`.db-wal` scanning was added and
  SQLite "will be CLI's conversation format" — expect `.pb` → `.db` migration on update.
- Per-conversation artifacts: `~/.gemini/antigravity-cli/brain/<conversation-uuid>/` (verified).
- Misc (verified): `history.jsonl`, `log/cli-YYYYMMDD_HHMMSS.log` (+ `cli.log` symlink),
  `last_conversations.json` cache (string in binary), `~/.gemini/projects.json`,
  `~/.gemini/config/projects/<uuid>.json`.
- Hooks receive `transcript_path` pointing at the live session transcript (verified
  field); whether it points at the `.pb`, a `.jsonl` view, or a temp file is **not
  verified** (binary mentions `transcript.jsonl` in a subagent-prompt context).

## 4. Local server / API surface

- **No stable localhost HTTP/REST API for external clients.** The binary embeds:
  a Connect/gRPC **language-server sidecar** (`exa.language_server_pb.LanguageServerService`
  — internal, dynamic port, e.g. `SignalExecutableIdle`, `GetCascadeTrajectory` RPCs),
  a Chrome DevTools/MCP browser bridge (`AGY_BROWSER_WS_URL`), an OAuth callback server,
  and a Prometheus metrics handler. All internal, undocumented, unpinned ports — **do
  not build on these** (violates the "unmodified TUI" constraint anyway).
- MCP config: `~/.gemini/config/mcp_config.json` (verified locally; legacy path
  migration noted in CHANGELOG). agy can act as an MCP *client* — an MCP server is a
  possible fallback event channel but is model-mediated, not lifecycle-driven.

## 5. Statusline/title stdin feed — best state signal (verified, official)

The official repo ships `examples/statusline/statusline.sh` and `examples/title/title.sh`:
the CLI pipes a **JSON state payload on stdin** to a user-configured script (configured
via `statusLine` in settings; `stack_with_default: true` keeps the native statusline).
Docs pages: `antigravity.google/docs/cli-statusline`, `/docs/cli-title`.

Payload fields used by the official examples (verified):
`agent_state`, `context_window.used_percentage`, `vcs.branch`, `vcs.dirty`,
`sandbox.enabled`, `artifact_count`, `subagents` (array), `task_count`,
`model.display_name`, `terminal_width`, `workspace.current_dir`.

`agent_state` values seen in official examples (verified): `initializing`, `idle`,
`thinking`, `working`, `tool_use`. Both scripts have a wildcard fallback, so **other
values exist** (screenshots show "Review Mode" / "Tool Confirmation" states — exact
strings unknown; log them at runtime before mapping).

This is the agy analog of the Claude Code statusline trick: a tiny script that forwards
the stdin JSON to the daemon (`curl -m1 http://127.0.0.1:4770/... || true`) gives a
push-based state feed without touching the TUI.

## 6. Open gaps (must be closed by a live probe, ~15 min with a scratch repo)

1. Does `Stop` fire per turn or per conversation end?
2. Exact stdin payload per event (dump with a `tee`-to-file hook on all five events).
3. Which hooks.json path(s) does the installed v1.0.0 actually read (write both, check log)?
4. Full `agent_state` enum (capture statusline stdin during a permission prompt / review).
5. `.pb` → SQLite conversation-format timing after `agy update`.

## Recommendation

**Event-driven adapter feasible — do NOT mark agy mux-observed.** Two complementary
surfaces, both at the terminal boundary with the TUI unmodified:

- **Primary state feed: statusline stdin JSON** (`agent_state`:
  `initializing|idle|thinking|working|tool_use|…`) via a forwarder script configured in
  settings with `stack_with_default`. Verified, official, push-based; drives
  `launching|working|idle` and gates injection on `idle`.
- **Secondary lifecycle hooks: `PreToolUse`, `PostToolUse`, `Stop`** (plus
  `PreInvocation`/`PostInvocation` if the live probe confirms per-turn semantics) in
  `hooks.json`, handler `type: "command"` posting stdin JSON to the daemon. Write to
  both global hooks.json paths + workspace `.agents/hooks.json`; verify via the
  `Loaded hooks.json from %s` log line.
- `needs_you` (permission prompts) has **no hook event** — derive it from the
  statusline/title state feed once the review/confirmation `agent_state` values are
  captured, else fall back to `capture-pane` heuristics for that one state.
- Session files are protobuf (moving to SQLite), so no transcript tailing — previews
  come from `capture-pane` as designed.

Run the §6 live probe before writing the adapter's event mapper; every event-name and
payload assumption above that is labeled likely/guess must be confirmed by the dump.
