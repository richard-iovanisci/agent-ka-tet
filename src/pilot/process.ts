import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  agentFile,
  bridgeToolNames,
  loadPilot,
  pilotFile,
  readPrivateJson,
  sourceFile,
  writePrivateJson,
  type PilotEndpoint,
} from "./config.ts";
import { recordProcess } from "./processState.ts";
import { startPilotServer } from "./server.ts";
import { implementerPrompt } from "../run/prompts.ts";
import { claudeLaunchControls, codexHostLaunchControls, type NativeLaunchRecord } from "../run/launch.ts";

export async function runProcess(
  role: string,
  root: string,
  agentId?: string,
  waitForPane = false,
): Promise<number> {
  if (waitForPane && role !== "agent") throw new Error("pane startup barrier requires an agent");
  const cfg = loadPilot(root);
  if (role === "coordinator") {
    const endpointFile = pilotFile(root, "endpoint.json");
    const previous = existsSync(endpointFile) ? readPrivateJson<PilotEndpoint>(endpointFile) : null;
    const server = startPilotServer(cfg, { port: previous?.port ?? 0 });
    console.log(`pilot coordinator listening on 127.0.0.1:${server.endpoint.port}`);
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await server.stop();
        resolve();
      };
      process.once("SIGINT", () => {
        void stop();
      });
      process.once("SIGTERM", () => {
        void stop();
      });
    });
    return 0;
  }
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(root, "endpoint.json"));
  const agent = cfg.agents.find((a) => a.id === (role === "codex-host" ? "codex" : agentId));
  if (!agent || !["codex-host", "agent"].includes(role)) throw new Error("invalid pilot process role");
  const processRole = role === "agent" ? agent.id : role;
  let env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    AGENT_BRIDGE_URL: `http://127.0.0.1:${endpoint.port}`,
    AGENT_BRIDGE_TOKEN: agent.token,
  };
  const launch = cfg.version === 2 ? cfg.launch : undefined;
  if (cfg.version === 2 && !launch) throw new Error("missing native launch settings");
  let launchRecord: Omit<NativeLaunchRecord, "recordedAt"> | undefined;
  let command: string, args: string[];
  if (role === "codex-host") {
    const controls = launch ? codexHostLaunchControls(launch.codex) : undefined;
    if (controls)
      launchRecord = {
        version: 1,
        runtimeId: agent.runtimeId,
        role: "codex-host",
        configured: controls.configured,
        environment: controls.environment,
      };
    command = "codex";
    args = [
      ...(controls?.args ?? []),
      "-c",
      `mcp_servers.agent_bridge.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.agent_bridge.args=${JSON.stringify([sourceFile("../native/mcp.ts")])}`,
      "-c",
      `mcp_servers.agent_bridge.env_vars=${JSON.stringify(["AGENT_BRIDGE_URL", "AGENT_BRIDGE_TOKEN"])}`,
      ...(cfg.task
        ? [
            "-c",
            `mcp_servers.agent_bridge.enabled_tools=${JSON.stringify(bridgeToolNames(cfg))}`,
            ...bridgeToolNames(cfg).flatMap((name) => [
              "-c",
              `mcp_servers.agent_bridge.tools.${name}.approval_mode="approve"`,
            ]),
          ]
        : []),
      "app-server",
      "--listen",
      `unix://${cfg.socketPath}`,
    ];
  } else if (agent.kind === "codex") {
    const { threadId } = readPrivateJson<{ threadId: string }>(agentFile(root, agent.id, "thread"));
    command = "codex";
    args = ["resume", threadId, "--remote", `unix://${cfg.socketPath}`, "--cd", agent.workspace];
  } else {
    const controls = launch ? claudeLaunchControls(launch.claude, env) : undefined;
    if (controls) {
      env = controls.env;
      launchRecord = {
        version: 1,
        runtimeId: agent.runtimeId,
        role: "claude",
        configured: controls.configured,
        environment: controls.environment,
      };
    }
    command = "claude";
    env.MCP_PROTOCOL_NEGOTIATION = "legacy";
    args = [
      "--session-id",
      agent.sessionId!,
      "--name",
      `${cfg.tmuxSession}-claude`,
      "--settings",
      pilotFile(root, "claude.settings.json"),
      "--mcp-config",
      pilotFile(root, "claude.mcp.json"),
      "--strict-mcp-config",
      ...(controls?.args ?? (cfg.task ? ["--permission-mode", "default"] : [])),
      "--dangerously-load-development-channels",
      "server:agent-bridge",
      "--append-system-prompt",
      cfg.task
        ? implementerPrompt(cfg)
        : `The operator approved the Agent Bridge nonce pilot ${cfg.id}. For a Bridge Channel notification, read the message with bridge_read_message and acknowledge it with bridge_ack_message. If the peer body is exactly PING ${cfg.id}, reply to codex with exactly PONG ${cfg.id}, idempotencyKey ${cfg.id}:pong, and replyTo the incoming message ID. Use only Bridge MCP tools; do not edit files, run commands, or send further replies. Keep the native permission controls.`,
    ];
  }
  if (waitForPane) {
    const path = agentFile(root, agent.id, "pane");
    const deadline = Date.now() + 15_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline)
        throw new Error("pane ownership was not published; native process not started");
      await Bun.sleep(25);
    }
    const pane = readPrivateJson<{ paneId: string; wrapperPid: number }>(path);
    if (!/^%\d+$/.test(pane.paneId) || pane.wrapperPid !== process.pid)
      throw new Error("pane ownership does not match this wrapper; native process not started");
  }
  if (launchRecord)
    writePrivateJson(agentFile(root, agent.id, "launch"), {
      ...launchRecord,
      recordedAt: Date.now(),
    });
  recordProcess(root, processRole);
  const child = spawn(command, args, {
    cwd: agent.workspace,
    env,
    stdio: "inherit",
  });
  if (child.pid !== undefined) recordProcess(root, processRole, child.pid);
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onInt = () => forward("SIGINT"),
    onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const result = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  recordProcess(root, processRole, child.pid, true);
  return result;
}

if (import.meta.main) {
  const [role, root, agentId, option, ...extra] = process.argv.slice(2);
  try {
    if (!role || !root) throw new Error("pilot process requires role and directory");
    if (extra.length || (option !== undefined && option !== "--wait-for-pane"))
      throw new Error("unexpected pilot process argument");
    process.exitCode = await runProcess(role, root, agentId, option === "--wait-for-pane");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "pilot process failed");
    process.exitCode = 1;
  }
}
