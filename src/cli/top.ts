import type { BridgeConfig } from "../config.ts";
import type { AgentState, StatusResponse } from "../types.ts";
import { daemonMatchesConfig, fetchDaemonStatus } from "./daemonClient.ts";

/**
 * `bridge top` — single-pane ANSI board. State comes from daemon events,
 * never from scraping; polling the daemon over HTTP is fine for v0
 * (HANDOFF.md build order #7).
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const STATE_STYLE: Record<AgentState, { color: string; label: string }> = {
  launching: { color: "\x1b[90m", label: "launching" },
  working: { color: "\x1b[33m", label: "working  " },
  idle: { color: "\x1b[32m", label: "idle     " },
  needs_you: { color: "\x1b[31m", label: "NEEDS YOU" },
  done: { color: "\x1b[34m", label: "done     " },
  error: { color: "\x1b[41m\x1b[97m", label: "ERROR    " },
};

export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function renderBoard(status: StatusResponse, now: number): string {
  const lines: string[] = [];
  lines.push(
    `${BOLD}agent-bridge${RESET} ${DIM}· daemon 127.0.0.1:${status.daemon.port} pid ${status.daemon.pid} · q quits${RESET}`,
  );
  lines.push("");

  const nameWidth = Math.max(8, ...status.agents.map((agent) => agent.agent.length));
  for (const a of status.agents) {
    const name = a.agent;
    const kind = a.agent === a.kind ? "" : ` ${DIM}(${a.kind})${RESET}`;
    if (!a.enabled) {
      lines.push(`  ${DIM}○ ${name.padEnd(nameWidth)} disabled${RESET}${kind}`);
      continue;
    }
    const style = STATE_STYLE[a.state];
    const badge = a.pendingPermission !== null ? `  ${BOLD}\x1b[31m⚠ ${a.pendingPermission}${RESET}` : "";
    const displayedEvent =
      a.state === "needs_you"
        ? (a.activeAttention ?? a.lastEvent)
        : a.lastEvent;
    const last =
      displayedEvent === null
        ? a.kind === "codex" && a.state === "launching"
          ? `${DIM}awaiting first observed turn${RESET}`
          : `${DIM}no events yet${RESET}`
        : `${displayedEvent.nativeType} ${DIM}${formatAge(now - displayedEvent.ts)} ago${RESET}`;
    const sess = a.sessionId !== null ? ` ${DIM}sess ${a.sessionId.slice(0, 8)}${RESET}` : "";
    lines.push(`  ● ${BOLD}${name.padEnd(nameWidth)}${RESET}${kind} ${style.color}${style.label}${RESET}  ${last}${sess}${badge}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderUnreachable(cfg: BridgeConfig): string {
  return [
    `${BOLD}agent-bridge${RESET} ${DIM}· q quits${RESET}`,
    "",
    `  \x1b[31mdaemon unreachable at 127.0.0.1:${cfg.daemonPort}${RESET}`,
    `  ${DIM}start it with \`bridge up\` — agents are unaffected either way${RESET}`,
    "",
  ].join("\n");
}

export function renderMismatch(cfg: BridgeConfig): string {
  return [
    `${BOLD}agent-bridge${RESET} ${DIM}· q quits${RESET}`,
    "",
    `  \x1b[31mport ${cfg.daemonPort} belongs to another or stale bridge configuration${RESET}`,
    `  ${DIM}refusing to display another target repo's state${RESET}`,
    "",
  ].join("\n");
}

export async function fetchStatus(port: number): Promise<StatusResponse | null> {
  return fetchDaemonStatus(port);
}

export interface TopOptions {
  print?: (s: string) => void;
  /** Render one frame without the alt screen and return (tests / scripting). */
  once?: boolean;
  intervalMs?: number;
}

export async function top(cfg: BridgeConfig, opts: TopOptions = {}): Promise<number> {
  const write = opts.print ?? ((s: string) => process.stdout.write(s));

  if (opts.once) {
    const status = await fetchStatus(cfg.daemonPort);
    const frame = status === null
      ? renderUnreachable(cfg)
      : daemonMatchesConfig(status, cfg)
        ? renderBoard(status, Date.now())
        : renderMismatch(cfg);
    write(frame + "\n");
    return status !== null && daemonMatchesConfig(status, cfg) ? 0 : 1;
  }

  const interval = opts.intervalMs ?? 1000;
  let running = true;
  const stdin = process.stdin;
  const canRaw = stdin.isTTY === true;
  const onKey = (chunk: Buffer) => {
    const c = chunk.toString();
    if (c === "q" || c === "\x03") running = false;
  };
  if (canRaw) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
  }
  const cleanup = () => {
    if (canRaw) {
      stdin.setRawMode(false);
      stdin.off("data", onKey);
      stdin.pause();
    }
    write("\x1b[?1049l\x1b[?25h"); // leave alt screen, show cursor
  };

  write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
  try {
    while (running) {
      const status = await fetchStatus(cfg.daemonPort);
      const frame = status === null
        ? renderUnreachable(cfg)
        : daemonMatchesConfig(status, cfg)
          ? renderBoard(status, Date.now())
          : renderMismatch(cfg);
      write(`\x1b[H\x1b[2J${frame}`);
      const deadline = Date.now() + interval;
      while (running && Date.now() < deadline) await Bun.sleep(50);
    }
  } finally {
    cleanup();
  }
  return 0;
}
