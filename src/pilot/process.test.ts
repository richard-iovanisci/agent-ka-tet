import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentFile,
  pilotFile,
  preparePilot,
  readPrivateJson,
  shellQuote,
  sourceFile,
  writePrivateJson,
  type PilotEndpoint,
} from "./config.ts";
import { coordinatorPublished, processAlive, processRecord, processVerifiedGone } from "./processState.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
const TASK_TOOLS = [
  "bridge_send_message",
  "bridge_read_message",
  "bridge_ack_message",
  "bridge_list_agents",
  "bridge_inbox",
  "bridge_task_read",
  "bridge_task_claim",
  "bridge_task_submit",
  "bridge_task_review",
];
type Capture = {
  pid: number;
  cwd: string;
  argv: string[];
  credentialMatches: boolean;
  endpointMatches: boolean;
  negotiation?: string;
  gitEnvironment: string[];
  gitWorkspace: string | null;
};

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(15);
  }
}

async function fixture(taskMode = false) {
  let source: string | undefined;
  if (taskMode) {
    source = realpathSync(mkdtempSync(join(tmpdir(), "bridge-process-source-")));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
        {
          cwd: source,
          env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "--quiet", "--template=", "--initial-branch=main");
    writeFileSync(join(source, "artifact.txt"), "committed fixture\n");
    git("add", "artifact.txt");
    git(
      "-c",
      "user.name=Bridge fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture source",
    );
  }
  let cfg;
  try {
    cfg = preparePilot(
      undefined,
      source ? { project: source, brief: "Implement and review the fixture task." } : undefined,
    );
  } catch (error) {
    if (source) rmSync(source, { recursive: true, force: true });
    throw error;
  }
  const bin = join(cfg.root, "fake binaries");
  mkdirSync(bin, { mode: 0o700 });
  const fake = join(bin, "native fixture.ts");
  writeFileSync(
    fake,
    [
      'import { writeFileSync } from "node:fs";',
      "const capture = process.env.FIXTURE_CAPTURE!;",
      "const signals: string[] = [];",
      "const exitAfterSignals = Number(process.env.FIXTURE_EXIT_AFTER_SIGNALS);",
      'for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {',
      "  signals.push(signal);",
      '  writeFileSync(capture + ".signal", signals.join("\\n"), { mode: 0o600 });',
      "  if (signals.length >= exitAfterSignals) process.exit(0);",
      "});",
      'const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });',
      "writeFileSync(capture, JSON.stringify({",
      "  pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2),",
      "  credentialMatches: process.env.AGENT_BRIDGE_TOKEN === process.env.FIXTURE_EXPECTED_TOKEN,",
      "  endpointMatches: process.env.AGENT_BRIDGE_URL === process.env.FIXTURE_EXPECTED_URL,",
      "  negotiation: process.env.MCP_PROTOCOL_NEGOTIATION,",
      '  gitEnvironment: Object.keys(process.env).filter((key) => key.startsWith("GIT_")),',
      "  gitWorkspace: git.exitCode === 0 ? git.stdout.toString().trim() : null,",
      "}), { mode: 0o600 });",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o600 },
  );
  for (const executable of ["claude", "codex"]) {
    writeFileSync(
      join(bin, executable),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fake)} "$@"\n`,
      { mode: 0o700 },
    );
  }
  const children: Bun.Subprocess[] = [];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  const coordinator = Bun.spawn([process.execPath, sourceFile("process.ts"), "coordinator", cfg.root], {
    cwd: cfg.root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(coordinator);
  try {
    await until(() => coordinatorPublished(cfg.root), "fixture coordinator did not publish ownership");
  } catch (error) {
    coordinator.kill("SIGTERM");
    await coordinator.exited;
    rmSync(cfg.socketDir, { recursive: true, force: true });
    rmSync(cfg.root, { recursive: true, force: true });
    if (source) rmSync(source, { recursive: true, force: true });
    throw error;
  }
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(cfg.root, "endpoint.json"));
  writePrivateJson(agentFile(cfg.root, "codex", "thread"), { threadId: THREAD });
  return {
    cfg,
    endpoint,
    coordinator,
    async start(
      role: "codex-host" | "claude" | "codex",
      exitAfterSignals = 1,
      inheritedEnv: Record<string, string> = {},
    ) {
      const agentId = role === "codex-host" ? "codex" : role;
      const agent = cfg.agents.find((candidate) => candidate.id === agentId)!;
      const capturePath = join(cfg.root, `${role}.fixture.json`);
      const args = [
        process.execPath,
        sourceFile("process.ts"),
        role === "codex-host" ? role : "agent",
        cfg.root,
      ];
      if (role !== "codex-host") args.push(agentId);
      const wrapper = Bun.spawn(args, {
        cwd: cfg.root,
        env: {
          ...env,
          ...inheritedEnv,
          AGENT_BRIDGE_TOKEN: "incorrect-inherited-fixture-token",
          AGENT_BRIDGE_URL: "http://127.0.0.1:1",
          MCP_PROTOCOL_NEGOTIATION: "auto",
          FIXTURE_CAPTURE: capturePath,
          FIXTURE_EXIT_AFTER_SIGNALS: String(exitAfterSignals),
          FIXTURE_EXPECTED_TOKEN: agent.token,
          FIXTURE_EXPECTED_URL: `http://127.0.0.1:${endpoint.port}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(wrapper);
      await until(
        () => existsSync(capturePath) && processAlive(processRecord(cfg.root, role), true),
        "fake native child did not publish ownership",
      );
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as Capture;
      return { wrapper, capture, capturePath, record: processRecord(cfg.root, role)! };
    },
    async close() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      for (const role of ["claude", "codex", "codex-host"]) {
        const record = processRecord(cfg.root, role);
        if (processAlive(record, true)) {
          await until(
            () => existsSync(join(cfg.root, `${role}.fixture.json.signal`)) || !processAlive(record, true),
            "fake native child did not observe teardown signal",
          );
        }
        if (processAlive(record, true)) process.kill(record!.childPid!, "SIGTERM");
      }
      await Promise.all(children.map((child) => child.exited));
      rmSync(cfg.socketDir, { recursive: true, force: true });
      rmSync(cfg.root, { recursive: true, force: true });
      if (source) rmSync(source, { recursive: true, force: true });
    },
  };
}

