import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeConfigFile } from "../util/configFile.ts";
import {
  readJsonConfig,
  resolveHome,
  serializeJson,
  shimsDir,
  type InitOptions,
} from "./initCommon.ts";

const LEGACY_NOTIFY_COMMENT =
  "# agent-bridge: forward turn-complete notifications to the daemon";
const AGY_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PermissionRequest",
  "PostToolUse",
] as const;

function retireCodexNotify(opts: InitOptions): void {
  const print = opts.print ?? console.log;
  const path = join(resolveHome(opts), ".codex", "config.toml");
  if (!existsSync(path)) return;

  const before = readFileSync(path, "utf8");
  const legacyShim = join(shimsDir(opts), "bridge-codex-notify.sh");
  const legacyNotify = `notify = ["${legacyShim}"]`;
  const lines = before.split("\n");
  const notifyIndex = lines.findIndex((line) => line.trim() === legacyNotify);
  if (notifyIndex === -1) return;

  const remove = new Set([notifyIndex]);
  if (lines[notifyIndex - 1]?.trim() === LEGACY_NOTIFY_COMMENT) {
    remove.add(notifyIndex - 1);
  }
  const after = lines.filter((_line, index) => !remove.has(index)).join("\n");
  print(`codex: retiring legacy Agent Bridge notify from ${path}`);
  writeConfigFile(path, after, { print, dryRun: opts.dryRun });
}

function isLegacyCodexHandler(handler: unknown, opts: InitOptions): boolean {
  if (typeof handler !== "object" || handler === null || Array.isArray(handler)) return false;
  const record = handler as Record<string, unknown>;
  if (record.type !== "command" || typeof record.command !== "string") return false;
  return (
    record.command === join(shimsDir(opts), "bridge-codex-hook.sh") ||
    (record.command.startsWith(`${shimsDir(opts)}/`) &&
      record.command.endsWith("/bridge-codex-hook.sh"))
  );
}

function pruneLegacyCodexGroup(group: unknown, opts: InitOptions): unknown | null {
  if (typeof group !== "object" || group === null || Array.isArray(group)) return group;
  const record = group as Record<string, unknown>;
  if (!Array.isArray(record.hooks)) return group;
  const hooks = record.hooks.filter((handler) => !isLegacyCodexHandler(handler, opts));
  if (hooks.length === record.hooks.length) return group;
  return hooks.length === 0 ? null : { ...record, hooks };
}

function retireGlobalCodexHooks(opts: InitOptions): void {
  const print = opts.print ?? console.log;
  const path = join(resolveHome(opts), ".codex", "hooks.json");
  if (!existsSync(path)) return;
  const root = readJsonConfig(path);
  if (typeof root.hooks !== "object" || root.hooks === null || Array.isArray(root.hooks)) return;
  const hooks = root.hooks as Record<string, unknown>;
  let removed = false;
  for (const event of CODEX_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const existing = hooks[event];
    const pruned = existing
      .map((group) => pruneLegacyCodexGroup(group, opts))
      .filter((group) => group !== null);
    if (pruned.length !== existing.length || pruned.some((group, i) => group !== existing[i])) {
      removed = true;
      if (pruned.length === 0) delete hooks[event];
      else hooks[event] = pruned;
    }
  }
  if (!removed) return;
  root.hooks = hooks;
  print(`codex: retiring legacy global Agent Bridge hooks from ${path}`);
  writeConfigFile(path, serializeJson(root), { print, dryRun: opts.dryRun });
}

function isExactLegacyAgyBlock(value: unknown, opts: InitOptions): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  if (Object.keys(block).sort().join("|") !== [...AGY_EVENTS].sort().join("|")) return false;

  for (const event of AGY_EVENTS) {
    const expected = join(shimsDir(opts), `bridge-agy-hook-${event}.sh`);
    const groups = block[event];
    if (!Array.isArray(groups) || groups.length !== 1) return false;
    const group = groups[0];
    if (typeof group !== "object" || group === null || Array.isArray(group)) return false;
    const groupRecord = group as Record<string, unknown>;
    if (Object.keys(groupRecord).sort().join("|") !== "hooks|matcher") return false;
    if (groupRecord.matcher !== "*") return false;
    const hooks = groupRecord.hooks;
    if (!Array.isArray(hooks) || hooks.length !== 1) return false;
    const hook = hooks[0];
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) return false;
    const record = hook as Record<string, unknown>;
    if (Object.keys(record).sort().join("|") !== "command|timeout|type") return false;
    if (
      record.type !== "command" ||
      record.command !== expected ||
      record.timeout !== 10
    ) return false;
  }
  return true;
}

function retireAgyHooks(path: string, opts: InitOptions): void {
  if (!existsSync(path)) return;
  const print = opts.print ?? console.log;
  const root = readJsonConfig(path);
  if (!("agent-bridge" in root)) return;
  if (!isExactLegacyAgyBlock(root["agent-bridge"], opts)) {
    print(`agy: WARNING — ${path} has a modified "agent-bridge" block; leaving it untouched`);
    return;
  }
  delete root["agent-bridge"];
  print(`agy: retiring legacy Agent Bridge hook block from ${path}`);
  writeConfigFile(path, serializeJson(root), { print, dryRun: opts.dryRun });
}

/**
 * One-time reset for exact callback definitions written by origin/phase-0.
 * Each surface is isolated so a malformed parked-provider file cannot block
 * active Claude/Codex initialization.
 */
export function retireLegacyIntegrations(opts: InitOptions = {}): number {
  const print = opts.print ?? console.log;
  const home = resolveHome(opts);
  const actions: Array<() => void> = [
    () => retireCodexNotify(opts),
    () => retireGlobalCodexHooks(opts),
    () => retireAgyHooks(join(home, ".gemini", "config", "hooks.json"), opts),
    () =>
      retireAgyHooks(
        join(home, ".gemini", "antigravity-cli", "hooks.json"),
        opts,
      ),
  ];
  let failures = 0;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      failures++;
      print(
        `legacy cleanup: FAILED — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}
