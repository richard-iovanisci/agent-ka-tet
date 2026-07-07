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
 * Best-effort agy (Antigravity CLI) wiring per docs/agy-notes.md:
 *  - hooks.json uses a NAMED-hook schema (name → event → matcher groups) and
 *    lives at BOTH ~/.gemini/config/hooks.json (canonical) and
 *    ~/.gemini/antigravity-cli/hooks.json (legacy /hooks write target) — we
 *    write both so it works on either side of the upstream path fix.
 *  - Only PreToolUse/PostToolUse/Stop are verified-ish; payloads may not name
 *    their event, so each event gets its own shim with ?native=<Event> baked in.
 *  - The best state signal is the statusline stdin feed (agent_state). The
 *    settings path/key for statusLine is NOT verified, so we install the
 *    forwarder script and print exact instructions instead of editing an
 *    unverified file.
 */

const AGY_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
const NAMED_HOOK = "agent-bridge";

export function agyEventsUrl(cfg: BridgeConfig): string {
  return `http://127.0.0.1:${cfg.daemonPort}/events/agy`;
}

export function agyHookShimPath(event: string, opts: InitOptions): string {
  return join(shimsDir(opts), `bridge-agy-hook-${event}.sh`);
}

export function agyStatuslineShimPath(opts: InitOptions): string {
  return join(shimsDir(opts), "bridge-agy-statusline.sh");
}

function hookShimScript(url: string, event: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: forward an agy ${event} hook payload (stdin JSON) to the daemon.
# agy payloads are not verified to name their event, so the shim annotates it.
# Must NEVER fail or block the agent: short timeout, exit 0, allow the tool.
curl -fsS -m 2 -X POST -H 'content-type: application/json' --data-binary @- "${url}?native=${event}" >/dev/null 2>&1 || true
echo '{}'
exit 0
`;
}

function statuslineShimScript(url: string): string {
  return `#!/usr/bin/env bash
# agent-bridge: tee agy's statusline stdin JSON (carries agent_state) to the
# daemon. Emits nothing so the native statusline still renders when configured
# with stack_with_default. Must NEVER fail: short timeout, exit 0.
curl -fsS -m 1 -X POST -H 'content-type: application/json' --data-binary @- "${url}" >/dev/null 2>&1 || true
exit 0
`;
}

export interface AgyInitResult {
  hooksFiles: WriteResult[];
  statuslineInstructions: string;
}

export function initAgy(cfg: BridgeConfig, opts: InitOptions = {}): AgyInitResult {
  const print = opts.print ?? console.log;
  const home = resolveHome(opts);
  const url = agyEventsUrl(cfg);

  // 1. One shim per event (?native= baked in) + the statusline forwarder.
  for (const event of AGY_EVENTS) {
    writeShim(agyHookShimPath(event, opts), hookShimScript(url, event), opts);
  }
  writeShim(agyStatuslineShimPath(opts), statuslineShimScript(url), opts);

  // 2. Named-hook block, merged into BOTH hooks.json locations. Namespacing by
  //    hook name gives clean idempotency: we own "agent-bridge", nothing else.
  const block: Record<string, unknown> = {};
  for (const event of AGY_EVENTS) {
    block[event] = [
      {
        matcher: "*",
        hooks: [{ type: "command", command: agyHookShimPath(event, opts), timeout: 10 }],
      },
    ];
  }

  const paths = [
    join(home, ".gemini", "config", "hooks.json"),
    join(home, ".gemini", "antigravity-cli", "hooks.json"),
  ];
  const hooksFiles: WriteResult[] = [];
  for (const path of paths) {
    const root = readJsonConfig(path);
    root[NAMED_HOOK] = block;
    print(`agy: named hook "${NAMED_HOOK}" (command shims → ${url}) in ${path}`);
    hooksFiles.push(writeConfigFile(path, serializeJson(root), { print, dryRun: opts.dryRun }));
  }

  // 3. Statusline feed: print instructions, don't edit unverified settings.
  const statuslineInstructions = [
    `agy: statusline state feed (primary signal — agent_state) is NOT auto-configured`,
    `agy: because the settings path/key is unverified (docs/agy-notes.md §5). To enable:`,
    `agy:   1. open agy's settings (the /settings surface or its settings file)`,
    `agy:   2. set statusLine to: ${agyStatuslineShimPath(opts)}`,
    `agy:   3. keep the native line with stack_with_default: true`,
    `agy: verify afterwards: prompt agy once, then check bridge top flips working/idle.`,
    `agy: without this, agy still reports tool activity + Stop via hooks (partial).`,
  ].join("\n");
  print(statuslineInstructions);

  return { hooksFiles, statuslineInstructions };
}
