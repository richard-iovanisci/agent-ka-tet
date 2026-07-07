import type { MuxAdapter, PaneInfo, SendResult } from "./adapter.ts";

/**
 * tmux backend for MuxAdapter. Every invocation is an argv array through
 * Bun.spawn — never a shell string — so session names, titles, and injected
 * text can't be re-interpreted by a shell.
 *
 * Injection etiquette (DESIGN.md §4, load-bearing): text goes in as ONE
 * bracketed paste via a uniquely named tmux buffer (load-buffer from stdin +
 * paste-buffer -d -p), the echo is verified via capture-pane, the paste is
 * retried once on a failed verification, and a single trailing Enter is sent
 * only after the paste (+ verification) — never per-line send-keys, which is
 * the naive path that intermittently loses keystrokes.
 */

export interface TmuxAdapterOptions {
  /** tmux -L socket name (tests use a throwaway socket per run). */
  socketName?: string;
  /** tmux -f config file (tests use /dev/null to shut out the user's conf). */
  configFile?: string;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SEP = "\x1f"; // ASCII unit separator — cannot appear in tmux format output fields
const PANE_FORMAT = [
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
].join(SEP);

/** How long echo-verification polls capture-pane before calling it a miss. */
const VERIFY_TIMEOUT_MS = 2000;
const VERIFY_POLL_MS = 50;
/** Distinctive-fragment length for echo verification. */
const VERIFY_FRAGMENT_CHARS = 40;

let bufferSeq = 0;

/** Exact-match session target (bare names are prefix-matched by tmux). */
function exact(session: string): string {
  return `=${session}`;
}

/**
 * Exact-match target for window/pane-taking commands (split-window,
 * select-layout, list-panes): "=session:" = that session's current window.
 * A bare "=session" is rejected by tmux's pane-target resolution.
 */
function exactWindow(session: string): string {
  return `=${session}:`;
}

/**
 * Distinctive fragment for echo verification: the last ~40 chars of the last
 * non-empty line, trimmed. Empty when the text has no non-empty line.
 */
export function verifyFragment(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  return last === undefined ? "" : last.slice(-VERIFY_FRAGMENT_CHARS);
}

export class TmuxAdapter implements MuxAdapter {
  /** ["tmux", ...socket/config flags] prepended to every invocation. */
  private readonly baseArgv: readonly string[];

  constructor(opts: TmuxAdapterOptions = {}) {
    const argv = ["tmux"];
    if (opts.socketName !== undefined) argv.push("-L", opts.socketName);
    if (opts.configFile !== undefined) argv.push("-f", opts.configFile);
    this.baseArgv = argv;
  }

