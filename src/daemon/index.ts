import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILENAME, loadConfig } from "../config.ts";
import { daemonPidFile } from "../paths.ts";
import { startDaemon } from "./server.ts";
import { subscribeOpencode } from "./opencodeSse.ts";

/**
 * Daemon entrypoint: `bun src/daemon/index.ts [--dir <repoDir>]`.
 * Boots the HTTP ingest/status server, the OpenCode SSE subscriber (wired
 * into the same append/apply path), and a pidfile; tears all of it down
 * cleanly on SIGINT/SIGTERM. The agents never notice either way
 * (CLAUDE.md constraint 1).
 */

function parseDirArg(argv: string[]): string | undefined {
  const i = argv.indexOf("--dir");
  if (i === -1) return undefined;
  const dir = argv[i + 1];
  if (dir === undefined) {
    console.error("usage: bun src/daemon/index.ts [--dir <repoDir>]");
    process.exit(2);
  }
  return dir;
}

export function main(): void {
  const dir = parseDirArg(process.argv.slice(2));
  const configRoot = resolve(dir ?? process.cwd());
  const configPath = join(configRoot, CONFIG_FILENAME);
  const configSource = existsSync(configPath) ? configPath : "built-in defaults";
  const cfg = loadConfig(dir);

  // Opens the store at cfg.db and binds 127.0.0.1:cfg.daemonPort.
  const daemon = startDaemon(cfg);
  const subscription = subscribeOpencode({
    port: cfg.opencodePort,
    onEvent: daemon.ingest,
    onLog: (line) => console.log(line),
  });

  const pidFile = daemonPidFile(cfg.daemonPort);
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  console.log(`[daemon] config: ${configSource}`);
  console.log(`[daemon] listening on 127.0.0.1:${daemon.port}`);
  console.log(`[daemon] event store: ${cfg.db}`);
  console.log(`[daemon] opencode SSE source: 127.0.0.1:${cfg.opencodePort}/event`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] ${signal}: shutting down`);
    subscription.stop();
    await daemon.stop(); // stops the HTTP server and closes the store
    try {
      unlinkSync(pidFile);
    } catch {
      // pidfile already gone — fine
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main();
}
