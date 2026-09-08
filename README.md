# Agent Bridge

Run a Claude Code implementer and a Codex reviewer in their native interactive TUIs.
A terminal console tracks the task and peer messages; Enter opens either session.

**macOS prototype.** The pair works in separate worktrees cloned from a committed project.
Your source checkout stays unchanged. A task finishes when Codex accepts Claude's exact commit.
Configurable fleets, Windows, and Linux/WSL2 follow the validated pair.
New runs default to permission bypass/YOLO with configurable model and effort.
These controls await live qualification; quota/context visibility follows.

## Start a task

Install Bun, tmux 3.2+, Claude Code, and Codex. Authenticate both agents normally.

```sh
bun install
bun bin/bridge run defaults > run-settings.json
# Edit the per-agent settings, then:
bun bin/bridge run prepare /path/to/project --config run-settings.json --task "Describe the result and checks you want"
```

The command prints a run directory and its `PLAN.md`. Follow that short setup to review native
project/hook trust, launch the pair, and open the console. Native setup must precede the private
Codex host. Preparation requires a clean source checkout; it copies committed files only.
Tracked `.codex/hooks.json` files currently need configuration reconciliation and are refused before setup.

Omit `--config` to use defaults: inherited Claude model/high effort, Codex Astra/ultra, bypass both.
The JSON supports native model aliases/IDs, effort, permission controls, and an optional non-secret
`accountRef` label. Claude thinking can inherit, enable, or disable where supported; enabling sets
a visible 31,999-token budget for budget-based models. `run status` separates requested, configured
and observed settings; missing native evidence stays pending. Existing version-1 runs keep their policy.

```sh
bun bin/bridge run console /path/to/run
```

| Key | Action |
|---|---|
| j/k or arrows | Select agent |
| Enter | Open its native TUI; Ctrl-b d returns |
| r | Confirm native readiness and resume peer delivery |
| p | Pause new peer delivery |
| s | Start the task once |
| q | Close the console; sessions keep running |

To detach, press Control+B, release both keys, then press lowercase d.
Review native trust and tool prompts before pressing r for each agent, then s.
Entering a session pauses its Bridge delivery until you resume it. Unsent drafts stay in the
native composer. Both new runtimes can write; the reviewer is instructed to preserve its checkout.
A dirty reviewer checkout or HEAD away from the base blocks either review decision.
Any permission requests from an explicit override or native policy are handled in that session.
The nine Bridge tools are pre-approved within the run; peer messages cannot grant permissions.
Runs expire after four hours. An expired run stays inspectable; resume and start require a new run.

## Finish or recover

```sh
bun bin/bridge run export /path/to/run
bun bin/bridge run stop /path/to/run
```

Export writes `result.patch` for an accepted commit. Review it before applying it to your project.
Runs retain task state and separate transport/read/ACK receipts. If the coordinator stops,
`run recover /path/to/run` reconnects the same sessions; confirm readiness again in the console.
Recover before using `run attach` when the coordinator is unavailable.
Uncertain sends stay held and are never replayed automatically.

The tested native routes use a Claude development Channel and Codex experimental legacy history
at startup. See [status and validation limits](PROGRESS.md). The isolated nonce pilot and earlier
manual-handoff commands remain available through `bun bin/bridge --help`.

## Develop

```sh
./scripts/check.sh
```

[Design](DESIGN.md) · [Prototype review](docs/reviews/2026-09-07-prototype-review.md) · [Contributor instructions](AGENTS.md)
