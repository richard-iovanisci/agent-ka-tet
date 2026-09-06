import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderConsole,
  runConsoleSession,
  terminalText,
  type ConsoleOptions,
  type ConsoleStatus,
} from "./console.ts";
import {
  agentFile,
  pilotFile,
  preparePilot,
  shellQuote,
  sourceFile,
  writePrivateJson,
  type PilotConfig,
  type PilotEndpoint,
} from "../pilot/config.ts";
import { processBirth, recordProcess } from "../pilot/processState.ts";
import type { MessageRecord } from "../coordination/types.ts";

const cfg = {
  root: "/disposable/run",
  operatorToken: "operator-private-token",
  agents: [
    { id: "claude", token: "claude-private-token" },
    { id: "codex", token: "codex-private-token" },
  ],
} as PilotConfig;

function status(): ConsoleStatus {
  return {
    run: { id: "run-one", paused: false },
    startIntent: null,
    agents: ["claude", "codex"].map((agentId) => ({
      agentId,
      sessionId: `${agentId}-session`,
      ready: true,
      paused: false,
      revoked: false,
      exited: false,
    })),
    tasks: [
      {
        id: "task-one",
        title: "Review change",
        state: "review",
        version: 3,
        artifact: { commit: "abc1234", summary: "Artifact is ready" },
        reviewSummary: "Needs one fix",
      },
    ],
    messages: [
      {
        message: { senderAgentId: "codex", recipientAgentId: "claude", body: "Review the artifact" },
        receipt: { policy: "ready", state: "written", application: "unread" },
      } as MessageRecord,
    ],
  };
}

class Input extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  modes: boolean[] = [];
  isPaused() {
    return this.paused;
  }
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.modes.push(mode);
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  key(value: string) {
    this.emit("data", Buffer.from(value));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("console fixture did not settle");
    await Bun.sleep(5);
  }
}

function fixture(overrides: Partial<ConsoleOptions> = {}) {
  const input = new Input();
  const signals = new EventEmitter();
  const writes: string[] = [];
  const calls: Array<{ path: string; body: unknown; signal?: AbortSignal }> = [];
  const options: ConsoleOptions = {
    input,
    output: {
      isTTY: true,
      columns: 120,
      rows: 30,
      write: (text) => {
        writes.push(text);
      },
    },
    signals: signals as unknown as ConsoleOptions["signals"],
    request: async (path, body, signal) => {
      calls.push({ path, body, signal });
      return status();
    },
    attach: async () => 0,
    intervalMs: 20,
    ...overrides,
  };
  return { input, signals, writes, calls, options };
}

