import type { BridgeConfig } from "../config.ts";
import type { InitOptions } from "../adapters/initCommon.ts";
import { initClaude, removeClaudeHooks } from "../adapters/claude/init.ts";
import { initCodex, removeCodexHooks } from "../adapters/codex/init.ts";
import type { AgentKind } from "../types.ts";

/**
 * `bridge init` — wire each configured adapter kind to the daemon.
 * Each writer prints a diff before writing and backs up originals
 * (src/util/configFile.ts enforces this); all writers are idempotent.
 * One failing writer never blocks the others.
 */
export function runInit(cfg: BridgeConfig, opts: InitOptions = {}): number {
  const print = opts.print ?? console.log;
  const writers: Record<AgentKind, (enabled: boolean) => void> = {
    claude: (enabled) =>
      void (enabled ? initClaude(cfg, opts) : removeClaudeHooks(cfg, opts)),
    codex: (enabled) =>
      void (enabled ? initCodex(cfg, opts) : removeCodexHooks(cfg, opts)),
  };

  let failures = 0;
  for (const agent of cfg.agents) {
    const label = agent.id === agent.kind ? agent.id : `${agent.id} (${agent.kind})`;
    print("");
    print(`── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
    try {
      writers[agent.kind](agent.enabled);
    } catch (e) {
      failures++;
      print(`${agent.id}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  print("");
  print(failures === 0 ? "init complete" : `init finished with ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}
