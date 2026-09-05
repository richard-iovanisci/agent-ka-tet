import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { connectUnixWebSocket, type UnixWebSocket } from "./unixWebSocket.ts";

export interface CodexClientInfo {
  name: string;
  title?: string;
  version: string;
}

export interface CodexConnectOptions {
  socketPath: string;
  clientInfo: CodexClientInfo;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface CodexThreadOptions {
  cwd: string;
  model?: string;
  approvalPolicy?: "on-request" | "untrusted";
  sandbox?: "read-only" | "workspace-write";
  config?: Record<string, unknown>;
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexResponse {
  requestId: string;
  result?: unknown;
  error?: unknown;
}

export interface CodexServerRequest extends CodexNotification {
  requestId: string | number;
}

export class CodexRequestError extends Error {
  readonly outcome = "uncertain";

  constructor(
    readonly requestId: string,
    readonly method: string,
    readonly reason: "rpc" | "timeout" | "disconnect" | "protocol" | "write",
    readonly rawError?: unknown,
  ) {
    super(`Codex ${method} failed (${reason}); acceptance is uncertain`);
    this.name = "CodexRequestError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("An exact native thread UUID is required");
  }
}

function nativeThread(result: unknown): Record<string, unknown> & { id: string } {
  if (!object(result) || !object(result.thread) || typeof result.thread.id !== "string") {
    throw new Error("Invalid Codex thread response");
  }
  uuid(result.thread.id);
  return result.thread as Record<string, unknown> & { id: string };
}

interface PendingRequest {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
  reject: (error: CodexRequestError) => void;
}

export class CodexClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly usedIds = new Set<string>();
  private readonly notifications = new Set<(notification: CodexNotification) => void>();
  private readonly responses = new Set<(response: CodexResponse) => void>();
  private readonly serverRequests = new Set<(request: CodexServerRequest) => void>();
  private readonly disconnects = new Set<(error: Error) => void>();
  private boundThread: string | undefined;
  private threadStarted = false;
  private binding = false;
  private bindingThread: string | undefined;
  private ended: Error | undefined;

  private constructor(
    private readonly transport: UnixWebSocket,
    private readonly timeoutMs: number,
  ) {
    transport.onMessage((text) => this.receive(text));
    transport.onDisconnect((error) => this.disconnected(error));
  }

  static async connect(options: CodexConnectOptions): Promise<CodexClient> {
    const info = options.clientInfo;
    if (!info.name.trim() || !info.version.trim() || ["codex_tui", "codex_app"].includes(info.name)) {
      throw new Error("Distinct Bridge client metadata is required");
    }
    const timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Invalid Codex request timeout");
    const transport = await connectUnixWebSocket({
      socketPath: options.socketPath,
      connectTimeoutMs: options.connectTimeoutMs,
    });
    const client = new CodexClient(transport, timeout);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: info.name,
          ...(info.title === undefined ? {} : { title: info.title }),
          version: info.version,
        },
      });
      await transport.sendText(JSON.stringify({ method: "initialized" }));
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }

  onResponse(listener: (response: CodexResponse) => void): () => void {
    this.responses.add(listener);
    return () => {
      this.responses.delete(listener);
    };
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.serverRequests.add(listener);
    return () => {
      this.serverRequests.delete(listener);
    };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    if (this.ended)
      queueMicrotask(() => {
        if (this.disconnects.has(listener)) listener(this.ended!);
      });
    return () => {
      this.disconnects.delete(listener);
    };
  }

  async startThread(options: CodexThreadOptions): Promise<{
    requestId: string;
    threadId: string;
    thread: Record<string, unknown> & { id: string };
  }> {
    if (this.boundThread || this.binding || this.threadStarted)
      throw new Error("This Codex client already started or bound a thread");
    if (!isAbsolute(options.cwd)) throw new Error("Thread cwd must be absolute");
    if (options.sandbox !== undefined && !["read-only", "workspace-write"].includes(options.sandbox)) {
      throw new Error("Unsupported pilot sandbox");
    }
    if (
      options.approvalPolicy !== undefined &&
      !["on-request", "untrusted"].includes(options.approvalPolicy)
    ) {
      throw new Error("Unsupported pilot approval policy");
    }
    const params = {
      cwd: options.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.config === undefined ? {} : { config: options.config }),
    };
    const requestId = randomUUID();
    this.threadStarted = true;
    const result = await this.request("thread/start", params, requestId);
    try {
      const thread = nativeThread(result);
      return { requestId, threadId: thread.id, thread };
    } catch (error) {
      throw new CodexRequestError(requestId, "thread/start", "protocol", result);
    }
  }

  async bindThread(threadId: string): Promise<void> {
    uuid(threadId);
    if (this.boundThread === threadId) return;
    if (this.boundThread || this.binding)
      throw new Error("Codex thread binding cannot change on this client");
    this.binding = true;
    this.bindingThread = threadId;
    const requestId = randomUUID();
    try {
      const result = await this.request("thread/resume", { threadId, excludeTurns: true }, requestId);
      let returned: string;
      try {
        returned = nativeThread(result).id;
      } catch {
        throw new CodexRequestError(requestId, "thread/resume", "protocol", result);
      }
      if (returned !== threadId) {
        this.close();
        throw new CodexRequestError(requestId, "thread/resume", "protocol", result);
      }
      this.boundThread = threadId;
    } finally {
      this.binding = false;
      this.bindingThread = undefined;
    }
  }

  async sendPeer(options: {
    messageId: string;
    envelope: string;
    threadId?: string;
    requestId?: string;
  }): Promise<{ requestId: string; turnId: string }> {
    if (!this.boundThread || (options.threadId !== undefined && options.threadId !== this.boundThread)) {
      throw new Error("Peer recipient must match the bound native thread");
    }
    if (!options.messageId.trim() || !options.envelope.trim())
      throw new Error("A message ID and immutable envelope are required");
    const requestId = options.requestId ?? randomUUID();
    const result = await this.request(
      "turn/start",
      {
        threadId: this.boundThread,
        input: [],
        toolOutput: { name: "bridge_receive_message", namespace: "agent_bridge", output: options.envelope },
      },
      requestId,
    );
    if (!object(result) || !object(result.turn) || typeof result.turn.id !== "string" || !result.turn.id) {
      throw new CodexRequestError(requestId, "turn/start", "protocol", result);
    }
    return { requestId, turnId: result.turn.id };
  }

  async startOperatorTurn(options: {
    text: string;
    requestId?: string;
  }): Promise<{ requestId: string; turnId: string }> {
    if (!this.boundThread) throw new Error("An exact native thread binding is required");
    if (!options.text.trim()) throw new Error("An operator brief is required");
    const requestId = options.requestId ?? randomUUID();
    const result = await this.request(
      "turn/start",
      {
        threadId: this.boundThread,
        input: [{ type: "text", text: options.text, text_elements: [] }],
      },
      requestId,
    );
    if (!object(result) || !object(result.turn) || typeof result.turn.id !== "string" || !result.turn.id) {
      throw new CodexRequestError(requestId, "turn/start", "protocol", result);
    }
    return { requestId, turnId: result.turn.id };
  }

  close(): void {
    this.transport.close();
  }

  private request(method: string, params: unknown, requestId: string = randomUUID()): Promise<unknown> {
    if (this.ended) return Promise.reject(new CodexRequestError(requestId, method, "disconnect", this.ended));
    if (!requestId.trim() || requestId.length > 256 || this.usedIds.has(requestId)) {
      return Promise.reject(new Error("A fresh bounded request ID is required; requests are never replayed"));
    }
    if (this.pending.size >= 64 || this.usedIds.size >= 4096)
      return Promise.reject(new Error("Codex pilot request limit reached"));
    this.usedIds.add(requestId);
    const text = JSON.stringify({ id: requestId, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexRequestError(requestId, method, "timeout"));
      }, this.timeoutMs);
      this.pending.set(requestId, { method, timer, resolve, reject });
      void this.transport.sendText(text).catch((error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(new CodexRequestError(requestId, method, "write", error));
      });
    });
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.disconnected(new Error("Invalid Codex JSON message"));
      this.transport.close();
      return;
    }
    if (!object(message)) {
      this.disconnected(new Error("Invalid Codex RPC message"));
      this.transport.close();
      return;
    }
    if (typeof message.method === "string") {
      // Native approval requests belong to the attached TUI; never answer them here.
      if (!("id" in message)) {
        for (const listener of this.notifications)
          listener({ method: message.method, params: message.params });
      } else if (
        typeof message.id === "string" ||
        (typeof message.id === "number" && Number.isSafeInteger(message.id))
      ) {
        if (
          object(message.params) &&
          "threadId" in message.params &&
          message.params.threadId !== (this.boundThread ?? this.bindingThread)
        )
          return;
        const request = { requestId: message.id, method: message.method, params: message.params };
        for (const listener of this.serverRequests) listener(request);
      }
      return;
    }
    if (typeof message.id !== "string" || !this.usedIds.has(message.id)) return;
    const response: CodexResponse = { requestId: message.id };
    if ("result" in message) response.result = message.result;
    if ("error" in message) response.error = message.error;
    for (const listener of this.responses) listener(response);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if ("error" in message === "result" in message) {
      pending.reject(new CodexRequestError(message.id, pending.method, "protocol", message));
    } else if ("error" in message) {
      pending.reject(new CodexRequestError(message.id, pending.method, "rpc", message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private disconnected(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRequestError(requestId, pending.method, "disconnect", error));
    }
    this.pending.clear();
    for (const listener of this.disconnects) listener(error);
  }
}

export const connectCodex = CodexClient.connect;
