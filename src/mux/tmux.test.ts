import { afterAll, describe, expect, test } from "bun:test";
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
import { fileURLToPath } from "node:url";
import {
  TmuxAdapter,
  countOccurrences,
  parsePaneLine,
  verifyFragment,
} from "./tmux.ts";

/**
 * Runs against a REAL tmux server (CLAUDE.md: no mocks) on a throwaway
 * socket, with -f /dev/null so the user's tmux.conf can't interfere.
 * Tests in this file share one session and run in declaration order.
 */

const SOCKET = `bridge-test-${process.pid}`;
const SESSION = "mux-adapter-test";
const CWD = process.cwd();
const COLLAPSED_RECEIVER = fileURLToPath(
  new URL("./fixtures/collapsedPasteReceiver.ts", import.meta.url),
);

const tmux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });

let firstPane = "";
const splitPanes: string[] = [];
let receiverSeq = 0;

afterAll(async () => {
  // Tear the whole throwaway server down; ignore failure (already gone).
  const proc = Bun.spawn({
    cmd: ["tmux", "-L", SOCKET, "kill-server"],
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
});

/** Poll an async predicate every 50ms until true or timeout. */
async function pollFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

async function rawTmux(args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tmux", "-L", SOCKET, "-f", "/dev/null", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`tmux ${args[0] ?? ""} exited ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

function waitForOutput(paneId: string, needle: string): Promise<boolean> {
  return pollFor(async () => (await tmux.capturePane(paneId)).includes(needle));
}

/** Wait until the pane's shell has drawn a prompt (any non-whitespace). */
function waitForPrompt(paneId: string): Promise<boolean> {
  return pollFor(async () => /\S/.test(await tmux.capturePane(paneId)));
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface ReceiverAudit {
  payloads: string[];
  submitted: number;
}

interface ReceiverHarness {
  mux: TmuxAdapter;
  session: string;
  pane: string;
  outputPath: string;
  auditPath: string;
  directory: string;
}

async function startCollapsedReceiver(
  kind: "claude" | "codex",
  behavior:
    | "normal"
    | "literal"
    | "both"
    | "silent"
    | "duplicate"
    | "replace-duplicate"
    | "delayed",
): Promise<ReceiverHarness> {
  const session = `mux-receiver-${process.pid}-${receiverSeq++}`;
  const directory = mkdtempSync(join(tmpdir(), "bridge-mux-receiver-"));
  const outputPath = join(directory, "submitted.txt");
  const auditPath = join(directory, "audit.json");
  const receiverMux = new TmuxAdapter({
    socketName: SOCKET,
    configFile: "/dev/null",
    verificationTimeoutMs: 100,
    verificationPollMs: 10,
    verificationSettleMs: 20,
  });
  const pane = await receiverMux.createSession(session, {
    cwd: CWD,
    width: 180,
    height: 40,
  });
  expect(await receiverMux.waitForShellReady(pane)).toBe(true);
  const command = [
    "bun",
    shellWord(COLLAPSED_RECEIVER),
    kind,
    behavior,
    shellWord(outputPath),
    shellWord(auditPath),
  ].join(" ");
  const launched = await receiverMux.sendText(pane, command, { submit: true });
  expect(launched.ok).toBe(true);
  expect(
    await pollFor(async () =>
      (await receiverMux.capturePane(pane)).includes(
        `COLLAPSED_RECEIVER_READY ${kind} ${behavior}`,
      )
    ),
  ).toBe(true);
  return {
    mux: receiverMux,
    session,
    pane,
    outputPath,
    auditPath,
    directory,
  };
}

function receiverAudit(harness: ReceiverHarness): ReceiverAudit {
  return JSON.parse(readFileSync(harness.auditPath, "utf8")) as ReceiverAudit;
}

async function disposeReceiver(harness: ReceiverHarness): Promise<void> {
  if (await harness.mux.hasSession(harness.session)) {
    await harness.mux.killSession(harness.session);
  }
  rmSync(harness.directory, { recursive: true, force: true });
}

describe("countOccurrences", () => {
  test("non-overlapping counting", () => {
    expect(countOccurrences("abcabcabc", "abc")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("xyz", "q")).toBe(0);
    expect(countOccurrences("xyz", "")).toBe(0);
  });
});

describe("parsePaneLine", () => {
  const separator = "__pane_separator__";
  const fields = [
    "%7",
    "1234",
    "0",
    "claude_worker_1",
    "pid:1234",
    "title_with_under_scores",
    "zsh",
    "120",
    "40",
    "1",
  ];

  test("requires exactly ten fields and strict numeric values", () => {
    expect(parsePaneLine(fields.join(separator), separator)).toMatchObject({
      id: "%7",
      pid: 1234,
      index: 0,
      width: 120,
      height: 40,
      active: true,
    });
    expect(() => parsePaneLine([...fields, "extra"].join(separator), separator))
      .toThrow(/malformed line/);
    for (const [index, bad] of [[1, "12x"], [2, "NaN"], [7, "0"], [8, "-1"]] as const) {
      const malformed = [...fields];
      malformed[index] = bad;
      expect(() => parsePaneLine(malformed.join(separator), separator)).toThrow(
        /invalid|malformed/,
      );
    }
    const invalidActive = [...fields];
    invalidActive[9] = "2";
    expect(() => parsePaneLine(invalidActive.join(separator), separator)).toThrow(
      /malformed/,
    );
  });
});

describe("TmuxAdapter", () => {
  test("createSession rejects names tmux would silently rename", async () => {
    for (const bad of ["a.b", "a:b", "a b", ""]) {
      await expect(tmux.createSession(bad, { cwd: CWD })).rejects.toThrow(/must not contain|names/);
    }
  });

  test("empty or invalid commands fail before creating a session or splitting", async () => {
    for (const command of [[], [""], ["/bin/echo", "bad\0argument"]]) {
      await expect(tmux.createSession("invalid-command", { cwd: CWD, command }))
        .rejects.toThrow(/nonempty executable|NUL-free/);
      await expect(tmux.splitPane("missing-session", { cwd: CWD, command }))
        .rejects.toThrow(/nonempty executable|NUL-free/);
    }
    expect(await tmux.hasSession("invalid-command")).toBe(false);
  });

  test("hasSession is false before create, true after", async () => {
    expect(await tmux.hasSession(SESSION)).toBe(false);

    firstPane = await tmux.createSession(SESSION, {
      cwd: CWD,
      width: 200,
      height: 50,
    });
    expect(firstPane).toMatch(/^%\d+$/);
    expect(await tmux.hasSession(SESSION)).toBe(true);
  });

  test("session ownership marker roundtrips", async () => {
    expect(await tmux.getSessionMarker(SESSION)).toBeNull();
    await tmux.setSessionMarker(SESSION, '{"configDir":"/repo","fingerprint":"abc"}');
    expect(await tmux.getSessionMarker(SESSION)).toBe(
      '{"configDir":"/repo","fingerprint":"abc"}',
    );
  });

  test("three splits + tiled layout => four sane panes", async () => {
    for (let i = 0; i < 3; i++) {
      splitPanes.push(await tmux.splitPane(SESSION, { cwd: CWD }));
    }
    await tmux.selectLayout(SESSION, "tiled");

    const panes = await tmux.listPanes(SESSION);
    expect(panes.length).toBe(4);

    const ids = panes.map((p) => p.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain(firstPane);
    for (const split of splitPanes) expect(ids).toContain(split);

    for (const p of panes) {
      expect(p.id).toMatch(/^%\d+$/);
      expect(p.pid).toBeGreaterThan(0);
      expect(Number.isInteger(p.index)).toBe(true);
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(p.agentId).toBeNull();
      expect(p.managedProcess).toBeNull();
      expect(typeof p.title).toBe("string");
      expect(p.command.length).toBeGreaterThan(0); // the user's shell
    }
    expect(panes.filter((p) => p.active).length).toBe(1);
  });

  test("managed pane operations ignore a different current scratch window", async () => {
    const before = await tmux.listPanes(SESSION);
    const managedIds = before.map((pane) => pane.id);
    const scratchWindow = (
      await rawTmux([
        "new-window",
        "-t",
        `=${SESSION}:`,
        "-n",
        "scratch",
        "-P",
        "-F",
        "#{window_id}",
      ])
    ).trim();
    expect(scratchWindow).toMatch(/^@\d+$/);
    expect(
      (await rawTmux([
        "display-message",
        "-p",
        "-t",
        `=${SESSION}:`,
        "#{window_id}",
      ])).trim(),
    ).toBe(scratchWindow);

    expect((await tmux.listPanes(SESSION)).map((pane) => pane.id)).toEqual(
      managedIds,
    );
    const added = await tmux.splitPane(SESSION, { cwd: CWD });
    await tmux.selectLayout(SESSION, "tiled");
    const after = await tmux.listPanes(SESSION);
    expect(after.map((pane) => pane.id)).toEqual([...managedIds, added]);
    expect(
      (await rawTmux([
        "list-panes",
        "-t",
        scratchWindow,
        "-F",
        "#{pane_id}",
      ])).trim().split("\n"),
    ).toHaveLength(1);

    const managedWindow = (
      await rawTmux([
        "display-message",
        "-p",
        "-t",
        firstPane,
        "#{window_id}",
      ])
    ).trim();
    const sessionId = (
      await rawTmux([
        "display-message",
        "-p",
        "-t",
        firstPane,
        "#{session_id}",
      ])
    ).trim();

    await rawTmux([
      "set-option",
      "-u",
      "-t",
      sessionId,
      "@agent-bridge-window-id",
    ]);
    await expect(tmux.listPanes(SESSION)).rejects.toThrow(/no managed window identity/);

    await rawTmux([
      "set-option",
      "-t",
      sessionId,
      "@agent-bridge-window-id",
      scratchWindow,
    ]);
    await expect(tmux.listPanes(SESSION)).rejects.toThrow(/not reciprocally marked/);

    await rawTmux([
      "set-option",
      "-t",
      sessionId,
      "@agent-bridge-window-id",
      managedWindow,
    ]);
    await rawTmux([
      "set-option",
      "-w",
      "-u",
      "-t",
      managedWindow,
      "@agent-bridge-managed-window",
    ]);
    await expect(tmux.listPanes(SESSION)).rejects.toThrow(/not reciprocally marked/);
    await rawTmux([
      "set-option",
      "-w",
      "-t",
      managedWindow,
      "@agent-bridge-managed-window",
      sessionId,
    ]);
    expect((await tmux.listPanes(SESSION)).map((pane) => pane.id)).toEqual(
      [...managedIds, added],
    );
  });

  test("sendText + submit: paste, verify, Enter, output lands", async () => {
    expect(await waitForPrompt(firstPane)).toBe(true);

    // The concatenated marker only exists in the *output*, never in the
    // echoed command line, so seeing it proves Enter executed the paste.
    const result = await tmux.sendText(
      firstPane,
      "printf '%s_END\\n' MUX_MARKER_A1",
      { submit: true },
    );
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true); // happy path verifies
    expect(result.retried).toBe(false);

    expect(await waitForOutput(firstPane, "MUX_MARKER_A1_END")).toBe(true);
  });

  test("multi-line sendText arrives intact as one paste", async () => {
    const text = [
      "printf '%s_X\\n' MLINE_A7",
      "printf '%s_Y\\n' MLINE_B7",
    ].join("\n");

    const result = await tmux.sendText(firstPane, text, { submit: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);

    expect(await waitForOutput(firstPane, "MLINE_A7_X")).toBe(true);
    expect(await waitForOutput(firstPane, "MLINE_B7_Y")).toBe(true);
  });

  test("sendText with verify: false skips verification", async () => {
    const spare = splitPanes[splitPanes.length - 1];
    if (spare === undefined) throw new Error("no split pane available");
    // No submit: the text just sits at the spare pane's prompt.
    const result = await tmux.sendText(spare, ": unverified-paste", {
      verify: false,
    });
    expect(result).toEqual({
      ok: true,
      verified: false,
      retried: false,
      observable: null,
      failure: null,
    });
  });

  test("verifyFragment picks the tail of the last non-empty line", () => {
    expect(verifyFragment("hello\nworld  \n\n")).toBe("world");
    expect(verifyFragment(`start\n${"x".repeat(80)}`)).toBe("x".repeat(40));
    expect(verifyFragment("\n \n")).toBe("");
  });

  test("pane identity survives a native-TUI-style display title replacement", async () => {
    await tmux.setPaneAgentId(firstPane, "claude");
    await tmux.setPaneTitle(firstPane, "claude");
    await tmux.setPaneTitle(firstPane, "✳ Claude Code");
    const pane = (await tmux.listPanes(SESSION)).find((p) => p.id === firstPane);
    // C-locale tmux replaces the unrepresentable glyph with an underscore;
    // the durable ASCII identity marker remains exact in either locale.
    expect(pane).toBeDefined();
    expect(["✳ Claude Code", "_ Claude Code"]).toContain(pane?.title ?? "");
    expect(pane?.agentId).toBe("claude");
  });

  test("listPanes is C-locale safe and preserves underscores", async () => {
    await tmux.setPaneAgentId(firstPane, "claude_worker_1");
    await tmux.setPaneTitle(firstPane, "title_with_under_scores");
    const cLocaleMux = new TmuxAdapter({
      socketName: SOCKET,
      configFile: "/dev/null",
      environment: { LC_ALL: "C", LANG: "C" },
    });
    const pane = (await cLocaleMux.listPanes(SESSION)).find(
      (candidate) => candidate.id === firstPane,
    );
    expect(pane?.agentId).toBe("claude_worker_1");
    expect(pane?.title).toBe("title_with_under_scores");
    expect(pane?.pid).toBeGreaterThan(0);
  });

  test("native-TUI policy verifies Claude and Codex collapsed pastes exactly once", async () => {
    const packet = [
      "---",
      "id: handoff-collapse-test",
      "---",
      "# Handoff",
      "x".repeat(1_100),
      "Agent Bridge packet handoff-collapse-test",
    ].join("\n");

    for (const kind of ["claude", "codex"] as const) {
      const harness = await startCollapsedReceiver(kind, "normal");
      try {
        const result = await harness.mux.sendText(harness.pane, packet, {
          submit: true,
          verification: { mode: "native-tui", agentKind: kind },
        });
        expect(result).toEqual({
          ok: true,
          verified: true,
          retried: false,
          observable: `${kind}-placeholder`,
          failure: null,
        });
        expect(
          await pollFor(async () => existsSync(harness.outputPath)),
        ).toBe(true);
        expect(readFileSync(harness.outputPath, "utf8")).toBe(packet);
        expect(receiverAudit(harness)).toEqual({
          payloads: [packet],
          submitted: 1,
        });
      } finally {
        await disposeReceiver(harness);
      }
    }
  }, 15_000);

  test("native-TUI policy accepts one literal receipt for either provider", async () => {
    for (const kind of ["claude", "codex"] as const) {
      const harness = await startCollapsedReceiver(kind, "literal");
      const packet = `small packet for ${kind}\nAgent Bridge packet literal-${kind}`;
      try {
        const result = await harness.mux.sendText(harness.pane, packet, {
          submit: true,
          verification: { mode: "native-tui", agentKind: kind },
        });
        expect(result).toEqual({
          ok: true,
          verified: true,
          retried: false,
          observable: "literal",
          failure: null,
        });
        expect(await pollFor(async () => existsSync(harness.outputPath))).toBe(true);
        expect(receiverAudit(harness)).toEqual({
          payloads: [packet],
          submitted: 1,
        });
      } finally {
        await disposeReceiver(harness);
      }
    }
  }, 15_000);

  test("a delayed native observable retries capture without re-pasting", async () => {
    const harness = await startCollapsedReceiver("codex", "delayed");
    const packet = `${"d".repeat(1_050)}\nAgent Bridge packet delayed`;
    try {
      const result = await harness.mux.sendText(harness.pane, packet, {
        submit: true,
        verification: { mode: "native-tui", agentKind: "codex" },
      });
      expect(result).toEqual({
        ok: true,
        verified: true,
        retried: true,
        observable: "codex-placeholder",
        failure: null,
      });
      expect(await pollFor(async () => existsSync(harness.outputPath))).toBe(true);
      expect(receiverAudit(harness).payloads).toEqual([packet]);
    } finally {
      await disposeReceiver(harness);
    }
  });

  test("missing native observable fails after one paste and sends no Enter", async () => {
    const harness = await startCollapsedReceiver("claude", "silent");
    const packet = ["one", "two", "three", "Agent Bridge packet silent"].join("\n");
    try {
      const result = await harness.mux.sendText(harness.pane, packet, {
        submit: true,
        verification: { mode: "native-tui", agentKind: "claude" },
      });
      expect(result).toEqual({
        ok: false,
        verified: false,
        retried: true,
        observable: null,
        failure: "verification-timeout",
      });
      expect(receiverAudit(harness)).toEqual({
        payloads: [packet],
        submitted: 0,
      });
      expect(existsSync(harness.outputPath)).toBe(false);
    } finally {
      await disposeReceiver(harness);
    }
  });

  test("multiple or conflicting native observables are ambiguous", async () => {
    for (const behavior of ["duplicate", "both"] as const) {
      const harness = await startCollapsedReceiver("codex", behavior);
      const packet = `${"a".repeat(1_050)}\nAgent Bridge packet ${behavior}`;
      try {
        const result = await harness.mux.sendText(harness.pane, packet, {
          submit: true,
          verification: { mode: "native-tui", agentKind: "codex" },
        });
        expect(result).toEqual({
          ok: false,
          verified: false,
          retried: false,
          observable: null,
          failure: "ambiguous-observable",
        });
        expect(receiverAudit(harness)).toEqual({
          payloads: [packet],
          submitted: 0,
        });
        expect(existsSync(harness.outputPath)).toBe(false);
      } finally {
        await disposeReceiver(harness);
      }
    }
  }, 15_000);

  test("redraw cannot hide two new placeholders behind one disappearing old one", async () => {
    const harness = await startCollapsedReceiver("claude", "replace-duplicate");
    const packet = `${"r".repeat(1_050)}\nAgent Bridge packet redraw-duplicate`;
    try {
      const result = await harness.mux.sendText(harness.pane, packet, {
        submit: true,
        verification: { mode: "native-tui", agentKind: "claude" },
      });
      expect(result).toEqual({
        ok: false,
        verified: false,
        retried: false,
        observable: null,
        failure: "ambiguous-observable",
      });
      expect(receiverAudit(harness)).toEqual({
        payloads: [packet],
        submitted: 0,
      });
    } finally {
      await disposeReceiver(harness);
    }
  });

  test("beforeSubmit failure leaves the proven paste unsubmitted", async () => {
    const harness = await startCollapsedReceiver("codex", "literal");
    const packet = "pre-submit check\nAgent Bridge packet pre-submit";
    try {
      await expect(harness.mux.sendText(harness.pane, packet, {
        submit: true,
        verification: { mode: "native-tui", agentKind: "codex" },
        beforeSubmit: () => {
          throw new Error("managed process exited");
        },
      })).rejects.toThrow("managed process exited");
      expect(receiverAudit(harness)).toEqual({
        payloads: [packet],
        submitted: 0,
      });
      expect(existsSync(harness.outputPath)).toBe(false);
    } finally {
      await disposeReceiver(harness);
    }
  });

  test("focusPane moves the active flag", async () => {
    await tmux.focusPane(SESSION, firstPane);
    const panes = await tmux.listPanes(SESSION);
    expect(panes.find((p) => p.active)?.id).toBe(firstPane);
  });

  test("attachArgs returns an interactive-attach argv", () => {
    expect(tmux.attachArgs(SESSION)).toEqual([
      "tmux",
      "-L",
      SOCKET,
      "-f",
      "/dev/null",
      "attach",
      "-t",
      SESSION,
    ]);
  });

  test("killSession => hasSession false", async () => {
    await tmux.killSession(SESSION);
    expect(await tmux.hasSession(SESSION)).toBe(false);
  });
});

describe("TmuxAdapter direct commands", () => {
  test("executes literal argv and cwd without shell init, retaining only direct panes on exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-direct-command-"));
    const socket = `bridge-direct-${process.pid}`;
    const env = { ...process.env, SHELL: "/bin/zsh", ZDOTDIR: directory };
    const mux = new TmuxAdapter({ socketName: socket, configFile: "/dev/null", environment: env });
    const raw = async (args: string[]) => {
      const process = Bun.spawn({ cmd: ["tmux", "-L", socket, "-f", "/dev/null", ...args], env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      if (code !== 0) throw new Error(stderr);
      return stdout.trim();
    };
    const shellMarker = join(directory, "shell-started");
    writeFileSync(join(directory, ".zshenv"), 'print -r -- "hostile shell init" > "$ZDOTDIR/shell-started"\nexit 73\n');
    const probe = Bun.spawn({ cmd: ["/bin/zsh", "-c", "exit 0"], env, stdout: "ignore", stderr: "ignore" });
    expect(await probe.exited).toBe(73);
    expect(existsSync(shellMarker)).toBe(true);
    rmSync(shellMarker);
    const script = join(directory, "record argv.ts");
    writeFileSync(script, `import { existsSync, writeFileSync, writeSync } from "node:fs";
const [output, ...argv] = process.argv.slice(2);
writeSync(1, "DIRECT_OUTPUT_RETAINED\\n");
writeFileSync(output, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }));
setInterval(() => { if (existsSync(output + ".exit")) process.exit(23); }, 25);
`);
    const values = ["two words", "\"quoted\" 'value'", "$(touch SHOULD_NOT_EXIST)", "`touch ALSO_NOT_CREATED`", "a;b", ";", "tail;", "backslash\\;", "double\\\\;", "line\nbreak", "--flag", "", "# literal", "a=b"];
    try {
      const outputs: string[] = [];
      const panes: string[] = [];
      for (const [index, cwdName] of ["create cwd ;", "split cwd $() ;"].entries()) {
        const cwd = join(directory, cwdName);
        mkdirSync(cwd);
        const output = join(directory, `argv-${index}.json`);
        const command = Object.freeze([process.execPath, script, output, ...values]);
        const pane = index === 0
          ? await mux.createSession("direct-command", { cwd, width: 160, height: 48, command })
          : await mux.splitPane("direct-command", { cwd, command });
        expect(await pollFor(async () => existsSync(output))).toBe(true);
        const record = JSON.parse(readFileSync(output, "utf8"));
        expect(record).toEqual({ argv: values, cwd: realpathSync(cwd), pid: expect.any(Number) });
        expect(await raw(["display-message", "-p", "-t", pane, "#{pane_pid}"])).toBe(String(record.pid));
        expect(await raw(["show-options", "-p", "-v", "-t", pane, "remain-on-exit"])).toBe("on");
        expect(existsSync(join(cwd, "SHOULD_NOT_EXIST"))).toBe(false);
        expect(existsSync(join(cwd, "ALSO_NOT_CREATED"))).toBe(false);
        await mux.setPaneAgentId(pane, `direct-${index}`);
        outputs.push(output);
        panes.push(pane);
      }
      expect((await mux.listPanes("direct-command")).map((pane) => [pane.id, pane.agentId]))
        .toEqual(panes.map((pane, index) => [pane, `direct-${index}`]));
      expect(existsSync(shellMarker)).toBe(false);
      expect(await raw(["show-options", "-g", "-w", "-v", "remain-on-exit"])).toBe("off");

      const singleOutput = join(directory, "single.json");
      const executable = join(directory, "single program = $(literal) ;");
      writeFileSync(executable, `#!${process.execPath}\n${readFileSync(script, "utf8").replace('process.argv.slice(2)', JSON.stringify([singleOutput]))}`, { mode: 0o700 });
      const singlePane = await mux.createSession("single-command", { cwd: directory, command: [executable] });
      expect(await pollFor(async () => existsSync(singleOutput))).toBe(true);
      expect(JSON.parse(readFileSync(singleOutput, "utf8"))).toMatchObject({ argv: [], cwd: realpathSync(directory) });
      expect(existsSync(shellMarker)).toBe(false);
      outputs.push(singleOutput);
      panes.push(singlePane);

      for (const [index, output] of outputs.entries()) {
        writeFileSync(`${output}.exit`, "exit");
        const pane = panes[index]!;
        expect(await pollFor(async () => (await raw(["display-message", "-p", "-t", pane, "#{pane_dead}:#{pane_dead_status}"])) === "1:23")).toBe(true);
        expect(await mux.capturePane(pane, { lines: 100 })).toContain("DIRECT_OUTPUT_RETAINED");
      }
      expect(await mux.hasSession("direct-command")).toBe(true);
      expect(await mux.hasSession("single-command")).toBe(true);

      rmSync(join(directory, ".zshenv"));
      const legacyPane = await mux.splitPane("direct-command", { cwd: directory });
      expect(await mux.waitForShellReady(legacyPane)).toBe(true);
      expect(await raw(["show-options", "-p", "-A", "-v", "-t", legacyPane, "remain-on-exit"])).toBe("off");
    } finally {
      await raw(["kill-server"]).catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