describe("native run console", () => {
  test("renders separate delivery/application states and only sanitized public fields", () => {
    const value = status();
    const attack = "\x1b[2J\x1b]52;c;encoded-secret\x07\u009b31m\u202epeer\ntext\toperator-private-token";
    value.tasks![0]!.title = attack;
    value.tasks![0]!.artifact!.summary = "claude-private-token";
    value.agents[0]!.activity = { summary: "working\x1b[1G" };
    value.agents[0]!.attention = { kind: "permission\u202e" };
    value.messages[0]!.message.body = attack;
    const withPrivateFields = {
      ...value,
      endpoint: { token: "never-render-this" },
      observations: [{ data: "raw-native-delta" }],
    };
    const output = renderConsole(withPrivateFields, 1, {
      width: 160,
      height: 40,
      secrets: [cfg.operatorToken, cfg.agents[0]!.token],
      notice: "notice\x1b[?25l",
    });
    expect(output).toContain("ready:written / unread");
    expect(output).toContain("> codex");
    expect(output).toContain("review v3");
    expect(output).toContain("artifact abc1234");
    expect(output).toContain("review: Needs one fix");
    expect(output).toContain("attention: permission");
    expect(output).toContain("peer text [redacted]");
    expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
    for (const secret of [
      cfg.operatorToken,
      cfg.agents[0]!.token,
      "encoded-secret",
      "never-render-this",
      "raw-native-delta",
    ])
      expect(output).not.toContain(secret);
    expect(terminalText({ token: "private" })).toBe("");
  });

  test("summarizes valid task notices without changing delivery or application receipts", () => {
    const value = status();
    for (const [state, version, reviewSummary, expected] of [
      ["review", 3, null, "Task ready for review v3 | commit abcdef01 | Implementation checked"],
      ["accepted", 4, "Review passed", "Task accepted v4 | commit abcdef01 | Review passed"],
      ["changes_requested", 4, "Fix\\ncase", "Task changes requested v4 | commit abcdef01 | Fix\\ncase"],
    ] as const) {
      value.messages[0]!.message.body = JSON.stringify({
        type: "task_transition",
        taskId: "11111111-1111-4111-8111-111111111111",
        state,
        version,
        artifact: { commit: "abcdef01".repeat(5), summary: "Implementation checked" },
        reviewSummary,
      });
      const rendered = renderConsole(value, 0, { width: 160 });
      expect(rendered).toContain(expected);
      expect(rendered).toContain("ready:written / unread");
      expect(rendered).not.toContain('"type":"task_transition"');
    }
    value.messages[0]!.message.body = JSON.stringify({
      type: "task_transition",
      taskId: "11111111-1111-4111-8111-111111111111",
      state: "accepted",
      version: 4,
      artifact: { commit: "abcdef01".repeat(5), summary: "Implementation checked" },
      reviewSummary: "Passed\x1b[2J\u202e operator-private-token\nreview",
    });
    const rendered = renderConsole(value, 0, { width: 160, secrets: [cfg.operatorToken] });
    expect(rendered).toContain("Passed [redacted] review");
    expect(rendered).not.toMatch(/[\x1b\u202e]/);
  });

  test("keeps ordinary and malformed task notices as text instead of hiding their fields", () => {
    const valid = {
      type: "task_transition",
      taskId: "11111111-1111-4111-8111-111111111111",
      state: "review",
      version: 3,
      artifact: { commit: "abcdef01".repeat(5), summary: "Checked" },
      reviewSummary: null,
    };
    const bodies = [
      "Ordinary peer text",
      "{broken JSON",
      "null",
      "[]",
      JSON.stringify({ question: "Review this?" }),
      ...[
        { ...valid, type: "other" },
        { ...valid, state: "working" },
        { ...valid, version: "3" },
        { ...valid, version: 1.5 },
        { ...valid, taskId: "not-a-task-id" },
        { ...valid, extra: "retain this" },
        { ...valid, artifact: null },
        { ...valid, artifact: { ...valid.artifact, commit: "abcdef01" } },
        { ...valid, artifact: { ...valid.artifact, extra: "retain this too" } },
        { ...valid, artifact: { ...valid.artifact, summary: "" } },
        { ...valid, reviewSummary: "unexpected review" },
        { ...valid, state: "accepted" },
        {
          type: "task_transition",
          taskId: valid.taskId,
          state: "review",
          version: 3,
          artifact: valid.artifact,
        },
      ].map((notice) => JSON.stringify(notice)),
    ];
    for (const body of bodies) {
      const value = status();
      value.messages[0]!.message.body = body;
      const rendered = renderConsole(value, 0, { width: 240 });
      expect(rendered).toContain(terminalText(body).slice(0, 100));
      expect(rendered).toContain("ready:written / unread");
      expect(rendered).not.toContain("Task ready for review v3");
    }
  });

  test("bounds long peer text and terminal dimensions without losing the action hint", () => {
    const value = status();
    value.tasks![0]!.title = "界🙂".repeat(5000);
    value.messages[0]!.message.body = "x".repeat(50_000);
    for (const [width, height] of [
      [1, 1],
      [12, 7],
      [80, 24],
      [5000, 5000],
    ]) {
      const rendered = renderConsole(value, 0, { width, height });
      const lines = rendered.split("\n");
      expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(100, height! - 1)));
      for (const line of lines) {
        const cells = Array.from(line).reduce((sum, char) => sum + (char.codePointAt(0)! > 126 ? 2 : 1), 0);
        expect(cells).toBeLessThanOrEqual(Math.max(1, Math.min(240, width! - 1)));
      }
    }
    const normal = renderConsole(value, 0, { width: 120, height: 24 });
    expect(normal).toContain("r resume: confirms native session and trust/tools are ready for peer input.");
    expect(normal).not.toContain("composer empty");
    expect(normal).toContain("q leaves sessions running.");
    const offline = renderConsole(value, 0, { connected: false });
    expect(offline).toContain("state unverified");
    expect(offline).toContain("route unknown");
    expect(offline).not.toContain("route ready");
  });

  test("shows exact expiry using server time without changing observed run or agent flags", () => {
    const expiresAt = Date.parse("2026-09-06T03:43:31.511Z");
    const value = status();
    value.run!.expiresAt = expiresAt;
    value.tasks![0]!.state = "accepted";
    value.agents[0]!.paused = true;
    value.agents[0]!.ready = false;
    value.serverNow = expiresAt - 1;
    const before = renderConsole(value, 0, { now: expiresAt + 60_000, width: 120 });
    expect(before).toContain("Run expires at 2026-09-06T03:43:31.511Z");
    expect(before).not.toContain("run expired");
    value.serverNow = expiresAt;
    const expired = renderConsole(value, 0, { now: expiresAt - 60_000, width: 120 });
    expect(expired).toContain("Run EXPIRED at 2026-09-06T03:43:31.511Z");
    expect(expired).toContain("Resume/start unavailable: run expired. Enter attaches; p pauses; q exits.");
    expect(expired).toContain("Agent Bridge | run-one | connected");
    expect(expired).not.toContain("run paused");
    expect(expired).toContain("claude | bound | route held | paused yes");
    expect(expired).toContain("codex | bound | route ready | paused no");
    expect(expired).toContain("accepted v3");
    expect(value.run!.paused).toBe(false);
    const offline = renderConsole(value, 0, { connected: false });
    expect(offline).toContain("state unverified");
    expect(offline).toContain("Run EXPIRED at 2026-09-06T03:43:31.511Z");
  });

  test("expiry display falls back to the supplied clock and tolerates missing or invalid timestamps", () => {
    const expiresAt = Date.parse("2026-09-06T03:43:31.511Z");
    const value = status();
    value.run!.expiresAt = expiresAt;
    expect(renderConsole(value, 0, { now: expiresAt - 1 })).toContain("Run expires at");
    expect(renderConsole(value, 0, { now: expiresAt })).toContain("Run EXPIRED at");
    value.serverNow = Number.NaN;
    expect(renderConsole(value, 0, { now: expiresAt })).toContain("Run EXPIRED at");
    for (const invalid of [undefined, Number.NaN, Infinity, 1e20]) {
      value.run!.expiresAt = invalid;
      const output = renderConsole(value, 0, { now: expiresAt });
      expect(output).not.toContain("Run EXPIRED");
      expect(output).not.toContain("Invalid Date");
    }
  });

  test("expired presentation keeps action authority on the server and preserves attach, pause and quit", async () => {
    const expiresAt = Date.parse("2026-09-06T03:43:31.511Z");
    const value = { ...status(), serverNow: expiresAt, run: { id: "expired-run", paused: false, expiresAt } };
    const calls: string[] = [], attached: string[] = [];
    const f = fixture({
      request: async (path) => {
        calls.push(path);
        if (path === "/operator/ready" || path === "/operator/start")
          throw new Error("run expired at 2026-09-06T03:43:31.511Z; prepare a new run for peer delivery");
        return value;
      },
      attach: async (agentId) => { attached.push(agentId); return 0; },
    });
    const running = runConsoleSession(cfg, f.options);
    try {
      await until(() => f.writes.some((text) => text.includes("Run EXPIRED")));
      f.input.key("r");
      await until(() => f.writes.some((text) => text.includes("Action not confirmed")));
      f.input.key("s");
      await until(() => calls.includes("/operator/start"));
      await Bun.sleep(5);
      f.input.key("p");
      await until(() => f.writes.some((text) => text.includes("claude paused.")));
      f.input.key("\r");
      await until(() => attached.length === 1 && f.input.isRaw);
      expect(calls).toContain("/operator/ready");
      expect(calls).toContain("/operator/pause");
      expect(attached).toEqual(["claude"]);
      expect(calls.some((path) => path.includes("stop"))).toBe(false);
    } finally { f.input.key("q"); expect(await running).toBe(0); }
  });

  test("shows persisted start receipts and refuses another start for every recorded state", async () => {
    expect(renderConsole(status(), 0)).toContain("Start: not submitted");
    for (const state of ["accepted", "ambiguous", "submitting"] as const) {
      const value = {
        ...status(),
        startIntent: { state, requestId: "request-one", turnId: "12345678-rest" },
      };
      const paths: string[] = [];
      const f = fixture({
        request: async (path) => {
          paths.push(path);
          return value;
        },
      });
      const running = runConsoleSession(cfg, f.options);
      try {
        await until(() =>
          f.writes.some((text) =>
            text.includes(state === "accepted" ? "Start: accepted | turn 12345678" : "Start: uncertain"),
          ),
        );
        f.input.key("s");
        expect(f.writes.at(-1)).toContain("Start already recorded; inspect existing start.");
        expect(paths).not.toContain("/operator/start");
        expect(renderConsole(value, 0, { connected: false })).toContain("state unverified");
      } finally {
        f.input.key("q");
        await running;
      }
    }
  });

  test("routes explicit keys to the selected agent and ignores pasted commands", async () => {
    const f = fixture();
    const running = runConsoleSession(cfg, f.options);
    try {
      await until(() => f.calls.length > 0);
      f.input.key("\x1b[200~" + "prs".repeat(300) + "\x1b[201~");
      f.input.key("\x1b[200~p");
      f.input.key("rs\x1b[20");
      f.input.key("1~");
      f.input.key("prs");
      f.input.key("\x1b[");
      f.input.key("B");
      f.input.key("p");
      await until(() => f.writes.some((text) => text.includes("codex paused.")));
      expect(f.calls.filter((call) => call.path !== "/operator/status")).toEqual([
        { path: "/operator/pause", body: { agentId: "codex" }, signal: expect.any(AbortSignal) },
      ]);
      f.input.key("r");
      await until(() => f.writes.some((text) => text.includes("codex native readiness confirmed.")));
      f.input.key("s");
      await until(() => f.writes.some((text) => text.includes("Task start accepted.")));
      expect(f.calls.find((call) => call.path === "/operator/ready")!.body).toEqual({
        agentId: "codex",
        confirmNative: true,
      });
      expect(f.calls.find((call) => call.path === "/operator/start")!.body).toEqual({});
      f.input.key("k");
      expect(f.writes.at(-1)).toContain("> claude");
    } finally {
      f.input.key("q");
      expect(await running).toBe(0);
    }
    expect(f.calls.some((call) => call.path.includes("stop"))).toBe(false);
    expect(f.input.isRaw).toBe(false);
    expect(f.input.paused).toBe(true);
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.writes.at(-1)).toContain("\x1b[?25h\x1b[?1049l");
  });

  test("suspends console input and polling around the existing native attach", async () => {
    const detached = deferred<number>();
    const attached: string[] = [];
    const f = fixture({
      attach: async (agentId) => {
        attached.push(agentId);
        expect(f.input.isRaw).toBe(false);
        expect(f.input.listenerCount("data")).toBe(0);
        expect(f.writes.at(-1)).toContain("\x1b[?1049l");
        return detached.promise;
      },
    });
    const running = runConsoleSession(cfg, f.options);
    try {
      await until(() => f.calls.length > 0);
      f.input.key("j");
      f.input.key("\r");
      await until(() => attached.length > 0);
      const count = f.calls.length;
      f.input.key("r");
      f.signals.emit("SIGINT");
      await Bun.sleep(70);
      expect(f.calls.length).toBe(count);
      expect(f.input.isRaw).toBe(false);
      expect(f.input.listenerCount("data")).toBe(0);
      expect(f.calls.some((call) => call.path === "/operator/pause")).toBe(false);
      detached.resolve(0);
      await until(() => f.input.isRaw && f.calls.length > count);
      expect(attached).toEqual(["codex"]);
      expect(f.writes.some((text) => text.includes("codex remains paused; r resumes peer input."))).toBe(
        true,
      );
      expect(f.calls.some((call) => call.path === "/operator/ready")).toBe(false);
    } finally {
      detached.resolve(0);
      await until(() => f.input.isRaw);
      f.input.key("q");
      await running;
    }
  });

  test("exit aborts an outstanding poll and restores prior raw/input state", async () => {
    let pending: AbortSignal | undefined;
    const f = fixture({
      request: async (_path, _body, signal) => {
        pending = signal;
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    });
    f.input.isRaw = true;
    f.input.paused = false;
    const running = runConsoleSession(cfg, f.options);
    await until(() => pending !== undefined);
    f.signals.emit("SIGTERM");
    expect(await running).toBe(143);
    expect(pending!.aborted).toBe(true);
    expect(f.input.isRaw).toBe(true);
    expect(f.input.paused).toBe(false);
    const count = f.writes.length;
    await Bun.sleep(60);
    expect(f.writes.length).toBe(count);
  });

  test("malformed status and attach failures leave the console usable", async () => {
    let reads = 0;
    const f = fixture({
      request: async () => (++reads === 1 ? { ...status(), messages: [null] } : status()),
      attach: async () => {
        throw new Error("attach failed");
      },
    });
    const running = runConsoleSession(cfg, f.options);
    try {
      await until(() => f.writes.some((text) => text.includes("Coordinator unavailable.")));
      await until(() => reads > 1 && f.writes.at(-1)!.includes("| connected"));
      expect(f.writes.at(-1)).not.toContain("Coordinator unavailable.");
      f.input.key("\r");
      await until(() => f.input.isRaw && f.writes.at(-1)!.includes("Action not confirmed"));
      expect(f.input.listenerCount("data")).toBe(1);
      f.input.key("j");
      expect(f.writes.at(-1)).toContain("> codex");
    } finally {
      f.input.key("q");
      await running;
    }
  });

  test("mutation failure is redacted, never automatically retried, and does not queue repeat keys", async () => {
    const action = deferred<unknown>();
    let starts = 0;
    const f = fixture({
      request: async (path) => {
        if (path === "/operator/start") {
          starts++;
          await action.promise;
          throw new Error("uncertain \x1b[2Joperator-private-token");
        }
        return status();
      },
    });
    const running = runConsoleSession(cfg, f.options);
    try {
      await Bun.sleep(10);
      f.input.key("s");
      f.input.key("s");
      action.resolve({});
      await until(() => f.writes.some((text) => text.includes("Action not confirmed")));
      await Bun.sleep(60);
      expect(starts).toBe(1);
      expect(f.writes.join("")).not.toContain(cfg.operatorToken);
      expect(f.writes.some((text) => text.includes("uncertain [redacted]"))).toBe(true);
    } finally {
      f.input.key("q");
      await running;
    }
  });

  test("non-terminal use prints one safe frame with no raw mode or interactive listeners", async () => {
    const f = fixture();
    f.input.isTTY = false;
    expect(await runConsoleSession(cfg, f.options)).toBe(0);
    expect(f.calls.map((call) => call.path)).toEqual(["/operator/status"]);
    expect(f.writes.join("")).not.toContain("\x1b");
    expect(f.input.modes).toEqual([]);
    expect(f.input.listenerCount("data")).toBe(0);
    const failed = fixture({
      request: async () => {
        throw new Error(cfg.operatorToken);
      },
    });
    failed.options.output.isTTY = false;
    expect(await runConsoleSession(cfg, failed.options)).toBe(1);
    expect(failed.writes.join("")).not.toContain(cfg.operatorToken);
  });

  test("real terminal exits naturally on q after tmux detach and leaves the fixture session alive", async () => {
    const pilot = preparePilot();
    const instance = randomUUID();
    let endpoint: PilotEndpoint;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== `Bearer ${pilot.operatorToken}`)
          return new Response(null, { status: 401 });
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === "/operator/status")
          return Response.json({ ...status(), pilot: pilot.id, endpoint });
        if (request.method === "POST" && path === "/operator/pause")
          return Response.json({
            agentId: ((await request.json()) as { agentId: string }).agentId,
            paused: true,
          });
        return new Response(null, { status: 404 });
      },
    });
    endpoint = { pid: process.pid, born: processBirth(process.pid)!, port: server.port!, instance };
    recordProcess(pilot.root, "coordinator", undefined, false, instance);
    writePrivateJson(pilotFile(pilot.root, "endpoint.json"), endpoint);
    const tmux = (...args: string[]) => {
      const result = Bun.spawnSync(["tmux", "-L", pilot.tmuxSocket, "-f", "/dev/null", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(`fixture tmux: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    };
    const nativeFile = join(pilot.root, "native-fixture.ts");
    const consoleFile = join(pilot.root, "console-fixture.ts");
    writeFileSync(nativeFile, 'console.log("NATIVE_CONSOLE_FIXTURE"); setInterval(() => {}, 1000);\n');
    writeFileSync(
      consoleFile,
      [
        `import { runConsole } from ${JSON.stringify(sourceFile("../run/console.ts"))};`,
        "process.stdin.resume();",
        "process.exitCode = await runConsole(process.argv[2]);",
        'console.log("CONSOLE_RETURNED_" + process.exitCode);',
      ].join("\n"),
    );
    let child: Bun.Subprocess | undefined;
    try {
      const pane = tmux(
        "new-session",
        "-d",
        "-s",
        pilot.tmuxSession,
        "-x",
        "220",
        "-y",
        "60",
        "-P",
        "-F",
        "#{pane_id}",
        `exec ${shellQuote(process.execPath)} ${shellQuote(nativeFile)}`,
      );
      const session = tmux("display-message", "-p", "-t", pane, "#{session_id}");
      tmux("set-option", "-t", session, "@agent-bridge-owner", `native-pilot:${pilot.id}`);
      writePrivateJson(agentFile(pilot.root, "claude", "pane"), { paneId: pane });
      const originalPid = tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
      let output = "";
      const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
      delete env.TMUX;
      delete env.TMUX_PANE;
      child = Bun.spawn([process.execPath, consoleFile, pilot.root], {
        env,
        terminal: {
          cols: 220,
          rows: 60,
          name: "xterm-256color",
          data: (_terminal, bytes) => {
            output = (output + Buffer.from(bytes).toString()).slice(-128_000);
          },
        },
      });
      await until(() => output.includes("Select an agent to inspect its native TUI."), 5000);
      child.terminal!.write("\r");
      await until(() => output.includes("NATIVE_CONSOLE_FIXTURE"), 5000);
      child.terminal!.write("\x02d");
      await until(() => output.includes("claude remains paused; r resumes peer input."), 5000);
      child.terminal!.write("q");
      await until(() => output.includes("CONSOLE_RETURNED_0"), 2000);
      await until(() => child!.exitCode !== null, 2000);
      expect(await child.exited).toBe(0);
      expect(output).toContain("\x1b[?25h\x1b[?1049l");
      expect(tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(originalPid);
      expect(tmux("display-message", "-p", "-t", pane, "#{pane_dead}")).toBe("0");
      expect(tmux("list-clients", "-t", session)).toBe("");
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      await child?.exited;
      child?.terminal?.close();
      Bun.spawnSync(["tmux", "-L", pilot.tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
      await server.stop(true);
      rmSync(pilot.socketDir, { recursive: true, force: true });
      rmSync(pilot.root, { recursive: true, force: true });
    }
  }, 20_000);
});
