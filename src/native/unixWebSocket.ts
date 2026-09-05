import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface UnixWebSocketOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
}

export interface UnixWebSocket {
  sendText(text: string): Promise<void>;
  onMessage(listener: (text: string) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  close(): void;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADERS = 16_384;

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

async function privateSocket(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("An absolute private socket path is required");
  const canonical = join(await realpath(dirname(path)), basename(path));
  if (canonical.endsWith("/app-server-control/app-server-control.sock")) {
    throw new Error("The default Codex control socket is not a private Bridge endpoint");
  }
  const [socket, directory] = await Promise.all([lstat(path), stat(dirname(canonical))]);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o077) !== 0 ||
    (socket.mode & 0o600) !== 0o600 ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o077) !== 0 ||
    (directory.mode & 0o700) !== 0o700
  ) {
    throw new Error("Socket and parent directory must be private and owned by this user");
  }
  return canonical;
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const extended = payload.length < 126 ? 0 : payload.length <= 65_535 ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + extended + 4 + payload.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
  if (extended === 2) frame.writeUInt16BE(payload.length, 2);
  if (extended === 8) frame.writeBigUInt64BE(BigInt(payload.length), 2);
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(frame, maskOffset);
  for (let i = 0; i < payload.length; i++) frame[maskOffset + 4 + i] = payload[i]! ^ mask[i % 4]!;
  return frame;
}

