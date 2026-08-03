import { configFingerprint, type BridgeConfig } from "../config.ts";
import type { StoredEvent } from "../daemon/store.ts";
import type { AgentId } from "../types.ts";
import type { StatusResponse } from "../types.ts";

/** Read a bridge-shaped status document from a loopback daemon. */
export async function fetchDaemonStatus(port: number): Promise<StatusResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(900),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const daemon = (body as { daemon?: unknown }).daemon;
    if (typeof daemon !== "object" || daemon === null || Array.isArray(daemon)) return null;
    return body as StatusResponse;
  } catch {
    return null;
  }
}

/** Read newest-first persisted events from the loopback daemon. */
export async function fetchRecentEvents(
  port: number,
  agent: AgentId,
  limit = 500,
): Promise<StoredEvent[] | null> {
  try {
    const params = new URLSearchParams({ agent, limit: String(limit) });
    const res = await fetch(`http://127.0.0.1:${port}/events?${params}`, {
      signal: AbortSignal.timeout(900),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return null;
    return body as StoredEvent[];
  } catch {
    return null;
  }
}

/** Same target repo, even if its config file has changed since daemon start. */
export function daemonBelongsToConfig(status: StatusResponse, cfg: BridgeConfig): boolean {
  return (
    status.daemon.configDir === cfg.configDir &&
    typeof status.daemon.configFingerprint === "string" &&
    status.daemon.configFingerprint.length > 0
  );
}

/** Exact loaded configuration, required before reusing a running daemon. */
export function daemonMatchesConfig(status: StatusResponse, cfg: BridgeConfig): boolean {
  return (
    daemonBelongsToConfig(status, cfg) &&
    status.daemon.configFingerprint === configFingerprint(cfg)
  );
}
