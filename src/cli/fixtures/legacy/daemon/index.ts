import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

const port = Number.parseInt(arg("--port"), 10);
const pidFile = arg("--pid-file");
// Parsed to keep the fixture's argv contract identical to origin/phase-0.
arg("--dir");

const agents = {
  claude: { enabled: true },
  codex: { enabled: true },
  agy: { enabled: true },
  opencode: { enabled: true },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req): Response {
    const path = new URL(req.url).pathname;
    if (path === "/status") {
      return Response.json({
        daemon: { startedAt: Date.now(), port, pid: process.pid },
        agents,
      });
    }
    if (path === "/healthz") return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});

mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, String(process.pid));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  rmSync(pidFile, { force: true });
  process.exit(0);
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
