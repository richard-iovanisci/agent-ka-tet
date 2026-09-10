import { expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { forwardHook, MAX_HOOK_BYTES } from "./hook.ts";

const env = { AGENT_BRIDGE_URL: "http://127.0.0.1:4771", AGENT_BRIDGE_TOKEN: "hook-attempt-secret" };

test("hook forwards exact native JSON with environment-only Bearer authentication", async () => {
  const payload = {
    hook_event_name: "SessionStart",
    session_id: "native-session",
    cwd: "/scratch/work",
    source: "startup",
  };
  let request: { url: string; init: RequestInit } | undefined;
  await forwardHook({
    input: Readable.from([Buffer.from(JSON.stringify(payload))]),
    env,
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(null, { status: 204 });
    },
  });
  expect(request!.url).toBe(`${env.AGENT_BRIDGE_URL}/events`);
  expect(request!.init.method).toBe("POST");
  expect(request!.init.redirect).toBe("error");
  expect(new Headers(request!.init.headers).get("authorization")).toBe(`Bearer ${env.AGENT_BRIDGE_TOKEN}`);
  expect(JSON.parse(String(request!.init.body))).toEqual(payload);
});

test("malformed, oversized, invalid UTF-8, and non-object native input never reach HTTP", async () => {
  for (const body of ["not JSON", "null", "[]", "123", "x".repeat(MAX_HOOK_BYTES + 1), Buffer.from([0xff])]) {
    let calls = 0;
    await forwardHook({
      input: Readable.from([body]),
      env,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 204 });
      },
    });
    expect(calls).toBe(0);
  }
});

test("missing or invalid credentials quietly disable forwarding", async () => {
  for (const environment of [
    {},
    { ...env, AGENT_BRIDGE_URL: "https://example.com" },
    { ...env, AGENT_BRIDGE_TOKEN: "bad\ntoken" },
  ]) {
    let calls = 0;
    await forwardHook({
      input: Readable.from(["{}"]),
      env: environment,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 204 });
      },
    });
    expect(calls).toBe(0);
  }
});

test("one deadline bounds both stalled stdin and an unresponsive HTTP request", async () => {
  const input = new PassThrough();
  let start = performance.now();
  await forwardHook({ input, env, timeoutMs: 25 });
  expect(performance.now() - start).toBeLessThan(200);
  expect(input.listenerCount("data")).toBe(0);
  input.destroy();
  let signal: AbortSignal | undefined;
  start = performance.now();
  await forwardHook({
    input: Readable.from(["{}"]),
    env,
    timeoutMs: 25,
    fetch: async (_url, init) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    },
  });
  expect(performance.now() - start).toBeLessThan(200);
  expect(signal!.aborted).toBe(true);
});

test("hook errors never escape and executable emits no output with exit zero", async () => {
  await expect(
    forwardHook({
      input: Readable.from(["{}"]),
      env,
      fetch: async () => {
        throw new Error(env.AGENT_BRIDGE_TOKEN);
      },
    }),
  ).resolves.toBeUndefined();
  const child = Bun.spawn([process.execPath, new URL("./hook.ts", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  child.stdin.write("invalid input");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe("");
});
