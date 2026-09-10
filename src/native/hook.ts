import { Readable } from "node:stream";
import { bridgeConnection } from "./mcp.ts";

export const MAX_HOOK_BYTES = 256 * 1024;
export const HOOK_DEADLINE_MS = 650;

export async function forwardHook(
  options: {
    input?: Readable;
    env?: Record<string, string | undefined>;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const connection = bridgeConnection(options.env ?? process.env);
  if (!connection) return;
  const abort = new AbortController();
  let expire: () => void = () => {};
  const deadline = new Promise<void>((resolve) => {
    expire = resolve;
  });
  const timer = setTimeout(
    () => {
      abort.abort();
      expire();
    },
    Math.min(options.timeoutMs ?? HOOK_DEADLINE_MS, HOOK_DEADLINE_MS),
  );
  let cleanup = () => {};
  try {
    await Promise.race([
      deadline,
      (async () => {
        const body = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const onData = (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > MAX_HOOK_BYTES) {
              cleanup();
              reject(new Error("Hook input exceeds size limit"));
              return;
            }
            chunks.push(bytes);
          };
          const onEnd = () => {
            cleanup();
            resolve(Buffer.concat(chunks));
          };
          const onError = () => {
            cleanup();
            reject(new Error("Hook input unavailable"));
          };
          cleanup = () => {
            input.off("data", onData);
            input.off("end", onEnd);
            input.off("error", onError);
            abort.signal.removeEventListener("abort", onError);
            input.pause();
          };
          input.on("data", onData);
          input.once("end", onEnd);
          input.once("error", onError);
          abort.signal.addEventListener("abort", onError, { once: true });
        });
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
        const response = await (options.fetch ?? fetch)(`${connection.url}/events`, {
          method: "POST",
          redirect: "error",
          signal: abort.signal,
          headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await response.body?.cancel();
      })(),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
    cleanup();
    abort.abort();
  }
}

if (import.meta.main) {
  await forwardHook();
  process.exit(0);
}
