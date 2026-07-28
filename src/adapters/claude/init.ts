import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentForKind, type BridgeConfig } from "../../config.ts";
import { writeConfigFile, type WriteResult } from "../../util/configFile.ts";
import {
  readJsonConfig,
  quoteShellArg,
  scopedShimsDir,
  serializeJson,
  shimsDir,
  unquoteGeneratedShellArg,
  writeShim,
  type InitOptions,
} from "../initCommon.ts";

/**
 * Wire Claude Code to the daemon via native `http` hook handlers plus the
 * command-only SessionStart surface in repo-local .claude/settings.json.
 * Schema verified against code.claude.com/docs/en/hooks July 2026.
 *
 * Events: HANDOFF.md's five plus UserPromptSubmit/PostToolUse (DECISIONS.md
 * 2026-07-07 — without them `working` is unobservable).
 */

const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: "SessionEnd" },
  { event: "UserPromptSubmit" },
  { event: "Stop" },
  { event: "StopFailure" },
  { event: "PermissionRequest" },
  { event: "PermissionDenied" },
  { event: "PostToolUse" },
  { event: "Notification", matcher: "permission_prompt|agent_needs_input" },
];
const SESSION_START = "SessionStart";

export function claudeEventsUrl(cfg: BridgeConfig): string {
  const claude = agentForKind(cfg, "claude");
  if (claude === undefined) throw new Error("no Claude Code instance is configured");
  return `http://127.0.0.1:${cfg.daemonPort}/events/${claude.id}`;
}

function httpHandler(url: string): Record<string, unknown> {
  // Short timeout: the daemon answers in ms and hook failures are non-blocking.
  return {
    type: "http",
    url,
    timeout: 10,
    headers: { "X-Agent-Bridge": "1" },
  };
}

export function claudeSessionStartShimPath(
  cfg: BridgeConfig,
  opts: InitOptions,
): string {
  return join(scopedShimsDir(cfg, opts), "bridge-claude-session-start.sh");
}

function hookShimScript(url: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: forward a Claude Code command-hook payload to the local daemon.
curl -fsS -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${url}" >/dev/null 2>&1 || true
exit 0
`;
}

/**
 * New groups carry a literal ownership header, so changing daemonPort or
 * AgentId replaces only our handlers. The legacy URL check migrates groups
 * written by the pre-reframe implementation without claiming arbitrary local
 * HTTP hooks owned by the user.
 */
const LEGACY_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/events\/claude$/;

function isOwnedHandler(handler: unknown, opts: InitOptions): boolean {
  if (typeof handler !== "object" || handler === null || Array.isArray(handler)) {
    return false;
  }
  const record = handler as Record<string, unknown>;
  const headers =
    typeof record.headers === "object" && record.headers !== null
      ? (record.headers as Record<string, unknown>)
      : {};
  const ownedHttp =
    record.type === "http" &&
    ((headers["X-Agent-Bridge"] === "1") ||
      (typeof record.url === "string" && LEGACY_URL_RE.test(record.url)));
  const ownedCommand =
    record.type === "command" &&
    typeof record.command === "string" &&
    unquoteGeneratedShellArg(record.command).startsWith(`${shimsDir(opts)}/`) &&
    unquoteGeneratedShellArg(record.command).endsWith("/bridge-claude-session-start.sh");
  return ownedHttp || ownedCommand;
}

/** Remove only our handlers, retaining mixed-group metadata and foreign handlers. */
function pruneOwnedHandlers(group: unknown, opts: InitOptions): unknown | null {
  if (typeof group !== "object" || group === null || Array.isArray(group)) return group;
  const record = group as Record<string, unknown>;
  if (!Array.isArray(record.hooks)) return group;
  const hooks = record.hooks.filter((handler) => !isOwnedHandler(handler, opts));
  if (hooks.length === record.hooks.length) return group;
  return hooks.length === 0 ? null : { ...record, hooks };
}

export function initClaude(cfg: BridgeConfig, opts: InitOptions = {}): WriteResult {
  const print = opts.print ?? console.log;
  // Project-scope hooks only apply where the pane actually runs — which is
  // the agent's cwd override when one is set, not necessarily cfg.repo.
  const claude = agentForKind(cfg, "claude");
  if (claude === undefined) throw new Error("no Claude Code instance is configured");
  const claudeCwd = claude.cwd ?? cfg.repo;
  const path = join(claudeCwd, ".claude", "settings.json");
  const url = claudeEventsUrl(cfg);

  const settings = readJsonConfig(path);
  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};

  for (const { event, matcher } of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const foreign = existing
      .map((group) => pruneOwnedHandlers(group, opts))
      .filter((group) => group !== null);
    const group: Record<string, unknown> = { hooks: [httpHandler(url)] };
    if (matcher !== undefined) group.matcher = matcher;
    hooks[event] = [...foreign, group];
  }
  const sessionStartShim = claudeSessionStartShimPath(cfg, opts);
  writeShim(sessionStartShim, hookShimScript(url), opts);
  const sessionStartExisting = Array.isArray(hooks[SESSION_START])
    ? hooks[SESSION_START]
    : [];
  const sessionStartForeign = sessionStartExisting
    .map((group) => pruneOwnedHandlers(group, opts))
    .filter((group) => group !== null);
  hooks[SESSION_START] = [
    ...sessionStartForeign,
    {
      hooks: [{
        type: "command",
        command: quoteShellArg(sessionStartShim),
        timeout: 10,
      }],
    },
  ];
  settings.hooks = hooks;

  print(`claude: hooks (HTTP + SessionStart command → ${url}) in ${path}`);
  return writeConfigFile(path, serializeJson(settings), { print, dryRun: opts.dryRun });
}

/** Remove only Agent Bridge handlers when a configured Claude instance is disabled. */
export function removeClaudeHooks(
  cfg: BridgeConfig,
  opts: InitOptions = {},
): WriteResult {
  const print = opts.print ?? console.log;
  const claude = agentForKind(cfg, "claude");
  if (claude === undefined) throw new Error("no Claude Code instance is configured");
  const path = join(claude.cwd ?? cfg.repo, ".claude", "settings.json");
  if (!existsSync(path)) {
    print(`claude: disabled; no settings file to unwind at ${path}`);
    return { path, changed: false, backupPath: null };
  }

  const settings = readJsonConfig(path);
  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  let removed = false;
  for (const event of [SESSION_START, ...HOOK_EVENTS.map((entry) => entry.event)]) {
    if (!Array.isArray(hooks[event])) continue;
    const existing = hooks[event];
    const pruned = existing
      .map((group) => pruneOwnedHandlers(group, opts))
      .filter((group) => group !== null);
    if (pruned.length !== existing.length || pruned.some((group, i) => group !== existing[i])) {
      removed = true;
      if (pruned.length === 0) delete hooks[event];
      else hooks[event] = pruned;
    }
  }
  if (!removed) {
    print(`claude: disabled; no Agent Bridge hooks found in ${path}`);
    return { path, changed: false, backupPath: null };
  }
  settings.hooks = hooks;
  print(`claude: disabled; removing Agent Bridge hooks from ${path}`);
  return writeConfigFile(path, serializeJson(settings), {
    print,
    dryRun: opts.dryRun,
  });
}
