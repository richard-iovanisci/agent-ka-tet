import { randomBytes } from "node:crypto";
import { BRIDGE_MANAGED_PROCESS_OPTION } from "../attribution.ts";
import type {
  MuxAdapter,
  PaneInfo,
  PasteObservable,
  PasteVerification,
  SendFailure,
  SendResult,
  SendTextOptions,
} from "./adapter.ts";

export interface TmuxAdapterOptions {
  /** tmux -L socket name (tests use a throwaway socket per run). */
  socketName?: string;
  /** tmux -f config file (tests use /dev/null to shut out the user's conf). */
  configFile?: string;
  /** Per-process environment override (used to exercise locale behavior). */
  environment?: Record<string, string | undefined>;
  /** Verification timing overrides for deterministic receiver tests. */
  verificationTimeoutMs?: number;
  verificationPollMs?: number;
  verificationSettleMs?: number;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PANE_FIELDS = [
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_index}",
  "#{@agent-bridge-agent-id}",
  `#{${BRIDGE_MANAGED_PROCESS_OPTION}}`,
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
] as const;
const PANE_FIELD_COUNT = PANE_FIELDS.length;

/** How long echo-verification polls capture-pane before calling it a miss. */
const VERIFY_TIMEOUT_MS = 2000;
const VERIFY_POLL_MS = 50;
/** Require an exact observation to remain unique across at least one redraw. */
const VERIFY_SETTLE_MS = 100;
/** Distinctive-fragment length for echo verification. */
const VERIFY_FRAGMENT_CHARS = 40;
const SESSION_MARKER_OPTION = "@agent-bridge-owner";
const MANAGED_WINDOW_OPTION = "@agent-bridge-window-id";
const MANAGED_WINDOW_MARKER_OPTION = "@agent-bridge-managed-window";
const PANE_AGENT_ID_OPTION = "@agent-bridge-agent-id";

let bufferSeq = 0;

function paneCommand(command: readonly string[] | undefined): string[] {
  if (command === undefined) return [];
  if (command.length === 0 || command[0] === "" || command.some((arg) => arg.includes("\0"))) {
    throw new Error("tmux command requires a nonempty executable and NUL-free arguments");
  }
  // One tmux argument invokes a shell; nice with zero adjustment execs directly.
  return ["--", ...(command.length === 1 ? ["/usr/bin/nice", "-n", "0", "--", ...command] : command)];
}

interface ObservableCounts {
  literal: number;
  expectedPlaceholder: number;
  anyPlaceholder: number;
}

interface VerificationProbe {
  fragment: string;
  placeholderObservable: Exclude<PasteObservable, "literal"> | null;
  expectedPlaceholder: RegExp | null;
  anyPlaceholder: RegExp | null;
  baseline: ObservableCounts;
}

type Observation =
  | { state: "pending" }
  | { state: "verified"; observable: PasteObservable }
  | { state: "ambiguous" };

function paneSeparator(): string {
  // Printable ASCII survives tmux format rendering in both C and UTF-8
  // locales. Per-call randomness makes collision with a TUI-controlled field
  // negligible; exact field-count validation still fails closed on collision.
  return `__agent_bridge_${randomBytes(16).toString("hex")}__`;
}

