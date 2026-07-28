import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "./diff.ts";

export interface WriteResult {
  path: string;
  changed: boolean;
  backupPath: string | null;
}

/**
 * The single engine every `bridge init` writer goes through. Enforces
 * CLAUDE.md constraint #5: print a diff before writing, back up the
 * original, and stay idempotent (identical content -> no write, no backup).
 */
export function writeConfigFile(
  path: string,
  next: string,
  opts: { print?: (line: string) => void; dryRun?: boolean } = {},
): WriteResult {
  const print = opts.print ?? console.log;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (before === next) {
    print(`  ${path}: already up to date`);
    return { path, changed: false, backupPath: null };
  }

  const diff = unifiedDiff(before, next, path);
  print(diff);

  if (opts.dryRun) return { path, changed: false, backupPath: null };

  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak.${new Date().toISOString().replaceAll(":", "-")}`;
    copyFileSync(path, backupPath);
    print(`  backed up original to ${backupPath}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  print(`  wrote ${path}`);
  return { path, changed: true, backupPath };
}
