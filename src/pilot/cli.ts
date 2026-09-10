import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { TmuxAdapter } from "../mux/tmux.ts";
import {
  agentFile,
  loadPilot,
  pilotFile,
  preparePilot,
  readPrivateJson,
  sourceFile,
  writeNativeConfig,
  writePrivateJson,
  type PilotConfig,
  type PilotEndpoint,
} from "./config.ts";
import { pilotRequest } from "./server.ts";
import { launchNativePanes } from "./panes.ts";
import {
  acquireRecoveryLock,
  coordinatorPublished,
  processAlive,
  processRecord,
  processVerifiedGone,
  releaseRecoveryLock,
  removeDeadCoordinatorLock,
} from "./processState.ts";

const HELP = `bridge pilot prepare [new-directory]
bridge pilot launch <directory> --live
bridge pilot status <directory>
bridge pilot attach <directory> [claude|codex]
bridge pilot ready <directory> <claude|codex>
bridge pilot pause <directory> <claude|codex>
bridge pilot start <directory>
bridge pilot recover <directory>
bridge pilot stop <directory>`;

function detached(cfg: PilotConfig, role: string): void {
  const fd = openSync(pilotFile(cfg.root, `${role}.log`), "a", 0o600);
  const child = spawn(process.execPath, [sourceFile("process.ts"), role, cfg.root], {
    cwd: cfg.root,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}

function muxFor(cfg: PilotConfig): TmuxAdapter {
  return new TmuxAdapter({ socketName: cfg.tmuxSocket, configFile: "/dev/null" });
}

export async function launchPilot(cfg: PilotConfig): Promise<void> {
  if (process.platform !== "darwin") throw new Error("the native pilot currently requires macOS");
  const mux = muxFor(cfg);
  if (
    (await mux.hasSession(cfg.tmuxSession)) ||
    existsSync(pilotFile(cfg.root, "coordinator.process.json"))
  ) {
    throw new Error("pilot was already launched; use status or explicit recovery");
  }
  detached(cfg, "coordinator");
  await waitFor(() => coordinatorPublished(cfg.root), "coordinator did not start; inspect its private log");
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(cfg.root, "endpoint.json"));
  writeNativeConfig(cfg, endpoint);
  detached(cfg, "codex-host");
  await waitFor(
    () => existsSync(cfg.socketPath) && processAlive(processRecord(cfg.root, "codex-host"), true),
    "private Codex host did not start; inspect its log",
  );
  await pilotRequest(cfg, "/operator/connect", {});
  await launchNativePanes(cfg, mux);
}

async function ownedMux(cfg: PilotConfig): Promise<TmuxAdapter> {
  const mux = muxFor(cfg);
  if ((await mux.getSessionMarker(cfg.tmuxSession)) !== `native-pilot:${cfg.id}`)
    throw new Error("pilot tmux ownership mismatch");
  return mux;
}

async function stopPilot(cfg: PilotConfig): Promise<void> {
  const mux = muxFor(cfg);
  if (await mux.hasSession(cfg.tmuxSession)) await ownedMux(cfg);
  for (const role of ["claude", "codex", "codex-host", "coordinator"]) {
    const record = processRecord(cfg.root, role);
    if (processAlive(record)) {
      try {
        process.kill(record!.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (role !== "coordinator" && !processAlive(record) && processAlive(record, true)) {
      try {
        process.kill(record!.childPid!, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  await waitFor(
    () =>
      ["claude", "codex", "codex-host", "coordinator"].every((role) => {
        const record = processRecord(cfg.root, role);
        return processVerifiedGone(record) && (role === "coordinator" || processVerifiedGone(record, true));
      }),
    "some pilot processes remain alive or unverified; inspect before further teardown",
    30_000,
  );
  if (await mux.hasSession(cfg.tmuxSession)) await (await ownedMux(cfg)).killSession(cfg.tmuxSession);
}

export async function pilotMain(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.some((a) => ["--help", "-h"].includes(a))) {
    console.log(HELP);
    return 0;
  }
  const [command, directory, agentId, ...extra] = argv;
  const allowed = ["prepare", "launch", "status", "attach", "ready", "pause", "start", "recover", "stop"];
  try {
    if (!allowed.includes(command!)) throw new Error("unknown pilot command");
    if (extra.length || (command === "prepare" && agentId)) throw new Error("unexpected pilot arguments");
    if (command === "prepare") {
      const cfg = preparePilot(directory);
      console.log(
        `Prepared ${cfg.root}\nReview ${pilotFile(cfg.root, "PLAN.md")}\nNo native process was launched.`,
      );
      return 0;
    }
    if (!directory) throw new Error("pilot directory is required");
    const cfg = loadPilot(directory);
    if (command === "launch") {
      if (agentId !== "--live") throw new Error("launch requires --live for the named authenticated pilot");
      await launchPilot(cfg);
      console.log(
        `Pilot ${cfg.id} launched. Attach, resolve native trust prompts, then confirm each agent with pilot ready.`,
      );
    } else if (command === "status") {
      if (agentId) throw new Error("unexpected pilot argument");
      console.log(JSON.stringify(await pilotRequest(cfg, "/operator/status"), null, 2));
    } else if (command === "ready" || command === "pause") {
      if (!cfg.agents.some((a) => a.id === agentId)) throw new Error("expected claude or codex");
      console.log(
        JSON.stringify(
          await pilotRequest(cfg, `/operator/${command}`, {
            agentId,
            ...(command === "ready" ? { confirmNative: true } : {}),
          }),
          null,
          2,
        ),
      );
    } else if (command === "start") {
      if (agentId) throw new Error("unexpected pilot argument");
      console.log(JSON.stringify(await pilotRequest(cfg, "/operator/start", {}), null, 2));
    } else if (command === "attach") {
      if (agentId !== undefined && !cfg.agents.some((a) => a.id === agentId))
        throw new Error("expected claude or codex");
      const mux = await ownedMux(cfg);
      if (agentId) {
        await pilotRequest(cfg, "/operator/pause", { agentId });
        const { paneId } = readPrivateJson<{ paneId: string }>(agentFile(cfg.root, agentId, "pane"));
        await mux.focusPane(cfg.tmuxSession, paneId);
      } else {
        for (const agent of cfg.agents) await pilotRequest(cfg, "/operator/pause", { agentId: agent.id });
      }
      const child = Bun.spawn(mux.attachArgs(cfg.tmuxSession), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await child.exited;
    } else if (command === "recover") {
      if (agentId) throw new Error("unexpected pilot argument");
      const recovery = acquireRecoveryLock(cfg.root);
      let launched = false;
      try {
        const record = processRecord(cfg.root, "coordinator");
        if (!record || !processVerifiedGone(record))
          throw new Error("coordinator is live, unknown, or has no recorded ownership; refusing recovery");
        removeDeadCoordinatorLock(cfg.root);
        detached(cfg, "coordinator");
        launched = true;
        await waitFor(
          () => coordinatorPublished(cfg.root),
          "coordinator recovery is uncertain; retain recovery.lock and inspect the recorded processes",
        );
        releaseRecoveryLock(cfg.root, recovery);
      } catch (error) {
        if (!launched) releaseRecoveryLock(cfg.root, recovery);
        throw error;
      }
      await pilotRequest(cfg, "/operator/connect", {});
      console.log(
        "Coordinator recovered. Uncertain sends remain held; reconfirm each native TUI before resuming.",
      );
    } else if (command === "stop") {
      if (agentId) throw new Error("unexpected pilot argument");
      await stopPilot(cfg);
      console.log("Pilot stopped; state and receipts retained.");
    }
    return 0;
  } catch (error) {
    console.error(`bridge pilot: ${error instanceof Error ? error.message : "operation failed"}`);
    return 1;
  }
}
