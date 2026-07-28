import { realpathSync } from "node:fs";
import { configFingerprint, type BridgeConfig } from "../config.ts";
import type { AgentId, NormalizedEvent, StatusResponse } from "../types.ts";
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
   * Shared append/apply path: store the event, fold it into the registry,
   * and log it. Exposed for focused integration tests and future adapters.
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

function canonicalCwd(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
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
      // Reject invalid instance/kind pairs before the append-only store is
      // touched. HTTP ingress normally derives identity from config, but the
      // public handle is also used by future in-process adapter feeds.
      registry.validate(event);
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

      // POST /events/:agentId — native hook ingest. The configured instance
      // supplies the adapter kind used for normalization.
      if (req.method === "POST" && path.startsWith("/events/")) {
        const agentId = path.slice("/events/".length);
        const agent = cfg.agents.find(
          (configured) => configured.id === agentId && configured.enabled,
        );
        if (agent === undefined) {
          return json({ ok: false, error: `unknown or disabled agent "${agentId}"` }, 400);
        }
        let body: unknown = {};
        try {
          body = await req.json();
        } catch {
          // The hook still receives an empty 2xx below, but untrusted payloads
          // without a verifiable cwd never reach the store/state machine.
          body = {};
        }
        const nativeCwdValue =
          typeof body === "object" && body !== null && !Array.isArray(body) &&
          "cwd" in body
            ? (body as Record<string, unknown>).cwd
            : null;
        const nativeCwd = canonicalCwd(nativeCwdValue);
        const expectedCwdValue = agent.cwd ?? cfg.repo;
        const expectedCwd = canonicalCwd(expectedCwdValue);
        // Both native hook contracts include cwd. Fail closed if it is absent,
        // malformed, missing on disk, or from another repo. realpath handles a
        // pane entered through a symlink without weakening target isolation.
        if (nativeCwd === null || expectedCwd === null || nativeCwd !== expectedCwd) {
          console.warn(
            `[event] ignored agent=${agent.id} from cwd=${typeof nativeCwdValue === "string" ? nativeCwdValue : "<missing-or-invalid>"}; expected ${expectedCwdValue}`,
          );
          return new Response(null, { status: 204 });
        }
        try {
          ingest(mapNativeEvent({ id: agent.id, kind: agent.kind }, body));
        } catch (err) {
          // Belt and braces: nothing past the agent-name check may 4xx/5xx.
          console.error(`[event] handler error for ${agent.id}: ${String(err)}`);
        }
        // Claude HTTP hooks define an empty 2xx as the no-op success. An
        // arbitrary JSON body is parsed as hook output and may be rejected.
        return new Response(null, { status: 204 });
      }

      if (req.method === "GET" && path === "/status") {
        const response: StatusResponse = {
          daemon: {
            startedAt,
            port: boundPort,
            pid: process.pid,
            configDir: cfg.configDir,
            sourceRoot: cfg.sourceRoot,
            sourceFingerprint: cfg.sourceFingerprint,
            configFingerprint: configFingerprint(cfg),
          },
          agents: registry.snapshot(),
        };
        return json(response);
      }

      if (req.method === "GET" && path === "/events") {
        let agent: AgentId | undefined;
        const agentParam = url.searchParams.get("agent");
        if (agentParam !== null && agentParam !== "") {
          if (!cfg.agents.some((configured) => configured.id === agentParam)) {
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
