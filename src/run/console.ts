import { stripVTControlCharacters } from "node:util";
import { loadPilot, type PilotConfig } from "../pilot/config.ts";
import type { MessageRecord, RuntimeAttempt } from "../coordination/types.ts";

type ConsoleAgent = Pick<
  RuntimeAttempt,
  "agentId" | "sessionId" | "ready" | "paused" | "revoked" | "exited"
> & {
  available?: boolean;
  routeReady?: boolean;
  activity?: unknown;
  attention?: unknown;
};

export interface ConsoleStatus {
  run?: { id: string; paused: boolean; expiresAt?: number } | null;
  serverNow?: number;
  startIntent?: {
    state: "submitting" | "accepted" | "ambiguous";
    requestId?: string;
    turnId?: string;
  } | null;
  agents: ConsoleAgent[];
  tasks?: Array<{
    id: string;
    title: string;
    state: string;
    version: number;
    artifact: { commit: string; summary: string } | null;
    reviewSummary: string | null;
  }>;
  messages: MessageRecord[];
}

export function terminalText(value: unknown, secrets: readonly string[] = []): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text = stripVTControlCharacters(String(value))
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .replace(/\p{Cf}/gu, "");
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text.slice(0, 4096).replace(/\s+/g, " ").trim();
}

function clipped(text: string, width: number): string {
  let result = "",
    used = 0;
  for (const char of text) {
    const size = char.codePointAt(0)! > 0x7e ? 2 : 1;
    if (used + size > width) return Array.from(result).slice(0, -1).join("") + "~";
    result += char;
    used += size;
  }
  return result;
}

function description(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as { summary?: unknown; kind?: unknown; state?: unknown };
    return item.summary ?? item.kind ?? item.state;
  }
  return "";
}

function exactFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function messageText(body: string): string {
  if (typeof body !== "string" || Buffer.byteLength(body) > 64 * 1024) return body;
  let notice: unknown;
  try {
    notice = JSON.parse(body);
  } catch {
    return body;
  }
  const summary = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 4096;
  if (
    !exactFields(notice, ["type", "taskId", "state", "version", "artifact", "reviewSummary"]) ||
    notice.type !== "task_transition" ||
    typeof notice.taskId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(notice.taskId) ||
    typeof notice.state !== "string" ||
    !["review", "accepted", "changes_requested"].includes(notice.state) ||
    typeof notice.version !== "number" ||
    !Number.isSafeInteger(notice.version) ||
    notice.version < 1 ||
    !exactFields(notice.artifact, ["commit", "summary"]) ||
    typeof notice.artifact.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(notice.artifact.commit) ||
    !summary(notice.artifact.summary) ||
    (notice.state === "review" ? notice.reviewSummary !== null : !summary(notice.reviewSummary))
  )
    return body;
  const state = notice.state === "review" ? "ready for review" : notice.state.replaceAll("_", " ");
  return `Task ${state} v${notice.version} | commit ${notice.artifact.commit.slice(0, 8)} | ${notice.reviewSummary ?? notice.artifact.summary}`;
}

