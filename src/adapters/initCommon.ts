import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../config.ts";
import { writeConfigFile, type WriteResult } from "../util/configFile.ts";

/** Options every `bridge init` writer accepts (home/repo injectable for tests). */
export interface InitOptions {
  home?: string;
  print?: (line: string) => void;
  dryRun?: boolean;
}

export function resolveHome(opts: InitOptions): string {
  return opts.home ?? homedir();
}

export function shimsDir(opts: InitOptions): string {
  // Shims live under the bridge state dir, referenced by absolute path from
  // agent configs. Keep them out of ~/.codex / ~/.gemini so those stay auditable.
  return opts.home !== undefined
    ? join(opts.home, ".local", "state", "agent-bridge", "shims")
    : join(stateDir(), "shims");
}

/** Write an executable shim script through the diff+backup engine. */
export function writeShim(path: string, content: string, opts: InitOptions): WriteResult {
  const res = writeConfigFile(path, content, { print: opts.print, dryRun: opts.dryRun });
  if (!opts.dryRun && existsSync(path)) chmodSync(path, 0o755);
  return res;
}

/**
 * Read a JSON config file that we intend to merge into. A parse failure
 * aborts loudly — never risk clobbering a file we cannot understand.
 */
export function readJsonConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON — refusing to touch it (${String(e)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a top-level JSON object — refusing to touch it`);
  }
  return parsed as Record<string, unknown>;
}

export function serializeJson(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}
