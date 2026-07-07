import type { BridgeConfig } from "../config.ts";
import type { InitOptions } from "../adapters/initCommon.ts";
import { initClaude } from "../adapters/claude/init.ts";
import { initCodex } from "../adapters/codex/init.ts";
import { initAgy } from "../adapters/agy/init.ts";
import { initOpencode } from "../adapters/opencode/init.ts";

/**
 * `bridge init` — wire every agent's native event surface to the daemon.
 * Each writer prints a diff before writing and backs up originals
 * (src/util/configFile.ts enforces this); all writers are idempotent.
 * One failing writer never blocks the others.
 */
export function runInit(cfg: BridgeConfig, opts: InitOptions = {}): number {
  const print = opts.print ?? console.log;
  const writers: Array<[string, () => void]> = [
    ["claude", () => void initClaude(cfg, opts)],
    ["codex", () => void initCodex(cfg, opts)],
    ["agy", () => void initAgy(cfg, opts)],
    ["opencode", () => initOpencode(cfg, opts)],
  ];

  let failures = 0;
  for (const [name, run] of writers) {
    if (!cfg.agents[name as keyof typeof cfg.agents].enabled) {
      print(`${name}: disabled in bridge.config — skipped`);
      continue;
    }
    print("");
    print(`── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
    try {
      run();
    } catch (e) {
      failures++;
      print(`${name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  print("");
  print(failures === 0 ? "init complete" : `init finished with ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}
