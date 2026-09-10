import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { connectUnixWebSocket, type UnixWebSocketOptions } from "./unixWebSocket.ts";

interface Frame {
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

function frame(opcode: number, value: string | Buffer, final = true): Buffer {
  const payload = typeof value === "string" ? Buffer.from(value) : value;
  const extra = payload.length < 126 ? 0 : payload.length <= 65_535 ? 2 : 8;
  const result = Buffer.alloc(2 + extra + payload.length);
  result[0] = (final ? 128 : 0) | opcode;
  result[1] = extra === 0 ? payload.length : extra === 2 ? 126 : 127;
  if (extra === 2) result.writeUInt16BE(payload.length, 2);
  if (extra === 8) result.writeBigUInt64BE(BigInt(payload.length), 2);
  payload.copy(result, 2 + extra);
  return result;
}

async function fixture(upgrade?: (socket: Socket, request: string, response: string) => void) {
  const dir = mkdtempSync("/tmp/abws-");
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "s");
  const peers = new Set<Socket>();
  const connected = Promise.withResolvers<Socket>();
  const frames: Frame[] = [];
  const readers: Array<(frame: Frame) => void> = [];
  let request = "";
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let ready = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        request = buffer.subarray(0, boundary + 4).toString();
        buffer = buffer.subarray(boundary + 4);
        const key = /Sec-WebSocket-Key: ([^\r]+)\r\n/.exec(request)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        ready = true;
        if (upgrade) upgrade(socket, request, response);
        else socket.write(response);
        connected.resolve(socket);
      }
      while (buffer.length >= 2) {
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1]! & 128) !== 0;
        const start = offset + (masked ? 4 : 0);
        if (buffer.length < start + length) return;
        const payload = Buffer.from(buffer.subarray(start, start + length));
        if (masked) for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ buffer[offset + (i % 4)]!;
        const item = { opcode: buffer[0]! & 15, masked, payload };
        buffer = buffer.subarray(start + length);
        const reader = readers.shift();
        if (reader) reader(item);
        else frames.push(item);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    dir,
    socketPath,
    connected: connected.promise,
    request: () => request,
    connect: (options: Partial<UnixWebSocketOptions> = {}) =>
      connectUnixWebSocket({ socketPath, ...options }),
    nextFrame: () =>
      frames.length
        ? Promise.resolve(frames.shift()!)
        : new Promise<Frame>((resolve) => readers.push(resolve)),
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("private Unix WebSocket", () => {
  test("validates /rpc upgrade, retains coalesced first message, and masks all payload lengths", async () => {
    const host = await fixture((socket, _request, response) => {
      socket.write(response.slice(0, 18));
      socket.write(Buffer.concat([Buffer.from(response.slice(18)), frame(1, "early")]));
    });
    try {
      const client = await host.connect();
      const messages: string[] = [];
      client.onMessage((text) => messages.push(text));
      expect(messages).toEqual(["early"]);
      expect(host.request()).toStartWith("GET /rpc HTTP/1.1\r\nHost: localhost\r\n");
      expect(host.request()).not.toContain("Origin:");
      expect(host.request()).not.toContain("Extensions:");
      for (const length of [0, 125, 126, 65_535, 65_536]) {
        const text = "x".repeat(length);
        await client.sendText(text);
        const received = await host.nextFrame();
        expect(received.masked).toBe(true);
        expect(received.opcode).toBe(1);
        expect(received.payload.toString()).toBe(text);
      }
      client.close();
      const close = await host.nextFrame();
      expect(close).toMatchObject({ opcode: 8, masked: true });
      expect(close.payload.readUInt16BE()).toBe(1000);
    } finally {
      await host.close();
    }
  });

  test("reassembles split UTF-8 fragments with interleaved ping and multiple messages", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      const done = Promise.withResolvers<string[]>();
      const received: string[] = [];
      client.onMessage((message) => {
        received.push(message);
        if (received.length === 2) done.resolve(received);
      });
      const socket = await host.connected;
      const utf8 = Buffer.from("a🌿b");
      const first = frame(1, utf8.subarray(0, 3), false);
      socket.write(first.subarray(0, 1));
      socket.write(
        Buffer.concat([first.subarray(1), frame(9, "ping"), frame(0, utf8.subarray(3)), frame(1, "second")]),
      );
      expect(await done.promise).toEqual(["a🌿b", "second"]);
      const pong = await host.nextFrame();
      expect(pong).toMatchObject({ opcode: 10, masked: true });
      expect(pong.payload.toString()).toBe("ping");
      client.close();
    } finally {
      await host.close();
    }
  });

  test("validates and acknowledges peer close exactly once", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      const closed = Promise.withResolvers<Error>();
      let count = 0;
      client.onDisconnect((error) => {
        count++;
        closed.resolve(error);
      });
      const payload = Buffer.concat([Buffer.from([3, 232]), Buffer.from("bye")]);
      (await host.connected).write(frame(8, payload));
      expect((await closed.promise).message).toContain("peer closed");
      expect((await host.nextFrame()).payload).toEqual(payload);
      await expect(client.sendText("late")).rejects.toThrow();
      client.close();
      expect(count).toBe(1);
    } finally {
      await host.close();
    }
  });

  for (const [name, change] of [
    ["bad status", (response: string) => response.replace("101 Switching Protocols", "200 OK")],
    [
      "bad accept",
      (response: string) => response.replace(/Sec-WebSocket-Accept: [^\r]+/, "Sec-WebSocket-Accept: wrong"),
    ],
    [
      "duplicate headers",
      (response: string) =>
        response.replace("Upgrade: websocket", "Upgrade: websocket\r\nUpgrade: websocket"),
    ],
    [
      "unsolicited compression",
      (response: string) =>
        response.replace("\r\n\r\n", "\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n"),
    ],
    [
      "malformed header",
      (response: string) => response.replace("Connection: Upgrade", " Connection: Upgrade"),
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      const host = await fixture((socket, _request, response) => socket.write(change(response)));
      try {
        await expect(host.connect()).rejects.toThrow(/WebSocket/);
      } finally {
        await host.close();
      }
    });
  }

  for (const [name, data] of [
    ["masked server frame", Buffer.from([0x81, 0x80])],
    ["unexpected continuation", frame(0, "x")],
    ["nested fragmented message", Buffer.concat([frame(1, "x", false), frame(1, "y")])],
    ["fragmented control", frame(9, "x", false)],
    ["oversized control", frame(9, "x".repeat(126))],
    ["binary message", frame(2, "x")],
    ["reserved bits", Buffer.from([0xc1, 0])],
    ["noncanonical length", Buffer.from([0x81, 126, 0, 1, 65])],
    ["invalid UTF-8", frame(1, Buffer.from([0xff]))],
    ["invalid close payload", frame(8, Buffer.from([3]))],
    ["invalid close code", frame(8, Buffer.from([3, 237]))],
    ["invalid wide length", Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 0])],
  ] as const) {
    test(`disconnects on ${name}`, async () => {
      const host = await fixture();
      try {
        const client = await host.connect();
        const closed = Promise.withResolvers<Error>();
        client.onDisconnect(closed.resolve);
        (await host.connected).write(data);
        expect(await closed.promise).toBeInstanceOf(Error);
        await expect(client.sendText("after error")).rejects.toThrow();
      } finally {
        await host.close();
      }
    });
  }

  test("bounds complete and fragmented messages before allocation", async () => {
    for (const data of [
      frame(1, "a".repeat(33)),
      Buffer.concat([frame(1, "a".repeat(20), false), frame(0, "b".repeat(20))]),
    ]) {
      const host = await fixture();
      try {
        const client = await host.connect({ maxMessageBytes: 32, maxBufferedBytes: 16_384 });
        await expect(client.sendText("x".repeat(33))).rejects.toThrow(/limit/);
        const closed = Promise.withResolvers<Error>();
        client.onDisconnect(closed.resolve);
        (await host.connected).write(data);
        expect((await closed.promise).message).toContain("limit");
      } finally {
        await host.close();
      }
    }
  });

  test("bounds upgrade headers and expires silent handshake", async () => {
    for (const mode of ["headers", "silent"]) {
      const host = await fixture((socket) => {
        if (mode === "headers") socket.write("x".repeat(17_000));
      });
      try {
        await expect(host.connect({ connectTimeoutMs: 30 })).rejects.toThrow(
          mode === "headers" ? /headers/ : /timed out/,
        );
      } finally {
        await host.close();
      }
    }
  });

  test("reports abrupt disconnect and rejects unsafe paths without connecting", async () => {
    const host = await fixture();
    try {
      const client = await host.connect();
      const closed = Promise.withResolvers<Error>();
      client.onDisconnect(closed.resolve);
      (await host.connected).destroy();
      expect(await closed.promise).toBeInstanceOf(Error);
      chmodSync(host.socketPath, 0o666);
      await expect(host.connect()).rejects.toThrow(/private/);
      chmodSync(host.socketPath, 0o600);
      chmodSync(host.dir, 0o755);
      await expect(host.connect()).rejects.toThrow(/private/);
      chmodSync(host.dir, 0o700);
      const link = join(host.dir, "link");
      symlinkSync(host.socketPath, link);
      await expect(host.connect({ socketPath: link })).rejects.toThrow(/private/);
      const file = join(host.dir, "file");
      writeFileSync(file, "inert", { mode: 0o600 });
      await expect(host.connect({ socketPath: file })).rejects.toThrow(/private/);
      await expect(host.connect({ socketPath: "relative.sock" })).rejects.toThrow(/absolute/);
    } finally {
      await host.close();
    }
  });
});
