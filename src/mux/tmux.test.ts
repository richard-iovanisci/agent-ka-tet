import { afterAll, describe, expect, test } from "bun:test";
import { TmuxAdapter, verifyFragment } from "./tmux.ts";

/**
 * Runs against a REAL tmux server (CLAUDE.md: no mocks) on a throwaway
 * socket, with -f /dev/null so the user's tmux.conf can't interfere.
 * Tests in this file share one session and run in declaration order.
 */

const SOCKET = `bridge-test-${process.pid}`;
const SESSION = "mux-adapter-test";
const CWD = process.cwd();

const tmux = new TmuxAdapter({ socketName: SOCKET, configFile: "/dev/null" });

let firstPane = "";
const splitPanes: string[] = [];

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

function waitForOutput(paneId: string, needle: string): Promise<boolean> {
  return pollFor(async () => (await tmux.capturePane(paneId)).includes(needle));
}

/** Wait until the pane's shell has drawn a prompt (any non-whitespace). */
function waitForPrompt(paneId: string): Promise<boolean> {
  return pollFor(async () => /\S/.test(await tmux.capturePane(paneId)));
}

describe("TmuxAdapter", () => {
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
      expect(Number.isInteger(p.index)).toBe(true);
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
      expect(typeof p.title).toBe("string");
      expect(p.command.length).toBeGreaterThan(0); // the user's shell
    }
    expect(panes.filter((p) => p.active).length).toBe(1);
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
    expect(result).toEqual({ ok: true, verified: false, retried: false });
  });

  test("verifyFragment picks the tail of the last non-empty line", () => {
    expect(verifyFragment("hello\nworld  \n\n")).toBe("world");
    expect(verifyFragment(`start\n${"x".repeat(80)}`)).toBe("x".repeat(40));
    expect(verifyFragment("\n \n")).toBe("");
  });

  test("setPaneTitle shows up in listPanes", async () => {
    await tmux.setPaneTitle(firstPane, "claude");
    const panes = await tmux.listPanes(SESSION);
    expect(panes.find((p) => p.id === firstPane)?.title).toBe("claude");
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
