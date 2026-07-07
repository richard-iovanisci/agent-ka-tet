import type { NormalizedEvent } from "../types.ts";
import { mapOpencodeEvent } from "../adapters/mappers.ts";

/**
 * SSE client for OpenCode's /event bus (DESIGN.md §2, §4). The OpenCode TUI
 * always runs a local HTTP server; we subscribe to its event stream and feed
 * mapped events into the daemon's ingest path.
 *
 * Parser is a deliberate subset of the SSE spec: "data:" lines accumulate per
 * event (joined with \n), a blank line dispatches, ":" comment lines and all
 * other fields (event:, id:, retry:) are ignored — OpenCode only sends JSON
 * data frames.
 *
 * Reconnects forever with exponential backoff (1s, 2s, 4s … 30s cap), reset
 * to 1s after any connection that delivered at least one byte. The subscriber
 * loop never throws: OpenCode restarting must never take the daemon down.
 */

export interface OpencodeSseOptions {
  /** OpenCode's pinned server port (cfg.opencodePort). */
  port: number;
  onEvent: (e: NormalizedEvent) => void;
  onLog?: (line: string) => void;
}

export interface OpencodeSubscription {
  stop(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function subscribeOpencode(opts: OpencodeSseOptions): OpencodeSubscription {
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;

  const log = (line: string): void => {
    try {
      opts.onLog?.(line);
    } catch {
      // onLog must never break the loop
    }
  };

  const dispatch = (data: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      log("[opencode-sse] skipped non-JSON data frame");
      return;
    }
    try {
      opts.onEvent(mapOpencodeEvent(parsed));
    } catch (err) {
      log(`[opencode-sse] onEvent error: ${String(err)}`);
    }
  };

  /** One connection lifetime. Marks `delivered` as soon as any byte arrives. */
  const connectOnce = async (delivered: { value: boolean }): Promise<void> => {
    controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${opts.port}/event`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok || res.body === null) {
      throw new Error(`GET /event responded ${res.status}`);
    }
    log(`[opencode-sse] connected to 127.0.0.1:${opts.port}/event`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let dataLines: string[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) delivered.value = true;
      buffered += decoder.decode(value, { stream: true });

      for (;;) {
        const nl = buffered.indexOf("\n");
        if (nl === -1) break;
        let line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          if (dataLines.length > 0) {
            dispatch(dataLines.join("\n"));
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keepalive
        if (line.startsWith("data:")) {
          let v = line.slice("data:".length);
          if (v.startsWith(" ")) v = v.slice(1);
          dataLines.push(v);
        } else if (line === "data") {
          dataLines.push("");
        }
        // any other field: ignored by design
      }
    }
  };

  /** Cancellable sleep — stop() wakes it immediately. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const finish = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        wake = null;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, ms);
    });

  const loop = async (): Promise<void> => {
    let backoffMs = INITIAL_BACKOFF_MS;
    while (!stopped) {
      const delivered = { value: false };
      try {
        await connectOnce(delivered);
        log("[opencode-sse] stream ended");
      } catch (err) {
        if (!stopped) log(`[opencode-sse] connection failed: ${String(err)}`);
      }
      if (stopped) return;
      if (delivered.value) backoffMs = INITIAL_BACKOFF_MS;
      const wait = backoffMs;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      log(`[opencode-sse] reconnecting in ${wait}ms`);
      await sleep(wait);
    }
  };

  // Fire and forget; loop() catches everything, this catch is unreachable
  // insurance so nothing can ever escape as an unhandled rejection.
  void loop().catch((err) => log(`[opencode-sse] loop error: ${String(err)}`));

  return {
    stop(): void {
      stopped = true;
      wake?.();
      controller?.abort();
      controller = null;
    },
  };
}