function parseDecimal(
  value: string,
  field: string,
  line: string,
  opts: { positive?: boolean } = {},
): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `tmux list-panes: invalid ${field} in ${JSON.stringify(line)}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (opts.positive === true && parsed < 1)) {
    throw new Error(
      `tmux list-panes: invalid ${field} in ${JSON.stringify(line)}`,
    );
  }
  return parsed;
}

/** Strict parser kept separate so malformed format output can be regression-tested. */
export function parsePaneLine(line: string, separator: string): PaneInfo {
  const fields = line.split(separator);
  if (fields.length !== PANE_FIELD_COUNT) {
    throw new Error(`tmux list-panes: malformed line ${JSON.stringify(line)}`);
  }
  const [
    id,
    pidText,
    indexText,
    agentId,
    managedProcess,
    title,
    command,
    widthText,
    heightText,
    activeText,
  ] = fields as [string, string, string, string, string, string, string, string, string, string];
  if (!/^%\d+$/u.test(id) || (activeText !== "0" && activeText !== "1")) {
    throw new Error(`tmux list-panes: malformed line ${JSON.stringify(line)}`);
  }
  return {
    id,
    pid: parseDecimal(pidText, "pane_pid", line, { positive: true }),
    index: parseDecimal(indexText, "pane_index", line),
    agentId: agentId.length > 0 ? agentId : null,
    managedProcess: managedProcess.length > 0 ? managedProcess : null,
    title,
    command,
    width: parseDecimal(widthText, "pane_width", line, { positive: true }),
    height: parseDecimal(heightText, "pane_height", line, { positive: true }),
    active: activeText === "1",
  };
}

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

function countMatches(text: string, pattern: RegExp | null): number {
  if (pattern === null) return 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(text.matchAll(new RegExp(pattern.source, flags))).length;
}

function observableCounts(screen: string, probe: Omit<VerificationProbe, "baseline">): ObservableCounts {
  return {
    literal: countOccurrences(screen, probe.fragment),
    expectedPlaceholder: countMatches(screen, probe.expectedPlaceholder),
    anyPlaceholder: countMatches(screen, probe.anyPlaceholder),
  };
}

function nativePlaceholderPatterns(
  agentKind: "claude" | "codex",
  text: string,
): {
  expected: RegExp;
  any: RegExp;
  observable: Exclude<PasteObservable, "literal">;
} {
  if (agentKind === "codex") {
    const characters = Array.from(text).length;
    return {
      expected: new RegExp(`\\[Pasted Content ${characters} chars\\](?: #\\d+)?`, "gu"),
      any: /\[Pasted Content \d+ chars\](?: #\d+)?/gu,
      observable: "codex-placeholder",
    };
  }
  return {
    // Claude documents the placeholder shape but not whether "+N lines"
    // counts physical or additional lines, so exactness here is the single
    // newly rendered paste token; tmux buffer verification covers the bytes.
    expected: /\[Pasted text #\d+(?: \+\d+ lines)?\]/gu,
    any: /\[Pasted text #\d+(?: \+\d+ lines)?\]/gu,
    observable: "claude-placeholder",
  };
}

function inspectObservation(probe: VerificationProbe, screen: string): Observation {
  const now = observableCounts(screen, probe);

  // Net count deltas are not proof: a redraw can remove one old placeholder
  // while two new ones appear. Require an observable-free baseline and exact
  // absolute post-paste cardinality so disappearance can never mask duplicates.
  if (
    probe.baseline.literal !== 0 || probe.baseline.expectedPlaceholder !== 0 ||
    probe.baseline.anyPlaceholder !== 0
  ) {
    return { state: "ambiguous" };
  }
  if (now.literal > 1 || now.expectedPlaceholder > 1 || now.anyPlaceholder > 1) {
    return { state: "ambiguous" };
  }
  if (now.literal === 1 && now.anyPlaceholder === 0) {
    return { state: "verified", observable: "literal" };
  }
  if (now.literal > 0 && now.anyPlaceholder > 0) {
    return { state: "ambiguous" };
  }
  if (now.anyPlaceholder === 0 && now.expectedPlaceholder === 0) {
    return { state: "pending" };
  }
  if (
    probe.placeholderObservable === null ||
    now.anyPlaceholder !== 1 ||
    now.expectedPlaceholder !== 1
  ) {
    return { state: "ambiguous" };
  }
  return { state: "verified", observable: probe.placeholderObservable };
}

export class TmuxAdapter implements MuxAdapter {
  /** ["tmux", ...socket/config flags] prepended to every invocation. */
  private readonly baseArgv: readonly string[];
  private readonly environment: Record<string, string | undefined>;
  private readonly verificationTimeoutMs: number;
  private readonly verificationPollMs: number;
  private readonly verificationSettleMs: number;

  constructor(opts: TmuxAdapterOptions = {}) {
    const argv = ["tmux"];
    if (opts.socketName !== undefined) argv.push("-L", opts.socketName);
    if (opts.configFile !== undefined) argv.push("-f", opts.configFile);
    this.baseArgv = argv;
    this.environment = { ...process.env, ...opts.environment };
    this.verificationTimeoutMs = opts.verificationTimeoutMs ?? VERIFY_TIMEOUT_MS;
    this.verificationPollMs = opts.verificationPollMs ?? VERIFY_POLL_MS;
    this.verificationSettleMs = opts.verificationSettleMs ?? VERIFY_SETTLE_MS;
  }

  /** Run tmux, never throwing on a non-zero exit. */
  private async run(args: string[], stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn({
      // tmux consumes one escape before a trailing literal semicolon.
      cmd: [...this.baseArgv, ...args.map((arg) => arg.replace(/;$/u, "\\;"))],
      env: this.environment,
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

  async setSessionMarker(session: string, value: string): Promise<void> {
    const target = await this.sessionId(session);
    await this.exec(["set-option", "-t", target, SESSION_MARKER_OPTION, value]);
  }

  async getSessionMarker(session: string): Promise<string | null> {
    const target = await this.sessionId(session);
    const r = await this.run([
      "show-options",
      "-v",
      "-t",
      target,
      SESSION_MARKER_OPTION,
    ]);
    if (r.exitCode !== 0) return null;
    const value = r.stdout.trim();
    return value.length > 0 ? value : null;
  }

  /** Resolve an exact session name to tmux's unambiguous `$N` id. */
  private async sessionId(session: string): Promise<string> {
    return (
      await this.exec([
        "display-message",
        "-p",
        "-t",
        exactWindow(session),
        "#{session_id}",
      ])
    ).trim();
  }

  /** Resolve the pinned window; never infer ownership from the current window. */
  private async managedWindowTarget(session: string): Promise<string> {
    const sessionId = await this.sessionId(session);
    const stored = await this.run([
      "show-options",
      "-v",
      "-t",
      sessionId,
      MANAGED_WINDOW_OPTION,
    ]);
    if (stored.exitCode !== 0 || stored.stdout.trim().length === 0) {
      throw new Error(
        `tmux session ${JSON.stringify(session)} has no managed window identity`,
      );
    }

    const windowId = stored.stdout.trim();
    if (!/^@\d+$/u.test(windowId)) {
      throw new Error(
        `tmux session ${JSON.stringify(session)} has invalid managed window id ${JSON.stringify(windowId)}`,
      );
    }
    const identity = (
      await this.exec([
        "display-message",
        "-p",
        "-t",
        windowId,
        "#{session_id}:#{window_id}",
      ])
    ).trim();
    if (identity !== `${sessionId}:${windowId}`) {
      throw new Error(
        `tmux managed window ${windowId} no longer belongs to session ${JSON.stringify(session)}`,
      );
    }
    const marker = await this.run([
      "show-options",
      "-w",
      "-v",
      "-t",
      windowId,
      MANAGED_WINDOW_MARKER_OPTION,
    ]);
    if (marker.exitCode !== 0 || marker.stdout.trim() !== sessionId) {
      throw new Error(
        `tmux managed window ${windowId} is not reciprocally marked for session ${JSON.stringify(session)}`,
      );
    }
    return windowId;
  }

  async createSession(
    session: string,
    opts: { cwd: string; width?: number; height?: number; command?: readonly string[] },
  ): Promise<string> {
    // tmux silently rewrites '.' and ':' in session names; accepting that
    // would create a session that exact-match targets can never address.
    if (session.length === 0 || /[.:\s]/.test(session)) {
      throw new Error(
        `tmux session names must not contain '.', ':' or whitespace: ${JSON.stringify(session)}`,
      );
    }
    const args = ["new-session", "-d", "-s", session, "-c", opts.cwd];
    if (opts.width !== undefined) args.push("-x", String(opts.width));
    if (opts.height !== undefined) args.push("-y", String(opts.height));
    args.push("-P", "-F", "#{pane_id}", ...paneCommand(opts.command));
    const paneId = (await this.exec(args)).trim();
    try {
      if (opts.command !== undefined) {
        await this.exec(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
      }
      const windowId = (
        await this.exec([
          "display-message",
          "-p",
          "-t",
          paneId,
          "#{window_id}",
        ])
      ).trim();
      if (!/^@\d+$/u.test(windowId)) {
        throw new Error(
          `tmux returned invalid managed window id ${JSON.stringify(windowId)}`,
        );
      }
      const target = await this.sessionId(session);
      await this.exec([
        "set-option",
        "-w",
        "-t",
        windowId,
        MANAGED_WINDOW_MARKER_OPTION,
        target,
      ]);
      await this.exec([
        "set-option",
        "-t",
        target,
        MANAGED_WINDOW_OPTION,
        windowId,
      ]);
      return paneId;
    } catch (error) {
      // Do not leave an unpinned bridge session behind after partial creation.
      await this.run(["kill-session", "-t", exact(session)]);
      throw error;
    }
  }

  async splitPane(session: string, opts: { cwd: string; command?: readonly string[] }): Promise<string> {
    const command = paneCommand(opts.command);
    const window = await this.managedWindowTarget(session);
    const out = await this.exec([
      "split-window",
      "-t",
      window,
      "-c",
      opts.cwd,
      "-P",
      "-F",
      "#{pane_id}",
      ...command,
    ]);
    const paneId = out.trim();
    if (opts.command !== undefined) {
      await this.exec(["set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
    }
    return paneId;
  }

  async selectLayout(
    session: string,
    layout: "tiled" | "even-horizontal" | "even-vertical",
  ): Promise<void> {
    const window = await this.managedWindowTarget(session);
    await this.exec(["select-layout", "-t", window, layout]);
  }

  async listPanes(session: string): Promise<PaneInfo[]> {
    const separator = paneSeparator();
    const window = await this.managedWindowTarget(session);
    const out = await this.exec([
      "list-panes",
      "-t",
      window,
      "-F",
      PANE_FIELDS.join(separator),
    ]);
    const panes: PaneInfo[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      panes.push(parsePaneLine(line, separator));
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

  async waitForShellReady(paneId: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Any drawn character means the shell got as far as its prompt. Input
      // pasted before this point is echoed by the tty but lost to the shell.
      if (/\S/.test(await this.capturePane(paneId))) return true;
      if (Date.now() >= deadline) return false;
      await Bun.sleep(VERIFY_POLL_MS);
    }
  }

  async sendText(
    paneId: string,
    text: string,
    opts?: SendTextOptions,
  ): Promise<SendResult> {
    if (opts?.verify === false && opts.verification !== undefined) {
      throw new Error("sendText cannot combine verify:false with a verification policy");
    }
    const verify = opts?.verify !== false;
    const policy: PasteVerification = opts?.verification ?? { mode: "literal" };
    let probe: VerificationProbe | null = null;
    if (verify) {
      const fragment = verifyFragment(text);
      const placeholder = policy.mode === "native-tui"
        ? nativePlaceholderPatterns(policy.agentKind, text)
        : null;
      const partial: Omit<VerificationProbe, "baseline"> = {
        fragment,
        placeholderObservable: placeholder?.observable ?? null,
        expectedPlaceholder: placeholder?.expected ?? null,
        anyPlaceholder: placeholder?.any ?? null,
      };
      probe = {
        ...partial,
        baseline: observableCounts(await this.captureJoined(paneId), partial),
      };
    }

    let retried = false;
    await this.paste(paneId, text);

    let observation: Observation = verify ? { state: "pending" } : {
      state: "verified",
      observable: "literal",
    };
    if (probe !== null) {
      observation = await this.verifyObservation(paneId, probe);
      if (observation.state === "pending") {
        // Retry only the capture/verification window. A second paste could
        // race a delayed first echo and leave two packets under one Enter.
        retried = true;
        observation = await this.verifyObservation(paneId, probe);
      }
    }

    const verified = verify && observation.state === "verified";
    const ok = verify ? verified : true;
    const observable = verified && observation.state === "verified"
      ? observation.observable
      : null;
    const failure: SendFailure | null = !verify || verified
      ? null
      : observation.state === "ambiguous"
      ? "ambiguous-observable"
      : "verification-timeout";

    // Single trailing Enter, only after the one paste is proven to have landed.
    if (ok && opts?.submit === true) {
      await opts.beforeSubmit?.();
      await this.exec(["send-keys", "-t", paneId, "Enter"]);
    }
    return { ok, verified, retried, observable, failure };
  }

  async focusPane(_session: string, paneId: string): Promise<void> {
    // Pane ids are server-global; they resolve the window too.
    await this.exec(["select-window", "-t", paneId]);
    await this.exec(["select-pane", "-t", paneId]);
  }

  async setPaneAgentId(paneId: string, agentId: string): Promise<void> {
    await this.exec([
      "set-option",
      "-p",
      "-t",
      paneId,
      PANE_AGENT_ID_OPTION,
      agentId,
    ]);
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
   * bracketed-paste codes when the pane's application requested them; -r
   * preserves the packet's LF bytes instead of tmux's default LF -> CR
   * translation; -d deletes the buffer after pasting.
   */
  private async paste(paneId: string, text: string): Promise<void> {
    const buf = `bridge-${process.pid}-${Date.now()}-${bufferSeq++}`;
    await this.exec(["load-buffer", "-b", buf, "-"], text);
    try {
      const loaded = await this.exec(["show-buffer", "-b", buf]);
      if (loaded !== text) {
        throw new Error("tmux buffer content differed from the requested paste bytes");
      }
      await this.exec(["paste-buffer", "-d", "-p", "-r", "-b", buf, "-t", paneId]);
    } catch (error) {
      // Successful paste-buffer -d already removed it; otherwise clean up the
      // uniquely owned buffer before propagating the failure.
      await this.run(["delete-buffer", "-b", buf]);
      throw error;
    }
  }

  /** capture-pane with -J so a paste wrapped across pane-width lines rejoins. */
  private async captureJoined(paneId: string): Promise<string> {
    return this.exec(["capture-pane", "-p", "-J", "-t", paneId]);
  }

  /** Poll until one expected delta remains exact across a short redraw window. */
  private async verifyObservation(
    paneId: string,
    probe: VerificationProbe,
  ): Promise<Observation> {
    const deadline = Date.now() + this.verificationTimeoutMs;
    let exactSince: number | null = null;
    for (;;) {
      const observation = inspectObservation(
        probe,
        await this.captureJoined(paneId),
      );
      const now = Date.now();
      if (observation.state === "ambiguous") return observation;
      if (observation.state === "verified") {
        exactSince ??= now;
        if (now - exactSince >= this.verificationSettleMs) return observation;
      } else {
        exactSince = null;
        if (now >= deadline) return observation;
      }
      // Once the exact delta appears, allow its settle window to finish even
      // if it began just before the ordinary polling deadline.
      if (exactSince === null && now >= deadline) return { state: "pending" };
      await Bun.sleep(this.verificationPollMs);
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
