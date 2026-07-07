import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../../config.ts";
import { writeConfigFile, type WriteResult } from "../../util/configFile.ts";
import {
  readJsonConfig,
  resolveHome,
  serializeJson,
  shimsDir,
  writeShim,
  type InitOptions,
} from "../initCommon.ts";

/**
 * Wire Codex CLI to the daemon: ~/.codex/hooks.json command shims (stdin JSON
 * → curl) plus `notify` in ~/.codex/config.toml for agent-turn-complete.
 * Schema verified against developers.openai.com/codex/hooks July 2026.
 *
 * Trust model: Codex records approval per hook-definition hash, so the writer
 * must stay byte-identical across runs — one interactive `/hooks` approval
 * then survives re-runs (DECISIONS.md 2026-07-07).
 */

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"] as const;

interface HookGroup {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

export function codexEventsUrl(cfg: BridgeConfig): string {
  return `http://127.0.0.1:${cfg.daemonPort}/events/codex`;
}

export function codexHookShimPath(opts: InitOptions): string {
  return join(shimsDir(opts), "bridge-codex-hook.sh");
}

export function codexNotifyShimPath(opts: InitOptions): string {
  return join(shimsDir(opts), "bridge-codex-notify.sh");
}

function hookShimScript(url: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: forward a Codex hook payload (stdin JSON) to the local daemon.
# Must NEVER fail or block the agent: short timeout, always exit 0.
curl -fsS -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${url}" >/dev/null 2>&1 || true
exit 0
`;
}

function notifyShimScript(url: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: forward a Codex notify payload (JSON in argv[1]) to the daemon.
# Must NEVER fail or block the agent: short timeout, always exit 0.
if [ -n "\${1:-}" ]; then
  curl -fsS -m 2 -X POST -H 'content-type: application/json' --data-binary "\$1" "${url}" >/dev/null 2>&1 || true
fi
exit 0
`;
}

function isOurs(group: HookGroup, shimPath: string): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((h) => h.type === "command" && h.command === shimPath)
  );
}

export interface CodexInitResult {
  hooksJson: WriteResult;
  configTomlChanged: boolean;
  notifyConflict: string | null;
}

export function initCodex(cfg: BridgeConfig, opts: InitOptions = {}): CodexInitResult {
  const print = opts.print ?? console.log;
  const home = resolveHome(opts);
  const url = codexEventsUrl(cfg);

  // 1. Shims (through the diff+backup engine like everything else).
  const hookShim = codexHookShimPath(opts);
  const notifyShim = codexNotifyShimPath(opts);
  writeShim(hookShim, hookShimScript(url), opts);
  writeShim(notifyShim, notifyShimScript(url), opts);

  // 2. ~/.codex/hooks.json — merge our command groups, preserve foreign ones.
  const hooksPath = join(home, ".codex", "hooks.json");
  const root = readJsonConfig(hooksPath);
  const hooks =
    typeof root.hooks === "object" && root.hooks !== null && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : {};
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const foreign = existing.filter((g) => !isOurs(g, hookShim));
    hooks[event] = [...foreign, { hooks: [{ type: "command", command: hookShim, timeout: 10 }] }];
  }
  root.hooks = hooks;
  print(`codex: hooks (command shim → ${url}) in ${hooksPath}`);
  const hooksJson = writeConfigFile(hooksPath, serializeJson(root), { print, dryRun: opts.dryRun });
  if (hooksJson.changed) {
    print("codex: NOTE — run /hooks inside codex once to approve the new hook definitions");
    print("codex:        (trust is per definition hash; identical re-runs stay approved)");
  }

  // 3. notify = [...] in ~/.codex/config.toml. TOML top-level keys must appear
  //    before the first [section]; we only ever insert at the top, and we never
  //    overwrite a foreign notify setting.
  const tomlPath = join(home, ".codex", "config.toml");
  const desired = `notify = ["${notifyShim}"]`;
  const current = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const notifyLine = current.split("\n").find((l) => /^\s*notify\s*=/.test(l));

  let configTomlChanged = false;
  let notifyConflict: string | null = null;
  if (notifyLine === undefined) {
    const next = `# agent-bridge: forward turn-complete notifications to the daemon\n${desired}\n${current}`;
    print(`codex: notify → ${tomlPath}`);
    configTomlChanged = writeConfigFile(tomlPath, next, { print, dryRun: opts.dryRun }).changed;
  } else if (notifyLine.trim() === desired) {
    print(`codex: notify already wired in ${tomlPath}`);
  } else {
    notifyConflict = notifyLine.trim();
    print(`codex: WARNING — ${tomlPath} already sets: ${notifyConflict}`);
    print(`codex:            leaving it untouched (turn-complete still arrives via the Stop hook).`);
    print(`codex:            to also use notify, set it yourself to: ${desired}`);
  }

  return { hooksJson, configTomlChanged, notifyConflict };
}
