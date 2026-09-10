import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter } from "../mux/tmux.ts";
import {
  agentFile,
  pilotFile,
  preparePilot,
  readPrivateJson,
  shellQuote,
  sourceFile,
  writePrivateJson,
} from "./config.ts";
import { launchNativePanes } from "./panes.ts";
import { processAlive, processBirth, processRecord, processVerifiedGone } from "./processState.ts";

interface Launch {
  name: "claude" | "codex";
  pid: number;
  parentPid: number;
  cwd: string;
  argv: string[];
}

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(25);
  }
}

test("native panes start exact wrappers once without invoking shell startup or pasting a launcher", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bridge-native-panes-test-")));
  const cfg = preparePilot(join(directory, "pilot with spaces"));
  const bin = join(directory, "fake binaries");
  const zdot = join(directory, "hostile shell startup");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(zdot, { mode: 0o700 });
  const marker = join(directory, "shell-started.txt");
  const capture = join(directory, "native-starts.jsonl");
  const fake = join(bin, "native fixture.ts");
  writeFileSync(
    join(zdot, ".zshrc"),
    `printf '%s\\n' shell-started > ${shellQuote(marker)}\nPS1='HOSTILE_STARTUP_PROMPT_WITHOUT_READY_SUFFIX '\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    fake,
    [
      'import { appendFileSync } from "node:fs";',
      "const name = process.argv[2];",
      'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => process.exit(0));',
      "appendFileSync(process.env.FIXTURE_CAPTURE!, JSON.stringify({",
      "  name, pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), argv: process.argv.slice(3),",
      '}) + "\\n", { mode: 0o600 });',
      'process.stdout.write("FAKE_NATIVE_READY " + name + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o600 },
  );
  for (const name of ["claude", "codex"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fake)} ${name} "$@"\n`,
      { mode: 0o700 },
    );
  }
  const threadId = "11111111-1111-4111-8111-111111111111";
  writePrivateJson(pilotFile(cfg.root, "endpoint.json"), {
    pid: process.pid,
    born: "unused-fixture-endpoint",
    port: 1,
    instance: "unused-fixture-instance",
  });
  writePrivateJson(agentFile(cfg.root, "codex", "thread"), { threadId });
  const environment = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    SHELL: "/bin/zsh",
    ZDOTDIR: zdot,
    FIXTURE_CAPTURE: capture,
  };
  const mux = new TmuxAdapter({
    socketName: cfg.tmuxSocket,
    configFile: "/dev/null",
    environment,
  });
  const paste = spyOn(mux, "sendText");
  const shellReady = spyOn(mux, "waitForShellReady");
  const launches = (): Launch[] =>
    existsSync(capture)
      ? readFileSync(capture, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    const wrongPane = agentFile(cfg.root, "claude", "pane");
    writePrivateJson(wrongPane, { paneId: "%123", wrapperPid: process.pid });
    const rejected = Bun.spawn(
      [process.execPath, sourceFile("process.ts"), "agent", cfg.root, "claude", "--wait-for-pane"],
      {
        cwd: cfg.root,
        env: { ...process.env, ...environment },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const born = processBirth(rejected.pid);
    try {
      await until(() => rejected.exitCode !== null, "mismatched wrapper ownership was not rejected");
      expect(await rejected.exited).toBe(1);
      expect(await new Response(rejected.stderr).text()).toContain(
        "pane ownership does not match this wrapper",
      );
      expect(launches()).toEqual([]);
      expect(processRecord(cfg.root, "claude")).toBeNull();
    } finally {
      if (born && processAlive({ pid: rejected.pid, born, role: "fixture-gate" })) rejected.kill("SIGTERM");
      await rejected.exited;
    }
    rmSync(wrongPane);
    expect(await mux.hasSession(cfg.tmuxSession)).toBe(false);
    await launchNativePanes(cfg, mux);
    await until(() => launches().length === 2, "both fake native children did not start exactly once");
    const panes = await mux.listPanes(cfg.tmuxSession);
    expect(panes).toHaveLength(2);
    expect(await mux.getSessionMarker(cfg.tmuxSession)).toBe(`native-pilot:${cfg.id}`);
    expect(paste).not.toHaveBeenCalled();
    expect(shellReady).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    for (const agent of cfg.agents) {
      const starts = launches().filter((launch) => launch.name === agent.id);
      expect(starts).toHaveLength(1);
      const start = starts[0]!;
      expect(start.cwd).toBe(agent.workspace);
      const path = agentFile(cfg.root, agent.id, "pane");
      const saved = readPrivateJson<{ paneId: string; wrapperPid: number }>(path);
      const pane = panes.find((candidate) => candidate.agentId === agent.id)!;
      expect(saved).toEqual({ paneId: pane.id, wrapperPid: pane.pid });
      expect(pane.title).toBe(agent.id);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      const record = processRecord(cfg.root, agent.id)!;
      expect(record.pid).toBe(pane.pid);
      expect(record.pid).toBe(start.parentPid);
      expect(record.childPid).toBe(start.pid);
      expect(record.born).toBeString();
      expect(record.childBorn).toBeString();
      expect(processAlive(record)).toBe(true);
      expect(processAlive(record, true)).toBe(true);
      await until(
        async () => (await mux.capturePane(pane.id)).includes(`FAKE_NATIVE_READY ${agent.id}`),
        `${agent.id} fixture output was not visible`,
      );
      const screen = await mux.capturePane(pane.id);
      expect(screen).toContain(`FAKE_NATIVE_READY ${agent.id}`);
      expect(screen).not.toContain("process.ts");
      expect(screen).not.toContain("HOSTILE_STARTUP_PROMPT");
      if (agent.id === "codex") {
        expect(start.argv).toEqual([
          "resume",
          threadId,
          "--remote",
          `unix://${cfg.socketPath}`,
          "--cd",
          agent.workspace,
        ]);
      } else {
        const value = (flag: string) => start.argv[start.argv.indexOf(flag) + 1];
        expect(value("--session-id")).toBe(agent.sessionId!);
        expect(value("--name")).toBe(`${cfg.tmuxSession}-claude`);
        expect(value("--settings")).toBe(pilotFile(cfg.root, "claude.settings.json"));
        expect(value("--mcp-config")).toBe(pilotFile(cfg.root, "claude.mcp.json"));
        expect(value("--dangerously-load-development-channels")).toBe("server:agent-bridge");
        expect(start.argv).toContain("--strict-mcp-config");
        expect(start.argv).not.toContain("--wait-for-pane");
      }
    }
    expect(
      launches()
        .map((launch) => launch.name)
        .sort(),
    ).toEqual(["claude", "codex"]);
    expect(existsSync(pilotFile(cfg.root, "coordinator.process.json"))).toBe(false);
    expect(existsSync(pilotFile(cfg.root, "codex-host.process.json"))).toBe(false);
  } finally {
    paste.mockRestore();
    shellReady.mockRestore();
    const records = cfg.agents.map((agent) => processRecord(cfg.root, agent.id));
    for (const record of records) {
      if (processAlive(record)) process.kill(record!.pid, "SIGTERM");
      else if (processAlive(record, true)) process.kill(record!.childPid!, "SIGTERM");
    }
    if (await mux.hasSession(cfg.tmuxSession)) {
      if ((await mux.getSessionMarker(cfg.tmuxSession)) !== `native-pilot:${cfg.id}`)
        throw new Error("fixture tmux ownership changed; retaining its state");
      await mux.killSession(cfg.tmuxSession);
    }
    await until(
      () => records.every((record) => processVerifiedGone(record) && processVerifiedGone(record, true)),
      "owned fake native processes did not exit; retaining fixture state",
    );
    rmSync(cfg.socketDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
