import { afterAll, describe, expect, test } from "bun:test";
import type { NormalizedEvent } from "../types.ts";
import { subscribeOpencode } from "./opencodeSse.ts";

/**
 * Real SSE fixture server via Bun.serve on 127.0.0.1, ephemeral port.
 * Connection 1 delivers three events then closes mid-stream (simulating the
 * OpenCode TUI restarting); the subscriber must reconnect (1s backoff after a
 * delivering connection) and pick up the remaining events on connection 2,
 * which stays open until teardown.
 */

const encoder = new TextEncoder();

function frame(obj: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

let connections = 0;

const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/event") return new Response("not found", { status: 404 });
    connections += 1;
    const conn = connections;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (conn === 1) {
          controller.enqueue(frame({ id: "evt_1", type: "server.connected", properties: {} }));
          controller.enqueue(
            frame({ id: "evt_2", type: "session.status", properties: { sessionID: "ses1", status: { type: "busy" } } }),
          );
          controller.enqueue(
            frame({
              id: "evt_3",
              type: "permission.asked",
              properties: { id: "per1", sessionID: "ses1", permission: "bash", patterns: ["*"] },
            }),
          );
          controller.close(); // drop the stream mid-way; server stays up
        } else {
          controller.enqueue(encoder.encode(": keepalive comment, must be ignored\n\n"));
          controller.enqueue(
            frame({
              id: "evt_4",
              type: "permission.replied",
              properties: { sessionID: "ses1", requestID: "per1", reply: "once" },
            }),
          );
          controller.enqueue(frame({ id: "evt_5", type: "session.idle", properties: { sessionID: "ses1" } }));
          // stays open until the server is stopped
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

const fixturePort = fixture.port;
if (fixturePort === undefined) throw new Error("fixture server did not bind a TCP port");

afterAll(async () => {
  await fixture.stop(true);
});

describe("opencode SSE subscriber", () => {
  test(
    "maps the event stream and survives a mid-stream disconnect",
    async () => {
      const events: NormalizedEvent[] = [];
      let finish: (() => void) | undefined;
      const gotAll = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const sub = subscribeOpencode({
        port: fixturePort,
        onEvent: (e) => {
          events.push(e);
          if (events.length === 5) finish?.();
        },
      });

      try {
        await gotAll;
      } finally {
        sub.stop();
      }

      // The reconnect actually happened (fixture served two connections).
      expect(connections).toBeGreaterThanOrEqual(2);

      expect(events.map((e) => e.type)).toEqual([
        "raw", //                 server.connected — stored, no transition
        "turn.start", //          session.status busy
        "permission.request", //  permission.asked
        "permission.resolved", // permission.replied (after reconnect)
        "turn.complete", //       session.idle
      ]);
      expect(events.every((e) => e.agent === "opencode")).toBe(true);
      expect(events.map((e) => e.payload.nativeType)).toEqual([
        "server.connected",
        "session.status:busy",
        "permission.asked",
        "permission.replied",
        "session.idle",
      ]);
      expect(events[1]?.sessionId).toBe("ses1");
      expect(events[4]?.sessionId).toBe("ses1");
    },
    { timeout: 7500 },
  );

  test("stop() before any server exists never throws and cancels the retry loop", async () => {
    // Port from the fixture's URL space but nothing listening: connection fails,
    // the subscriber schedules a retry, and stop() must tear it down silently.
    const logs: string[] = [];
    const sub = subscribeOpencode({
      port: 1, // reserved port, nothing listens here
      onEvent: () => {
        throw new Error("no events expected");
      },
      onLog: (line) => logs.push(line),
    });
    await Bun.sleep(50); // let the first connection attempt fail
    sub.stop();
    await Bun.sleep(20);
    expect(logs.some((l) => l.includes("connection failed"))).toBe(true);
  });
});