export async function connectUnixWebSocket(options: UnixWebSocketOptions): Promise<UnixWebSocket> {
  const timeoutMs = positive(options.connectTimeoutMs ?? 10_000, "connect timeout");
  const maxMessage = positive(options.maxMessageBytes ?? 4 * 1024 * 1024, "message limit");
  const maxBuffered = positive(options.maxBufferedBytes ?? 8 * 1024 * 1024, "buffer limit");
  if (maxBuffered < maxMessage + 14)
    throw new Error("Buffer limit must exceed the message limit by at least 14 bytes");
  const path = await privateSocket(options.socketPath);
  const key = randomBytes(16).toString("base64");
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");

  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ path });
    let upgraded = false;
    let ended: Error | undefined;
    let buffer = Buffer.alloc(0);
    let fragments: Buffer[] | undefined;
    let fragmentBytes = 0;
    let queuedBytes = 0;
    const queued: string[] = [];
    const messages = new Set<(text: string) => void>();
    const disconnects = new Set<(error: Error) => void>();
    const timer = setTimeout(() => fail(new Error("WebSocket connection timed out")), timeoutMs);

    function finish(error: Error) {
      if (ended) return;
      ended = error;
      clearTimeout(timer);
      buffer = Buffer.alloc(0);
      fragments = undefined;
      queued.length = 0;
      if (!upgraded) reject(error);
      for (const listener of disconnects) listener(error);
    }

    function fail(error: Error) {
      finish(error);
      socket.destroy();
    }

    function write(opcode: number, payload: Buffer): Promise<void> {
      if (ended || !upgraded || socket.destroyed)
        return Promise.reject(ended ?? new Error("WebSocket is not connected"));
      const frame = clientFrame(opcode, payload);
      if (socket.writableLength + frame.length > maxBuffered) {
        const error = new Error("WebSocket write buffer limit exceeded");
        fail(error);
        return Promise.reject(error);
      }
      return new Promise((written, failed) => {
        socket.write(frame, (error) => (error ? failed(error) : written()));
      });
    }

    function deliver(payload: Buffer) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      if (messages.size === 0) {
        queuedBytes += payload.length;
        if (queuedBytes > maxBuffered || queued.length >= 128)
          throw new Error("WebSocket notification buffer limit exceeded");
        queued.push(text);
      } else {
        for (const listener of messages) listener(text);
      }
    }

    function consumeFrames() {
      while (!ended && buffer.length >= 2) {
        const first = buffer[0]!;
        const second = buffer[1]!;
        const final = (first & 0x80) !== 0;
        const opcode = first & 15;
        if ((first & 0x70) !== 0 || (second & 0x80) !== 0)
          throw new Error("Unsupported WebSocket flags or masked server frame");
        if (![0, 1, 8, 9, 10].includes(opcode)) throw new Error("Unsupported WebSocket opcode");
        let length = second & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          if (length < 126) throw new Error("Noncanonical WebSocket length");
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const wide = buffer.readBigUInt64BE(2);
          if (wide <= 65_535n || wide > BigInt(maxMessage))
            throw new Error("Invalid or oversized WebSocket frame");
          length = Number(wide);
          offset = 10;
        }
        if (opcode >= 8 && (!final || length > 125)) throw new Error("Invalid WebSocket control frame");
        if (length > maxMessage) throw new Error("WebSocket message limit exceeded");
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) {
          if (length === 1) throw new Error("Invalid WebSocket close payload");
          if (length >= 2) {
            const code = payload.readUInt16BE(0);
            if (
              !(code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) &&
              !(code >= 3000 && code <= 4999)
            )
              throw new Error("Invalid WebSocket close code");
            new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
          }
          socket.end(clientFrame(8, payload), () => socket.destroy());
          finish(new Error("WebSocket peer closed the connection"));
          return;
        }
        if (opcode === 9) {
          void write(10, payload).catch(fail);
          continue;
        }
        if (opcode === 10) continue;
        if (opcode === 1) {
          if (fragments) throw new Error("A fragmented WebSocket message is already open");
          if (final) deliver(payload);
          else {
            fragments = [payload];
            fragmentBytes = length;
          }
        } else {
          if (!fragments) throw new Error("Unexpected WebSocket continuation");
          fragmentBytes += length;
          if (fragmentBytes > maxMessage || fragments.length >= 1024)
            throw new Error("WebSocket fragmented message limit exceeded");
          fragments.push(payload);
          if (final) {
            const complete = Buffer.concat(fragments, fragmentBytes);
            fragments = undefined;
            fragmentBytes = 0;
            deliver(complete);
          }
        }
      }
    }

    function consumeUpgrade() {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) {
        if (buffer.length > MAX_HEADERS) throw new Error("WebSocket upgrade headers too large");
        return;
      }
      if (boundary + 4 > MAX_HEADERS) throw new Error("WebSocket upgrade headers too large");
      const lines = buffer.subarray(0, boundary).toString("latin1").split("\r\n");
      if (!/^HTTP\/1\.1 101(?: .*)?$/.test(lines.shift() ?? ""))
        throw new Error("WebSocket upgrade rejected");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!match) throw new Error("Malformed WebSocket upgrade header");
        const name = match[1]!.toLowerCase();
        if (headers.has(name)) throw new Error("Duplicate WebSocket upgrade header");
        headers.set(name, match[2]!.trim());
      }
      if (
        headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !headers
          .get("connection")
          ?.toLowerCase()
          .split(/\s*,\s*/)
          .includes("upgrade") ||
        headers.get("sec-websocket-accept") !== accept ||
        headers.has("sec-websocket-extensions") ||
        headers.has("sec-websocket-protocol")
      ) {
        throw new Error("Invalid WebSocket upgrade response");
      }
      buffer = buffer.subarray(boundary + 4);
      upgraded = true;
      clearTimeout(timer);
      resolve({
        sendText(text) {
          const payload = Buffer.from(text, "utf8");
          if (payload.length > maxMessage)
            return Promise.reject(new Error("WebSocket message limit exceeded"));
          return write(1, payload);
        },
        onMessage(listener) {
          messages.add(listener);
          const pending = queued.splice(0);
          queuedBytes = 0;
          for (const text of pending) listener(text);
          return () => {
            messages.delete(listener);
          };
        },
        onDisconnect(listener) {
          disconnects.add(listener);
          if (ended)
            queueMicrotask(() => {
              if (disconnects.has(listener)) listener(ended!);
            });
          return () => {
            disconnects.delete(listener);
          };
        },
        close() {
          if (ended) return;
          socket.end(clientFrame(8, Buffer.from([3, 232])), () => socket.destroy());
          finish(new Error("WebSocket closed by client"));
        },
      });
    }

    socket.on("connect", () => {
      socket.write(
        `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (ended) return;
      try {
        if (buffer.length + chunk.length + fragmentBytes + queuedBytes > maxBuffered)
          throw new Error("WebSocket read buffer limit exceeded");
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) consumeUpgrade();
        if (upgraded) consumeFrames();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("WebSocket protocol error"));
      }
    });
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("WebSocket connection ended")));
    socket.on("close", () => finish(new Error("WebSocket connection closed")));
  });
}
