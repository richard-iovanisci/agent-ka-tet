export type RuntimeKind = "claude" | "codex";
export type AccessMode = "read" | "write";
export type DeliveryRoute = "codex" | "claude-channel";
export type DeliveryPolicy = "ready" | "held" | "refused" | "expired" | "cancelled";
export type DeliveryState = "prepared" | "sending" | "written" | "accepted" | "rejected" | "ambiguous";
export type ApplicationState = "unread" | "fetched" | "acknowledged" | "replied";

export interface Run {
  id: string;
  brief: string;
  createdAt: number;
  expiresAt: number;
  maxMessages: number;
  maxHops: number;
  paused: boolean;
}

export interface RuntimeAttempt {
  id: string;
  runId: string;
  agentId: string;
  kind: RuntimeKind;
  workspace: string;
  access: AccessMode;
  expectedSessionId: string | null;
  sessionId: string | null;
  ready: boolean;
  paused: boolean;
  revoked: boolean;
  exited: boolean;
  createdAt: number;
}

export interface BridgeMessage {
  id: string;
  version: 1;
  runId: string;
  senderRuntimeId: string;
  senderAgentId: string;
  senderSessionId: string;
  recipientRuntimeId: string;
  recipientAgentId: string;
  recipientSessionId: string;
  body: string;
  digest: string;
  idempotencyKey: string;
  replyTo: string | null;
  hops: number;
  createdAt: number;
  expiresAt: number;
}

export interface DeliveryReceipt {
  messageId: string;
  policy: DeliveryPolicy;
  state: DeliveryState;
  application: ApplicationState;
  route: DeliveryRoute | null;
  requestId: string;
  turnId: string | null;
  itemId: string | null;
  detail: string | null;
  sendingAt: number | null;
  finishedAt: number | null;
  fetchedAt: number | null;
  acknowledgedAt: number | null;
  repliedAt: number | null;
}

export interface MessageRecord {
  message: BridgeMessage;
  receipt: DeliveryReceipt;
}

export interface CreateRunInput {
  brief: string;
  expiresAt?: number;
  maxMessages?: number;
  maxHops?: number;
}

export interface CreateRuntimeInput {
  runId: string;
  agentId: string;
  kind: RuntimeKind;
  workspace: string;
  access: AccessMode;
  expectedSessionId?: string;
}

export interface SendMessageInput {
  to: string;
  body: string;
  idempotencyKey: string;
  replyTo?: string;
}

export interface DeliveryOutcome {
  state: "written" | "accepted" | "rejected" | "ambiguous";
  requestId?: string;
  turnId?: string;
  itemId?: string;
  detail?: string;
}

export interface RuntimeObservation {
  id: number;
  runtimeId: string;
  source: string;
  name: string;
  sessionId: string;
  turnId?: string;
  data?: unknown;
  createdAt: number;
}

export type TaskState = "ready" | "working" | "review" | "changes_requested" | "accepted";

export interface TaskArtifact {
  commit: string;
  summary: string;
}

export interface Task {
  id: string;
  runId: string;
  title: string;
  brief: string;
  implementerRuntimeId: string;
  reviewerRuntimeId: string;
  state: TaskState;
  version: number;
  artifact: TaskArtifact | null;
  reviewSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  runId: string;
  title: string;
  brief: string;
  implementerRuntimeId: string;
  reviewerRuntimeId: string;
}

export interface TaskTransitionInput {
  taskId: string;
  expectedVersion: number;
}

export interface SubmitTaskInput extends TaskTransitionInput {
  artifact: TaskArtifact;
}

export interface ReviewTaskInput extends TaskTransitionInput {
  decision: "accept" | "changes_requested";
  summary: string;
}

export interface TaskTransitionResult {
  task: Task;
  notification: MessageRecord;
}

export interface CoordinationStore {
  createRun(input: CreateRunInput): Run;
  run(id?: string): Run | null;
  createRuntime(input: CreateRuntimeInput): { runtime: RuntimeAttempt; token: string };
  runtime(id: string): RuntimeAttempt;
  runtimes(): RuntimeAttempt[];
  expectSession(runtimeId: string, sessionId: string): RuntimeAttempt;
  bindRuntime(runtimeId: string, sessionId: string): RuntimeAttempt;
  authenticate(token: string): RuntimeAttempt;
  authenticateForBinding(token: string): RuntimeAttempt;
  setReady(runtimeId: string, ready: boolean): RuntimeAttempt;
  pauseRuntime(runtimeId: string, paused: boolean): RuntimeAttempt;
  pauseRun(runId: string, paused: boolean): Run;
  revokeRuntime(runtimeId: string): RuntimeAttempt;
  exitRuntime(runtimeId: string): RuntimeAttempt;
  send(token: string, input: SendMessageInput): MessageRecord;
  listMessages(token: string): MessageRecord[];
  readMessage(token: string, messageId: string): MessageRecord;
  acknowledge(token: string, messageId: string): MessageRecord;
  receipt(token: string, messageId: string): DeliveryReceipt;
  messages(): MessageRecord[];
  claimDelivery(runtimeId: string, route: DeliveryRoute): MessageRecord | null;
  observeDelivery(messageId: string, observation: { turnId?: string; itemId?: string }): MessageRecord;
  finishDelivery(messageId: string, outcome: DeliveryOutcome): MessageRecord;
  appendObservation(
    runtimeId: string,
    observation: Omit<RuntimeObservation, "id" | "runtimeId" | "createdAt">,
  ): RuntimeObservation;
  observations(limit?: number): RuntimeObservation[];
  createTask(input: CreateTaskInput): Task;
  task(id?: string): Task | null;
  readTask(token: string, taskId?: string): Task | null;
  claimTask(token: string, input: TaskTransitionInput): Task;
  submitTask(token: string, input: SubmitTaskInput): TaskTransitionResult;
  reviewTask(token: string, input: ReviewTaskInput): TaskTransitionResult;
  recover(): void;
  close(): void;
}
