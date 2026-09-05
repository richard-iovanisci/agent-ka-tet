import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type Capture = {
  pid: number;
  argv: string[];
  credentialMatches: boolean;
  endpointMatches: boolean;
  negotiation?: string;
};

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(15);
  }
}

async function fixture() {
  const cfg = preparePilot();
  const bin = join(cfg.root, "fake binaries");
  mkdirSync(bin, { mode: 0o700 });
  const fake = join(bin, "native fixture.ts");
  writeFileSync(
    fake,
    [
      'import { writeFileSync } from "node:fs";',
      "const capture = process.env.FIXTURE_CAPTURE!;",
      "writeFileSync(capture, JSON.stringify({",
      "  pid: process.pid, argv: process.argv.slice(2),",
      "  credentialMatches: process.env.AGENT_BRIDGE_TOKEN === process.env.FIXTURE_EXPECTED_TOKEN,",
      "  endpointMatches: process.env.AGENT_BRIDGE_URL === process.env.FIXTURE_EXPECTED_URL,",
      "  negotiation: process.env.MCP_PROTOCOL_NEGOTIATION,",
      "}), { mode: 0o600 });",
      'process.on("SIGTERM", () => { writeFileSync(capture + ".signal", "SIGTERM", { mode: 0o600 }); process.exit(0); });',
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
    throw error;
  }
  const endpoint = readPrivateJson<PilotEndpoint>(pilotFile(cfg.root, "endpoint.json"));
  writePrivateJson(agentFile(cfg.root, "codex", "thread"), { threadId: THREAD });
  return {
    cfg,
    endpoint,
    coordinator,
    async start(role: "codex-host" | "claude" | "codex") {
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
          AGENT_BRIDGE_TOKEN: "incorrect-inherited-fixture-token",
          AGENT_BRIDGE_URL: "http://127.0.0.1:1",
          MCP_PROTOCOL_NEGOTIATION: "auto",
          FIXTURE_CAPTURE: capturePath,
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
      await Promise.all(children.map((child) => child.exited));
      for (const role of ["claude", "codex", "codex-host"]) {
        const record = processRecord(cfg.root, role);
        if (processAlive(record, true)) process.kill(record!.childPid!, "SIGTERM");
      }
      rmSync(cfg.socketDir, { recursive: true, force: true });
      rmSync(cfg.root, { recursive: true, force: true });
    },
  };
}

describe("pilot wrappers with isolated fake native executables", () => {
  test("passes only the bound Codex UUID and private endpoint to the native TUI", async () => {
    const host = await fixture();
    try {
      const native = await host.start("codex");
      expect(native.capture.argv).toEqual(["resume", THREAD, "--remote", `unix://${host.cfg.socketPath}`]);
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
      expect(argv.slice(-3)).toEqual(["app-server", "--listen", `unix://${host.cfg.socketPath}`]);
      expect(argv).toContain(`mcp_servers.agent_bridge.command=${JSON.stringify(process.execPath)}`);
      expect(argv).toContain(
        `mcp_servers.agent_bridge.args=${JSON.stringify([sourceFile("../native/mcp.ts")])}`,
      );
      expect(argv).toContain('mcp_servers.agent_bridge.env_vars=["AGENT_BRIDGE_URL","AGENT_BRIDGE_TOKEN"]');
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
});