export function renderConsole(
  status: ConsoleStatus,
  selected: number,
  options: {
    width?: number;
    height?: number;
    notice?: string;
    connected?: boolean;
    secrets?: readonly string[];
    now?: number;
  } = {},
): string {
  const width = Math.max(1, Math.min(240, (options.width ?? 100) - 1));
  const height = Math.max(1, Math.min(100, (options.height ?? 30) - 1));
  const safe = (value: unknown) => terminalText(value, options.secrets);
  const validTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
  const now = validTime(status.serverNow) ? status.serverNow : validTime(options.now) ? options.now : Date.now();
  const expiresAt = status.run?.expiresAt;
  const expired = validTime(expiresAt) && expiresAt <= now;
  const lines = [
    `Agent Bridge | ${safe(status.run?.id ?? "native run")} | ${options.connected === false ? "coordinator unavailable; state unverified" : status.run?.paused ? "run paused" : "connected"}`,
  ];
  if (validTime(expiresAt))
    lines.push(`Run ${expired ? "EXPIRED" : "expires"} at ${new Date(expiresAt).toISOString()}`);
  const start = status.startIntent;
  lines.push(
    !start
      ? "Start: not submitted"
      : start.state === "accepted"
        ? `Start: accepted${start.turnId ? ` | turn ${safe(start.turnId).slice(0, 8)}` : ""}; no replay`
        : `Start: uncertain${start.state === "submitting" ? " (submitting)" : ""}; inspect existing start, no replay`,
  );
  for (const [index, agent] of status.agents.slice(0, 2).entries()) {
    const availability =
      options.connected === false
        ? "unknown"
        : agent.revoked
          ? "revoked"
          : agent.exited
            ? "exited"
            : agent.available === false
              ? "unavailable"
              : agent.available === true
                ? "available"
                : agent.sessionId
                  ? "bound"
                  : "awaiting session";
    const route =
      options.connected === false ? "unknown" : (agent.routeReady ?? agent.ready) ? "ready" : "held";
    lines.push(
      `${index === selected ? ">" : " "} ${safe(agent.agentId)} | ${availability} | route ${route} | paused ${agent.paused ? "yes" : "no"}`,
    );
    const activity = safe(description(agent.activity));
    const attention = safe(description(agent.attention));
    if (activity || attention)
      lines.push(
        `  ${[activity && `activity: ${activity}`, attention && `attention: ${attention}`].filter(Boolean).join(" | ")}`,
      );
  }
  lines.push("Tasks");
  const tasks = status.tasks ?? [];
  if (!tasks.length) lines.push("  No task recorded.");
  for (const task of tasks.slice(-3)) {
    lines.push(`  ${safe(task.state)} v${safe(task.version)} | ${safe(task.title)}`);
    if (task.artifact)
      lines.push(`  artifact ${safe(task.artifact.commit)} | ${safe(task.artifact.summary)}`);
    if (task.reviewSummary) lines.push(`  review: ${safe(task.reviewSummary)}`);
  }
  lines.push("Recent messages | transport / application");
  if (!status.messages.length) lines.push("  No messages recorded.");
  for (const { message, receipt } of status.messages.slice(-5).reverse()) {
    lines.push(
      `  ${safe(message.senderAgentId)} -> ${safe(message.recipientAgentId)} | ${safe(receipt.policy)}:${safe(receipt.state)} / ${safe(receipt.application)}`,
    );
    lines.push(`  ${safe(messageText(message.body))}`);
  }
  const footer = [
    "j/k or arrows select | Enter native TUI (pauses) | p pause | s start | q exit",
    expired
      ? "Resume/start unavailable: run expired. Enter attaches; p pauses; q exits."
      : "r resume: confirms native session and trust/tools are ready for peer input.",
    "Detach native TUI: Ctrl-b d. Agent stays paused until r. q leaves sessions running.",
    safe(options.notice ?? ""),
  ];
  const available = Math.max(0, height - footer.length);
  const visible = lines.slice(0, available);
  if (lines.length > available && available > 0) visible[available - 1] = "... more in run status";
  return [...visible, ...footer]
    .slice(-height)
    .map((line) => clipped(line, width))
    .join("\n");
}

interface ConsoleInput {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

interface ConsoleOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): unknown;
}

export interface ConsoleOptions {
  input: ConsoleInput;
  output: ConsoleOutput;
  signals: Pick<NodeJS.Process, "on" | "off">;
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
  attach(agentId: string): Promise<number>;
  intervalMs?: number;
}

