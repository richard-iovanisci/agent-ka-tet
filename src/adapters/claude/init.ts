import { join } from "node:path";
import type { BridgeConfig } from "../../config.ts";
import { writeConfigFile, type WriteResult } from "../../util/configFile.ts";
import { readJsonConfig, serializeJson, type InitOptions } from "../initCommon.ts";

/**
 * Wire Claude Code to the daemon via native `http` hook handlers in the
 * repo's .claude/settings.json — zero shell shims (DESIGN.md §2, schema
 * verified against code.claude.com/docs/en/hooks July 2026).
 *
 * Events: HANDOFF.md's five plus UserPromptSubmit/PostToolUse (DECISIONS.md
 * 2026-07-07 — without them `working` is unobservable).
 */

interface HookGroup {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: "SessionStart" },
  { event: "SessionEnd" },
  { event: "UserPromptSubmit" },
  { event: "Stop" },
  { event: "StopFailure" },
  { event: "PermissionRequest" },
  { event: "PostToolUse" },
  { event: "Notification", matcher: "permission_prompt|idle_prompt|agent_needs_input" },
];

export function claudeEventsUrl(cfg: BridgeConfig): string {
  return `http://127.0.0.1:${cfg.daemonPort}/events/claude`;
}

function httpHandler(url: string): Record<string, unknown> {
  // Short timeout: the daemon answers in ms and hook failures are non-blocking.
  return { type: "http", url, timeout: 10 };
}

/**
 * A group is ours iff every handler in it is an http handler for the bridge
 * events endpoint on ANY port — so changing daemonPort replaces the old
 * groups instead of accumulating hooks that POST to a dead port.
 */
const OUR_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/events\/claude$/;

function isOurs(group: HookGroup): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((h) => h.type === "http" && typeof h.url === "string" && OUR_URL_RE.test(h.url))
  );
}

export function initClaude(cfg: BridgeConfig, opts: InitOptions = {}): WriteResult {
  const print = opts.print ?? console.log;
  // Project-scope hooks only apply where the pane actually runs — which is
  // the agent's cwd override when one is set, not necessarily cfg.repo.
  const claudeCwd = cfg.agents.claude.cwd ?? cfg.repo;
  const path = join(claudeCwd, ".claude", "settings.json");
  const url = claudeEventsUrl(cfg);

  const settings = readJsonConfig(path);
  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};

  for (const { event, matcher } of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    // Idempotency: strip any group that is entirely ours (any port), keep
    // everything else untouched, then append the canonical group.
    const foreign = existing.filter((g) => !isOurs(g));
    const group: HookGroup = { hooks: [httpHandler(url)] };
    if (matcher !== undefined) group.matcher = matcher;
    hooks[event] = [...foreign, group];
  }
  settings.hooks = hooks;

  print(`claude: hooks (http → ${url}) in ${path}`);
  return writeConfigFile(path, serializeJson(settings), { print, dryRun: opts.dryRun });
}