  /** Run tmux, never throwing on a non-zero exit. */
  private async run(args: string[], stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn({
      cmd: [...this.baseArgv, ...args],
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** Run tmux, throwing (with stderr) on a non-zero exit. */
  private async exec(args: string[], stdin?: string): Promise<string> {
    const r = await this.run(args, stdin);
    if (r.exitCode !== 0) {
      throw new Error(
        `tmux ${args[0] ?? ""} exited ${r.exitCode}: ${r.stderr.trim()}`,
      );
    }
    return r.stdout;
  }

  async hasSession(session: string): Promise<boolean> {
    // Non-zero here just means "no such session" (or no server) — not an error.
    const r = await this.run(["has-session", "-t", exact(session)]);
    return r.exitCode === 0;
  }

  async createSession(
    session: string,
    opts: { cwd: string; width?: number; height?: number },
  ): Promise<string> {
    // tmux silently rewrites '.' and ':' in session names; accepting that
    // would create a session that exact-match targets can never address.
    if (session.length === 0 || /[.:\s]/.test(session)) {
      throw new Error(
        `tmux session names must not contain '.', ':' or whitespace: ${JSON.stringify(session)}`,
      );
    }
    // No command argument: the pane runs the user's default shell, so it
    // outlives whatever agent is later launched by typing into it.
    const args = ["new-session", "-d", "-s", session, "-c", opts.cwd];
    if (opts.width !== undefined) args.push("-x", String(opts.width));
    if (opts.height !== undefined) args.push("-y", String(opts.height));
    args.push("-P", "-F", "#{pane_id}");
    return (await this.exec(args)).trim();
  }

  async splitPane(session: string, opts: { cwd: string }): Promise<string> {
    const out = await this.exec([
      "split-window",
      "-t",
      exactWindow(session),
      "-c",
      opts.cwd,
      "-P",
      "-F",
      "#{pane_id}",
    ]);
    return out.trim();
  }

  async selectLayout(
    session: string,
    layout: "tiled" | "even-horizontal" | "even-vertical",
  ): Promise<void> {
    await this.exec(["select-layout", "-t", exactWindow(session), layout]);
  }

  async listPanes(session: string): Promise<PaneInfo[]> {
    const out = await this.exec([
      "list-panes",
      "-t",
      exactWindow(session),
      "-F",
      PANE_FORMAT,
    ]);
    const panes: PaneInfo[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      // tmux vis-encodes control characters when printing command output, so
      // the \x1f separator can come back as the literal four chars "\037".
      const [id, index, title, command, width, height, active] =
        line.split(/\x1f|\\037/);
      if (
        id === undefined ||
        index === undefined ||
        title === undefined ||
        command === undefined ||
        width === undefined ||
        height === undefined ||
        active === undefined
      ) {
        throw new Error(`tmux list-panes: malformed line ${JSON.stringify(line)}`);
      }
      panes.push({
        id,
        index: Number.parseInt(index, 10),
        title,
        command,
        width: Number.parseInt(width, 10),
        height: Number.parseInt(height, 10),
        active: active === "1",
      });
    }
    return panes;
  }

  async capturePane(
    paneId: string,
    opts?: { lines?: number },
  ): Promise<string> {
    const args = ["capture-pane", "-p", "-t", paneId];
    if (opts?.lines !== undefined) args.push("-S", `-${opts.lines}`);
    return this.exec(args);
  }

  async sendText(
    paneId: string,
    text: string,
    opts?: { submit?: boolean; verify?: boolean },
  ): Promise<SendResult> {
    const verify = opts?.verify !== false;
    const fragment = verifyFragment(text);
    let verified = false;
    let retried = false;

    // Baseline BEFORE pasting: if the fragment is already on screen (same
    // command sent earlier, prompt echo, …), a lost paste would otherwise be
    // reported as verified. The paste must make the count go UP.
    const baseline = verify && fragment.length > 0 ? countOccurrences(await this.captureJoined(paneId), fragment) : 0;

    await this.paste(paneId, text);
    if (verify) {
      verified = await this.verifyEcho(paneId, fragment, baseline + 1);
      if (!verified) {
        retried = true;
        await this.paste(paneId, text);
        verified = await this.verifyEcho(paneId, fragment, baseline + 1);
      }
    }

    // ok = the text demonstrably landed (or we were told not to check).
    const ok = verify ? verified : true;

    // Single trailing Enter, only after the paste (+ verification) — and never
    // into a pane where the paste demonstrably did not land.
    if (ok && opts?.submit === true) {
      await this.exec(["send-keys", "-t", paneId, "Enter"]);
    }
    return { ok, verified, retried };
  }

  async focusPane(_session: string, paneId: string): Promise<void> {
    // Pane ids are server-global; they resolve the window too.
    await this.exec(["select-window", "-t", paneId]);
    await this.exec(["select-pane", "-t", paneId]);
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.exec(["select-pane", "-t", paneId, "-T", title]);
  }

  async killSession(session: string): Promise<void> {
    await this.exec(["kill-session", "-t", exact(session)]);
  }

  attachArgs(session: string): string[] {
    return [...this.baseArgv, "attach", "-t", session];
  }

  /**
   * One whole-text paste through a uniquely named buffer. -p pastes with
   * bracketed-paste codes when the pane's application requested them; -d
   * deletes the buffer after pasting.
   */
  private async paste(paneId: string, text: string): Promise<void> {
    const buf = `bridge-${process.pid}-${Date.now()}-${bufferSeq++}`;
    await this.exec(["load-buffer", "-b", buf, "-"], text);
    await this.exec(["paste-buffer", "-d", "-p", "-b", buf, "-t", paneId]);
  }

  /** capture-pane with -J so a paste wrapped across pane-width lines rejoins. */
  private async captureJoined(paneId: string): Promise<string> {
    return this.exec(["capture-pane", "-p", "-J", "-t", paneId]);
  }

  /**
   * Echo verification: poll capture-pane until the fragment appears at least
   * `minCount` times (baseline occurrences + 1, so pre-existing text on
   * screen can't vouch for a lost paste) or the timeout lapses. An empty
   * fragment (nothing distinctive to look for) verifies trivially.
   */
  private async verifyEcho(paneId: string, fragment: string, minCount: number): Promise<boolean> {
    if (fragment.length === 0) return true;
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    for (;;) {
      if (countOccurrences(await this.captureJoined(paneId), fragment) >= minCount) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(VERIFY_POLL_MS);
    }
  }
}

/** Non-overlapping occurrence count. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    i = haystack.indexOf(needle, i);
    if (i === -1) return count;
    count++;
    i += needle.length;
  }
}