describe("pilot wrappers with isolated fake native executables", () => {
  test("removes inherited Git routing from every native child while preserving scoped Bridge credentials", async () => {
    const host = await fixture(true);
    try {
      const source = host.cfg.task!.sourceRepo;
      const index = readFileSync(join(source, ".git", "index"));
      const inheritedEnv = {
        GIT_DIR: join(source, ".git"),
        GIT_WORK_TREE: source,
        GIT_INDEX_FILE: join(source, ".git", "index"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: source,
        GIT_TERMINAL_PROMPT: "0",
      };
      for (const role of ["codex-host", "claude", "codex"] as const) {
        const native = await host.start(role, 1, inheritedEnv);
        const agentId = role === "codex-host" ? "codex" : role;
        expect(native.capture.gitEnvironment).toEqual([]);
        expect(native.capture.gitWorkspace).toBe(
          host.cfg.agents.find((agent) => agent.id === agentId)!.workspace,
        );
        expect(native.capture.credentialMatches).toBe(true);
        expect(native.capture.endpointMatches).toBe(true);
      }
      expect(readFileSync(join(source, ".git", "index"))).toEqual(index);
      expect(readFileSync(join(source, "artifact.txt"), "utf8")).toBe("committed fixture\n");
    } finally {
      await host.close();
    }
  }, 10_000);

  test.each(["SIGTERM", "SIGINT"] as const)(
    "forwards repeated %s while retaining the owned native child until it exits",
    async (signal) => {
      const host = await fixture();
      try {
        const native = await host.start("codex-host", 2);
        native.wrapper.kill(signal);
        await until(
          () => existsSync(native.capturePath + ".signal"),
          "fake native child did not observe its first signal",
        );
        expect(readFileSync(native.capturePath + ".signal", "utf8")).toBe(signal);
        expect(processAlive(native.record)).toBe(true);
        expect(processAlive(native.record, true)).toBe(true);
        expect(processRecord(host.cfg.root, "codex-host")?.exited).toBe(false);
        native.wrapper.kill(signal);
        expect(await native.wrapper.exited).toBe(0);
        expect(readFileSync(native.capturePath + ".signal", "utf8")).toBe(`${signal}\n${signal}`);
        expect(processVerifiedGone(native.record)).toBe(true);
        expect(processVerifiedGone(native.record, true)).toBe(true);
        expect(processRecord(host.cfg.root, "codex-host")?.exited).toBe(true);
      } finally {
        await host.close();
      }
    },
    10_000,
  );

  test("passes only the bound Codex UUID and private endpoint to the native TUI", async () => {
    const host = await fixture();
    try {
      const native = await host.start("codex");
      expect(native.capture.argv).toEqual([
        "resume",
        THREAD,
        "--remote",
        `unix://${host.cfg.socketPath}`,
        "--cd",
        host.cfg.agents[1]!.workspace,
      ]);
      expect(native.capture.credentialMatches).toBe(true);
      expect(native.capture.endpointMatches).toBe(true);
      expect(native.record.pid).toBe(native.wrapper.pid);
      expect(native.record.childPid).toBe(native.capture.pid);
      expect(native.record.childBorn).toBeString();
      native.wrapper.kill("SIGTERM");
      expect(await native.wrapper.exited).toBe(0);
      expect(readFileSync(native.capturePath + ".signal", "utf8")).toBe("SIGTERM");
      expect(processVerifiedGone(native.record)).toBe(true);
      expect(processVerifiedGone(native.record, true)).toBe(true);
    } finally {
      await host.close();
    }
  }, 10_000);

  test("gives Claude its exact disposable session, development Channel, credentials, and legacy negotiation", async () => {
    const host = await fixture();
    try {
      const native = await host.start("claude");
      const argv = native.capture.argv;
      const value = (flag: string) => argv[argv.indexOf(flag) + 1];
      expect(value("--session-id")).toBe(host.cfg.agents[0]!.sessionId!);
      expect(value("--settings")).toBe(pilotFile(host.cfg.root, "claude.settings.json"));
      expect(value("--mcp-config")).toBe(pilotFile(host.cfg.root, "claude.mcp.json"));
      expect(value("--dangerously-load-development-channels")).toBe("server:agent-bridge");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).not.toContain("--print");
      expect(argv).not.toContain("-p");
      expect(argv).not.toContain("--permission-mode");
      expect(value("--append-system-prompt")).toContain(`PING ${host.cfg.id}`);
      expect(value("--append-system-prompt")).not.toContain("bridge_task_");
      expect(native.capture.negotiation).toBe("legacy");
      expect(native.capture.credentialMatches).toBe(true);
      expect(native.capture.endpointMatches).toBe(true);
    } finally {
      await host.close();
    }
  }, 10_000);

  test("the independently owned Codex host survives coordinator stop and its wrapper forwards termination", async () => {
    const host = await fixture();
    try {
      const native = await host.start("codex-host");
      const argv = native.capture.argv;
      expect(argv).toEqual([
        "-c",
        `mcp_servers.agent_bridge.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.agent_bridge.args=${JSON.stringify([sourceFile("../native/mcp.ts")])}`,
        "-c",
        'mcp_servers.agent_bridge.env_vars=["AGENT_BRIDGE_URL","AGENT_BRIDGE_TOKEN"]',
        "app-server",
        "--listen",
        `unix://${host.cfg.socketPath}`,
      ]);
      expect(native.capture.credentialMatches).toBe(true);
      expect(native.capture.endpointMatches).toBe(true);
      host.coordinator.kill("SIGTERM");
      expect(await host.coordinator.exited).toBe(0);
      expect(processAlive(native.record)).toBe(true);
      expect(processAlive(native.record, true)).toBe(true);
      expect(existsSync(native.capturePath + ".signal")).toBe(false);
      expect(existsSync(pilotFile(host.cfg.root, "coordinator.lock"))).toBe(false);
      native.wrapper.kill("SIGTERM");
      expect(await native.wrapper.exited).toBe(0);
      expect(readFileSync(native.capturePath + ".signal", "utf8")).toBe("SIGTERM");
      expect(processVerifiedGone(native.record)).toBe(true);
      expect(processVerifiedGone(native.record, true)).toBe(true);
    } finally {
      await host.close();
    }
  }, 10_000);

  test("task host approves exactly nine Bridge tools and leaves native shell and file policy intact", async () => {
    const host = await fixture(true);
    try {
      const native = await host.start("codex-host");
      expect(native.capture.argv).toEqual([
        "-c",
        `mcp_servers.agent_bridge.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.agent_bridge.args=${JSON.stringify([sourceFile("../native/mcp.ts")])}`,
        "-c",
        'mcp_servers.agent_bridge.env_vars=["AGENT_BRIDGE_URL","AGENT_BRIDGE_TOKEN"]',
        "-c",
        `mcp_servers.agent_bridge.enabled_tools=${JSON.stringify(TASK_TOOLS)}`,
        ...TASK_TOOLS.flatMap((name) => [
          "-c",
          `mcp_servers.agent_bridge.tools.${name}.approval_mode="approve"`,
        ]),
        "app-server",
        "--listen",
        `unix://${host.cfg.socketPath}`,
      ]);
      expect(native.capture.cwd).toBe(host.cfg.agents[1]!.workspace);
      expect(native.capture.credentialMatches).toBe(true);
      expect(native.capture.endpointMatches).toBe(true);
      expect(native.capture.argv.join(" ")).not.toMatch(
        /approval_policy|sandbox_mode|dangerously-bypass|yolo/,
      );
    } finally {
      await host.close();
    }
  }, 10_000);

  test("task Claude uses its exact native session with default permissions and implementer instructions", async () => {
    const host = await fixture(true);
    try {
      const native = await host.start("claude");
      const argv = native.capture.argv;
      expect(argv.slice(0, -1)).toEqual([
        "--session-id",
        host.cfg.agents[0]!.sessionId!,
        "--name",
        `${host.cfg.tmuxSession}-claude`,
        "--settings",
        pilotFile(host.cfg.root, "claude.settings.json"),
        "--mcp-config",
        pilotFile(host.cfg.root, "claude.mcp.json"),
        "--strict-mcp-config",
        "--permission-mode",
        "default",
        "--dangerously-load-development-channels",
        "server:agent-bridge",
        "--append-system-prompt",
      ]);
      const prompt = argv.at(-1)!;
      expect(prompt).toContain(
        `Claude implementer in the operator-authorized Agent Bridge run ${host.cfg.id}`,
      );
      for (const tool of ["bridge_task_read", "bridge_task_claim", "bridge_task_submit"])
        expect(prompt).toContain(tool);
      expect(prompt).toContain("only in your assigned worktree");
      expect(prompt).toContain("Keep native shell/file approvals");
      expect(prompt).not.toContain(`PING ${host.cfg.id}`);
      expect(native.capture.cwd).toBe(host.cfg.agents[0]!.workspace);
      expect(native.capture.negotiation).toBe("legacy");
      expect(native.capture.credentialMatches).toBe(true);
      expect(native.capture.endpointMatches).toBe(true);
    } finally {
      await host.close();
    }
  }, 10_000);
});