export async function runConsoleSession(cfg: PilotConfig, options: ConsoleOptions): Promise<number> {
  const { input, output } = options;
  const secrets = [cfg.operatorToken, ...cfg.agents.map((agent) => agent.token)];
  let status: ConsoleStatus = {
    agents: cfg.agents.map((agent) => ({
      agentId: agent.id,
      sessionId: null,
      ready: false,
      paused: true,
      revoked: false,
      exited: false,
    })),
    messages: [],
  };
  let selected = 0,
    notice = "Checking coordinator...",
    connected = false;
  const frame = () =>
    renderConsole(status, selected, {
      width: output.columns,
      height: output.rows,
      notice,
      connected,
      secrets,
    });
  const readStatus = (value: unknown): ConsoleStatus => {
    const candidate = value as ConsoleStatus | null;
    if (
      !candidate ||
      !Array.isArray(candidate.agents) ||
      !Array.isArray(candidate.messages) ||
      candidate.agents.some((agent) => !agent || typeof agent.agentId !== "string") ||
      candidate.messages.some((record) => !record?.message || !record.receipt) ||
      (candidate.tasks !== undefined &&
        (!Array.isArray(candidate.tasks) ||
          candidate.tasks.some((task) => !task || typeof task !== "object")))
    )
      throw new Error("Invalid coordinator status");
    return {
      ...candidate,
      agents: cfg.agents.map(
        (agent, i) => candidate.agents.find((item) => item.agentId === agent.id) ?? status.agents[i]!,
      ),
    };
  };
  if (!input.isTTY || !output.isTTY) {
    try {
      status = readStatus(await options.request("/operator/status"));
      connected = true;
      notice = "Interactive controls require a terminal.";
      output.write(frame() + "\n");
      return 0;
    } catch {
      notice = "Coordinator unavailable. Native sessions continue independently.";
      output.write(frame() + "\n");
      return 1;
    }
  }

  const originalRaw = input.isRaw === true,
    originalPaused = input.isPaused();
  const lifetime = new AbortController();
  let poll: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = true,
    attached = false,
    busy = false,
    terminal = false;
  let escape = "",
    pasting = false,
    pasteTail = "";
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const paint = () => {
    if (active && !attached && terminal) output.write(`\x1b[H\x1b[2J${frame()}`);
  };
  const stopPolling = () => {
    clearInterval(timer);
    timer = undefined;
    poll?.abort();
  };
  const refresh = async () => {
    if (!active || attached || busy || poll) return;
    const controller = new AbortController();
    poll = controller;
    try {
      const next = readStatus(await options.request("/operator/status", undefined, controller.signal));
      if (!active || attached || controller.signal.aborted) return;
      const wasConnected = connected;
      status = next;
      connected = true;
      if (!wasConnected) notice = "Select an agent to inspect its native TUI.";
    } catch {
      if (!active || attached || controller.signal.aborted) return;
      connected = false;
      notice = "Coordinator unavailable. Native sessions continue independently.";
    } finally {
      if (poll === controller) poll = null;
      paint();
    }
  };
  const startPolling = () => {
    timer = setInterval(() => {
      void refresh();
    }, options.intervalMs ?? 1000);
    void refresh();
  };
  const leaveTerminal = (restore: boolean) => {
    input.off("data", onData);
    input.pause();
    input.setRawMode(restore ? originalRaw : false);
    if (terminal) output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
    terminal = false;
    if (restore && !originalPaused) input.resume();
  };
  const enterTerminal = () => {
    output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    terminal = true;
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
    paint();
  };
  const quit = (code = 0) => {
    if (!active) return;
    active = false;
    stopPolling();
    lifetime.abort();
    finish(code);
  };
  const act = async (key: string) => {
    if (busy || !active || attached) return;
    if (key === "s" && status.startIntent != null) {
      notice = "Start already recorded; inspect existing start. It will not be submitted again.";
      paint();
      return;
    }
    const agentId = cfg.agents[selected]!.id;
    busy = true;
    poll?.abort();
    try {
      if (key === "\r" || key === "\n") {
        attached = true;
        stopPolling();
        leaveTerminal(false);
        const code = await options.attach(agentId);
        notice =
          code === 0
            ? `${agentId} paused on native entry; r resumes peer input.`
            : "Native attach failed; delivery remains paused if the pause succeeded.";
      } else {
        notice =
          key === "p" ? `Pausing ${agentId}...` : key === "r" ? `Resuming ${agentId}...` : "Starting task...";
        paint();
        const result = await options.request(
          `/operator/${key === "p" ? "pause" : key === "r" ? "ready" : "start"}`,
          key === "s" ? {} : { agentId, ...(key === "r" ? { confirmNative: true } : {}) },
          lifetime.signal,
        );
        if (key === "s") {
          const receipt = result as { requestId?: unknown; turnId?: unknown } | null;
          status = {
            ...status,
            startIntent: {
              state: "accepted",
              ...(typeof receipt?.requestId === "string" ? { requestId: receipt.requestId } : {}),
              ...(typeof receipt?.turnId === "string" ? { turnId: receipt.turnId } : {}),
            },
          };
        }
        notice =
          key === "p"
            ? `${agentId} paused.`
            : key === "r"
              ? `${agentId} native readiness confirmed.`
              : "Task start accepted.";
      }
    } catch (error) {
      notice = `Action not confirmed; inspect state before retrying. ${terminalText(error instanceof Error ? error.message : "", secrets)}`;
    } finally {
      busy = false;
      if (attached) {
        attached = false;
        if (active) {
          enterTerminal();
          startPolling();
        }
      } else if (active) {
        paint();
        void refresh();
      }
    }
  };
  const key = (value: string) => {
    if (value === "q" || value === "\x04") quit();
    else if (value === "\x03") quit(130);
    else if (value === "j" || value === "\x1b[B") {
      selected = (selected + 1) % cfg.agents.length;
      paint();
    } else if (value === "k" || value === "\x1b[A") {
      selected = (selected + cfg.agents.length - 1) % cfg.agents.length;
      paint();
    } else if (["p", "r", "s", "\r", "\n"].includes(value)) void act(value);
  };
  function onData(chunk: Buffer | string) {
    const value = String(chunk);
    if (pasting) {
      const end = (pasteTail + value).includes("\x1b[201~");
      pasteTail = value.slice(-6);
      if (end) {
        pasting = false;
        pasteTail = "";
      }
      return;
    }
    const combined = escape + value;
    if (combined.startsWith("\x1b[200~")) {
      pasting = !combined.includes("\x1b[201~");
      pasteTail = combined.slice(-6);
      escape = "";
      return;
    }
    escape = combined.slice(0, 64);
    if (["\x1b", "\x1b[", "\x1b[2", "\x1b[20", "\x1b[200"].includes(escape)) return;
    key(escape);
    escape = "";
  }
  const onInterrupt = () => {
    if (!attached) quit(130);
  };
  const onTerminate = () => quit(143),
    onEnd = () => quit();
  input.on("end", onEnd);
  options.signals.on("SIGINT", onInterrupt);
  options.signals.on("SIGTERM", onTerminate);
  try {
    enterTerminal();
    startPolling();
    return await finished;
  } finally {
    active = false;
    stopPolling();
    lifetime.abort();
    input.off("end", onEnd);
    options.signals.off("SIGINT", onInterrupt);
    options.signals.off("SIGTERM", onTerminate);
    leaveTerminal(true);
  }
}

export async function runConsole(root: string): Promise<number> {
  const cfg = loadPilot(root);
  const [{ pilotMain }, { pilotRequest }] = await Promise.all([
    import("../pilot/cli.ts"),
    import("../pilot/server.ts"),
  ]);
  try {
    return await runConsoleSession(cfg, {
      input: process.stdin,
      output: process.stdout,
      signals: process,
      request: (path, body, signal) => pilotRequest(cfg, path, body, signal),
      attach: (agentId) => pilotMain(["attach", cfg.root, agentId]),
    });
  } finally {
    process.stdin.pause();
    process.stdin.unref?.();
  }
}
