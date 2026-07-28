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
 * Wire Codex CLI to the daemon through project-local .codex/hooks.json
 * command shims (stdin JSON → curl). We deliberately do not claim `notify`
 * setting; the Stop lifecycle hook is the canonical completion signal.
 * Schema verified against developers.openai.com/codex/hooks July 2026.
 *
 * Trust model: Codex records approval per hook-definition hash, so the writer
 * must stay byte-identical across runs — one interactive `/hooks` approval
 * then survives re-runs (DECISIONS.md 2026-07-07).
 */

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"] as const;

export function codexEventsUrl(cfg: BridgeConfig): string {
  const codex = agentForKind(cfg, "codex");
  if (codex === undefined) throw new Error("no Codex instance is configured");
  return `http://127.0.0.1:${cfg.daemonPort}/events/${codex.id}`;
}

export function codexHookShimPath(cfg: BridgeConfig, opts: InitOptions): string {
  return join(scopedShimsDir(cfg, opts), "bridge-codex-hook.sh");
}

function hookShimScript(url: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: forward a Codex hook payload (stdin JSON) to the local daemon.
# Must NEVER fail or block the agent: short timeout, always exit 0.
curl -fsS -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${url}" >/dev/null 2>&1 || true
exit 0
`;
}

function isOwnedHandler(handler: unknown, opts: InitOptions): boolean {
  if (typeof handler !== "object" || handler === null || Array.isArray(handler)) {
    return false;
  }
  const record = handler as Record<string, unknown>;
  if (record.type !== "command" || typeof record.command !== "string") return false;
  const commandPath = unquoteGeneratedShellArg(record.command);
  return (
    commandPath === join(shimsDir(opts), "bridge-codex-hook.sh") ||
    (commandPath.startsWith(`${shimsDir(opts)}/`) &&
      commandPath.endsWith("/bridge-codex-hook.sh"))
  );
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

export interface CodexInitResult {
  hooksJson: WriteResult;
}

export function initCodex(cfg: BridgeConfig, opts: InitOptions = {}): CodexInitResult {
  const print = opts.print ?? console.log;
  const url = codexEventsUrl(cfg);
  const codex = agentForKind(cfg, "codex");
  if (codex === undefined) throw new Error("no Codex instance is configured");

  // 1. Shims (through the diff+backup engine like everything else).
  const hookShim = codexHookShimPath(cfg, opts);
  writeShim(hookShim, hookShimScript(url), opts);

  // 2. Project-local hooks: avoid observing unrelated Codex sessions.
  const hooksPath = join(codex.cwd ?? cfg.repo, ".codex", "hooks.json");
  const root = readJsonConfig(hooksPath);
  const hooks =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const foreign = existing
      .map((group) => pruneOwnedHandlers(group, opts))
      .filter((group) => group !== null);
    hooks[event] = [
      ...foreign,
      {
        hooks: [{
          type: "command",
          command: quoteShellArg(hookShim),
          timeout: 10,
        }],
      },
    ];
  }
  root.hooks = hooks;
  print(`codex: hooks (command shim → ${url}) in ${hooksPath}`);
  const hooksJson = writeConfigFile(hooksPath, serializeJson(root), { print, dryRun: opts.dryRun });
  if (hooksJson.changed) {
    print("codex: NOTE — run /hooks inside codex once to approve the new hook definitions");
    print("codex:        (trust is per definition hash; identical re-runs stay approved)");
  }

  return { hooksJson };
}

/** Remove only Agent Bridge handlers when the configured Codex instance is disabled. */
export function removeCodexHooks(
  cfg: BridgeConfig,
  opts: InitOptions = {},
): WriteResult {
  const print = opts.print ?? console.log;
  const codex = agentForKind(cfg, "codex");
  if (codex === undefined) throw new Error("no Codex instance is configured");
  const hooksPath = join(codex.cwd ?? cfg.repo, ".codex", "hooks.json");
  const root = readJsonConfig(hooksPath);
  const hooks =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  let removed = false;
  for (const event of HOOK_EVENTS) {
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
    print(`codex: disabled; no Agent Bridge hooks found in ${hooksPath}`);
    return { path: hooksPath, changed: false, backupPath: null };
  }
  root.hooks = hooks;
  print(`codex: disabled; removing Agent Bridge hooks from ${hooksPath}`);
  return writeConfigFile(hooksPath, serializeJson(root), {
    print,
    dryRun: opts.dryRun,
  });
}
