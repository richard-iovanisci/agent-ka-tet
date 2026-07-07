import type { BridgeConfig } from "../config.ts";
import type { AgentName, NormalizedEvent, StatusResponse } from "../types.ts";
import { isAgentName } from "../types.ts";
import { mapNativeEvent } from "../adapters/mappers.ts";
import { openStore } from "./store.ts";
import { createRegistry } from "./registry.ts";

/**
 * Daemon HTTP surface: event ingest (agents' hooks POST here) plus the
 * status/history read API `bridge top` consumes. Binds 127.0.0.1 only —
 * CLAUDE.md constraint 4, hard-coded on purpose.
 *
 * Ingest etiquette: hook handlers run inside the agents' own flows, so a
 * well-formed request must ALWAYS get a fast 2xx — any processing error is
 * logged and swallowed, never surfaced to the agent (CLAUDE.md constraint 1).
 */

export interface DaemonHandle {
  port: number;
  stop(): Promise<void>;
  /**
   * Shared append/apply path for non-HTTP sources (the OpenCode SSE
   * subscriber): store the event, fold it into the registry, log it.
   * Never throws.
   */
  ingest(event: NormalizedEvent): void;
}

const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startDaemon(
  cfg: BridgeConfig,
  opts?: { port?: number; dbPath?: string },
): DaemonHandle {
  const store = openStore(opts?.dbPath ?? cfg.db);
  const registry = createRegistry(cfg);
  const startedAt = Date.now();

  function ingest(event: NormalizedEvent): void {
    try {
      store.append(event);
      const status = registry.apply(event);
      console.log(
        `[event] agent=${event.agent} type=${event.type} native=${event.payload.nativeType} state=${status.state}`,
      );
    } catch (err) {
      console.error(`[event] ingest error for ${event.agent}: ${String(err)}`);
    }
  }

  // Declared before Bun.serve so the fetch closure can reference it with a
  // plain `number` type; assigned immediately after the (synchronous) bind,
  // long before any request can arrive.
  let boundPort = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1", // localhost only — never make this configurable
    port: opts?.port ?? cfg.daemonPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // POST /events/:agent — hook/shim ingest.
      if (req.method === "POST" && path.startsWith("/events/")) {
        const agent = path.slice("/events/".length);
        if (!isAgentName(agent)) {
          return json({ ok: false, error: `unknown agent "${agent}"` }, 400);
        }
        let body: unknown = {};
        try {
          body = await req.json();
        } catch {
          // Invalid/absent JSON: record anyway; the mapper degrades to "raw".
          body = {};
        }
        const nativeHint = url.searchParams.get("native") ?? undefined;
        try {
          ingest(mapNativeEvent(agent, body, nativeHint));
        } catch (err) {
          // Belt and braces: nothing past the agent-name check may 4xx/5xx.
          console.error(`[event] handler error for ${agent}: ${String(err)}`);
        }
        return json({ ok: true });
      }

      if (req.method === "GET" && path === "/status") {
        const response: StatusResponse = {
          daemon: { startedAt, port: boundPort, pid: process.pid },
          agents: registry.snapshot(),
        };
        return json(response);
      }

      if (req.method === "GET" && path === "/events") {
        let agent: AgentName | undefined;
        const agentParam = url.searchParams.get("agent");
        if (agentParam !== null && agentParam !== "") {
          if (!isAgentName(agentParam)) {
            return json({ ok: false, error: `unknown agent "${agentParam}"` }, 400);
          }
          agent = agentParam;
        }
        let limit = DEFAULT_EVENTS_LIMIT;
        const limitParam = url.searchParams.get("limit");
        if (limitParam !== null && limitParam !== "") {
          const parsed = Number.parseInt(limitParam, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.min(parsed, MAX_EVENTS_LIMIT);
          }
        }
        return json(store.recent({ agent, limit }));
      }

      if (req.method === "GET" && path === "/healthz") {
        return json({ ok: true });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  });

  // Server.port is `number | undefined` only because unix sockets exist;
  // we always bind TCP on 127.0.0.1, so undefined here is a bug.
  if (server.port === undefined) {
    store.close();
    throw new Error("daemon did not bind a TCP port on 127.0.0.1");
  }
  boundPort = server.port;

  return {
    port: boundPort,
    ingest,
    async stop(): Promise<void> {
      await server.stop(true);
      store.close();
    },
  };
}
