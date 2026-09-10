import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationError, openCoordinationStore } from "./store.ts";
import type { CreateRunInput, CreateRuntimeInput, RuntimeKind, SubmitTaskInput } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});

function fixture(limits: Partial<CreateRunInput> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-coordination-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["implementer", "reviewer", "other"]) mkdirSync(join(dir, name));
  let time = 1_000;
  const path = join(dir, "state", "pilot.sqlite");
  const open = () => {
    const store = openCoordinationStore(path, { now: () => time });
    cleanup.push(() => store.close());
    return store;
  };
  const store = open();
  const run = store.createRun({ brief: "Produce one artifact and review it.", expiresAt: 20_000, ...limits });
  const allocate = (agentId: string, kind: RuntimeKind, overrides: Partial<CreateRuntimeInput> = {}) => {
    const created = store.createRuntime({
      runId: run.id,
      agentId,
      kind,
      workspace: join(dir, agentId),
      access: "read",
      expectedSessionId: randomUUID(),
      ...overrides,
    });
    return created;
  };
  const bind = (value: ReturnType<typeof allocate>) => {
    store.bindRuntime(value.runtime.id, value.runtime.expectedSessionId!);
    store.setReady(value.runtime.id, true);
    return { ...value, runtime: store.runtime(value.runtime.id) };
  };
  const pair = () => ({
    claude: bind(allocate("implementer", "claude")),
    codex: bind(allocate("reviewer", "codex")),
  });
  return {
    dir,
    path,
    store,
    run,
    allocate,
    bind,
    pair,
    open,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

function code(fn: () => unknown, expected: CoordinationError["code"]) {
  try {
    fn();
    throw new Error("expected coordination rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CoordinationError);
    expect((error as CoordinationError).code).toBe(expected);
  }
}

describe("pilot coordination boundaries", () => {
  test("fresh credentials are bind-only, exact UUID binding enables scoped tools, and status has no secret", () => {
    const f = fixture();
    const first = f.allocate("implementer", "claude");
    const second = f.allocate("reviewer", "codex", { expectedSessionId: undefined });
    expect(first.token).not.toBe(second.token);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(f.store.authenticateForBinding(first.token).sessionId).toBeNull();
    code(() => f.store.authenticate(first.token), "unauthorized");
    code(() => f.store.setReady(first.runtime.id, true), "unavailable");
    code(() => f.store.bindRuntime(first.runtime.id, randomUUID()), "conflict");
    code(() => f.store.bindRuntime(second.runtime.id, randomUUID()), "conflict");
    code(() => f.store.expectSession(first.runtime.id, randomUUID()), "conflict");
    code(() => f.store.expectSession(second.runtime.id, "not-a-native-uuid"), "invalid");
    f.bind(first);
    const codexSession = randomUUID();
    f.store.expectSession(second.runtime.id, codexSession);
    f.store.bindRuntime(second.runtime.id, codexSession);
    expect(f.store.authenticate(first.token).sessionId).toBe(first.runtime.expectedSessionId);
    const status = JSON.stringify({ runtimes: f.store.runtimes(), run: f.store.run() });
    expect(status).not.toContain(first.token);
    expect(status).not.toContain("credential");
    const raw = new Database(f.path, { readonly: true });
    const rows = raw
      .query<{ credential_hash: string }, []>("SELECT credential_hash FROM runtime_attempt")
      .all();
    raw.close();
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.credential_hash))).toBe(true);
    expect(readFileSync(f.path).includes(Buffer.from(first.token))).toBe(false);
    f.store.revokeRuntime(first.runtime.id);
    code(() => f.store.authenticate(first.token), "unauthorized");
    code(() => f.store.authenticateForBinding(first.token), "unauthorized");
    code(() => f.store.authenticate("wrong-token".repeat(4)), "unauthorized");
  });

  test("one live native session cannot have two owners, including a revoked owner", () => {
    const f = fixture();
    const first = f.bind(f.allocate("implementer", "claude"));
    const second = f.allocate("other", "claude", { expectedSessionId: first.runtime.sessionId! });
    code(() => f.bind(second), "conflict");
    f.store.revokeRuntime(first.runtime.id);
    code(() => f.bind(second), "conflict");
    f.store.exitRuntime(first.runtime.id);
    expect(f.bind(second).runtime.sessionId).toBe(first.runtime.sessionId);
  });

  test("send derives exact sender, rejects extra authority and scope, and preserves idempotency", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const input = { to: "reviewer", body: "Review artifact.txt", idempotencyKey: "result-1" };
    const first = f.store.send(claude.token, input);
    expect(first.message).toMatchObject({
      senderRuntimeId: claude.runtime.id,
      senderSessionId: claude.runtime.sessionId,
      recipientRuntimeId: codex.runtime.id,
      recipientSessionId: codex.runtime.sessionId,
    });
    expect(first.receipt).toMatchObject({
      state: "prepared",
      policy: "ready",
      application: "unread",
      route: null,
    });
    expect(first.receipt.requestId).toBeString();
    expect(f.store.send(claude.token, input)).toEqual(first);
    expect(f.store.messages()).toHaveLength(1);
    code(() => f.store.send(claude.token, { ...input, body: "Changed" }), "conflict");
    code(() => f.store.send(claude.token, { ...input, to: "other" }), "conflict");
    code(() => f.store.send(claude.token, { ...input, authority: "operator" } as typeof input), "invalid");
    code(
      () => f.store.send(claude.token, { ...input, idempotencyKey: "self", to: "implementer" }),
      "forbidden",
    );
    code(
      () => f.store.send(claude.token, { ...input, idempotencyKey: "outside", to: "outside-run" }),
      "unavailable",
    );
    const echo = f.store.send(codex.token, { to: "implementer", body: "Done", idempotencyKey: "result-1" });
    expect(echo.message.id).not.toBe(first.message.id);
  });

  test("pending messages never follow a replacement, and old idempotency keys retain their snapshot", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const input = { to: "reviewer", body: "Review old artifact", idempotencyKey: "old" };
    const old = f.store.send(claude.token, input);
    f.store.revokeRuntime(codex.runtime.id);
    const replacement = f.bind(f.allocate("reviewer", "codex"));
    expect(replacement.token).not.toBe(codex.token);
    expect(f.store.send(claude.token, input).message).toEqual(old.message);
    expect(f.store.messages()[0]!.receipt.policy).toBe("cancelled");
    expect(f.store.claimDelivery(replacement.runtime.id, "codex")).toBeNull();
    expect(f.store.listMessages(replacement.token)).toEqual([]);
    code(() => f.store.readMessage(replacement.token, old.message.id), "forbidden");
    code(() => f.store.acknowledge(replacement.token, old.message.id), "forbidden");
    const next = f.store.send(claude.token, { ...input, idempotencyKey: "new" });
    expect(next.message.recipientRuntimeId).toBe(replacement.runtime.id);
  });

  test("read and ACK require exact recipient while sender can inspect receipts", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const stranger = f.bind(f.allocate("other", "claude"));
    const sent = f.store.send(claude.token, {
      to: "reviewer",
      body: "Artifact ready",
      idempotencyKey: "artifact",
    });
    code(() => f.store.readMessage(claude.token, sent.message.id), "forbidden");
    code(() => f.store.acknowledge(stranger.token, sent.message.id), "forbidden");
    code(() => f.store.receipt(stranger.token, sent.message.id), "forbidden");
    expect(f.store.receipt(claude.token, sent.message.id).application).toBe("unread");
    expect(f.store.listMessages(stranger.token)).toEqual([]);
    expect(f.store.listMessages(codex.token)[0]!.receipt.application).toBe("fetched");
    const acknowledged = f.store.acknowledge(codex.token, sent.message.id);
    expect(acknowledged.receipt).toMatchObject({ state: "prepared", application: "acknowledged" });
    f.advance(50);
    expect(f.store.acknowledge(codex.token, sent.message.id).receipt.acknowledgedAt).toBe(
      acknowledged.receipt.acknowledgedAt,
    );
    expect(f.store.readMessage(codex.token, sent.message.id).receipt.application).toBe("acknowledged");
  });
});

describe("durable dispatch and application observations", () => {
  test("native item evidence can precede or follow the RPC outcome without changing receipt meaning", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const early = f.store.send(claude.token, {
      to: "reviewer",
      body: "Early event",
      idempotencyKey: "early",
    });
    code(() => f.store.observeDelivery(early.message.id, { turnId: "turn-early" }), "conflict");
    f.store.claimDelivery(codex.runtime.id, "codex");
    expect(
      f.store.observeDelivery(early.message.id, { turnId: "turn-early", itemId: "fco_early" }).receipt,
    ).toMatchObject({ state: "sending", application: "unread", policy: "ready" });
    code(
      () => f.store.finishDelivery(early.message.id, { state: "accepted", turnId: "other-turn" }),
      "conflict",
    );
    expect(
      f.store.finishDelivery(early.message.id, { state: "accepted", turnId: "turn-early" }).receipt,
    ).toMatchObject({ turnId: "turn-early", itemId: "fco_early", state: "accepted" });

    const late = f.store.send(claude.token, { to: "reviewer", body: "Late event", idempotencyKey: "late" });
    f.store.claimDelivery(codex.runtime.id, "codex");
    const result = f.store.finishDelivery(late.message.id, { state: "ambiguous", turnId: "turn-late" });
    const observed = f.store.observeDelivery(late.message.id, { itemId: "fco_late" });
    expect(observed.receipt).toEqual({ ...result.receipt, itemId: "fco_late" });
    expect(f.store.observeDelivery(late.message.id, { itemId: "fco_late" })).toEqual(observed);
    code(() => f.store.observeDelivery(late.message.id, { itemId: "fco_different" }), "conflict");
    expect(f.store.receipt(claude.token, late.message.id).state).toBe("ambiguous");
  });

  test("two independent coordinators can claim a prepared message only once, before I/O", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const message = f.store.send(claude.token, { to: "reviewer", body: "Review", idempotencyKey: "claim" });
    const another = f.open();
    code(() => another.claimDelivery(codex.runtime.id, "claude-channel"), "invalid");
    const claimed = f.store.claimDelivery(codex.runtime.id, "codex")!;
    expect(claimed.receipt).toMatchObject({
      state: "sending",
      requestId: message.receipt.requestId,
      route: "codex",
      sendingAt: 1000,
    });
    expect(another.messages()[0]!.receipt.state).toBe("sending");
    expect(another.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    code(
      () => f.store.finishDelivery(message.message.id, { state: "accepted", requestId: randomUUID() }),
      "conflict",
    );
    const accepted = f.store.finishDelivery(message.message.id, {
      state: "accepted",
      requestId: claimed.receipt.requestId!,
      turnId: "turn-1",
      itemId: "fco_1",
    });
    expect(accepted.receipt).toMatchObject({
      state: "accepted",
      application: "unread",
      turnId: "turn-1",
      itemId: "fco_1",
    });
    expect(another.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    code(() => another.finishDelivery(message.message.id, { state: "accepted" }), "conflict");
  });

  test("Channel pipe write, recipient fetch, ACK, and reply remain different evidence", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const sent = f.store.send(codex.token, {
      to: "implementer",
      body: "Findings",
      idempotencyKey: "findings",
    });
    f.store.claimDelivery(claude.runtime.id, "claude-channel");
    code(() => f.store.finishDelivery(sent.message.id, { state: "accepted" }), "invalid");
    const written = f.store.finishDelivery(sent.message.id, { state: "written" });
    expect(written.receipt).toMatchObject({ state: "written", application: "unread", acknowledgedAt: null });
    f.store.readMessage(claude.token, sent.message.id);
    f.store.acknowledge(claude.token, sent.message.id);
    f.store.send(claude.token, {
      to: "reviewer",
      body: "Addressed",
      idempotencyKey: "response",
      replyTo: sent.message.id,
    });
    expect(f.store.receipt(codex.token, sent.message.id)).toMatchObject({
      state: "written",
      application: "replied",
      fetchedAt: 1000,
      acknowledgedAt: 1000,
      repliedAt: 1000,
    });
    expect(f.store.readMessage(claude.token, sent.message.id).receipt.application).toBe("replied");
    expect(f.store.acknowledge(claude.token, sent.message.id).receipt.application).toBe("replied");
  });

  test("opening the store never recovers another coordinator; explicit recovery holds ambiguity and readiness", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const first = f.store.send(claude.token, {
      to: "reviewer",
      body: "Possibly accepted",
      idempotencyKey: "first",
    });
    const second = f.store.send(claude.token, {
      to: "reviewer",
      body: "Never attempted",
      idempotencyKey: "second",
    });
    f.store.claimDelivery(codex.runtime.id, "codex");
    const reopened = f.open();
    expect(reopened.runtime(codex.runtime.id).ready).toBe(true);
    expect(reopened.receipt(claude.token, first.message.id).state).toBe("sending");
    reopened.recover();
    expect(reopened.receipt(claude.token, first.message.id)).toMatchObject({
      state: "ambiguous",
      policy: "held",
      application: "unread",
    });
    expect(reopened.receipt(claude.token, second.message.id)).toMatchObject({
      state: "prepared",
      policy: "held",
    });
    expect(reopened.runtimes().every((runtime) => !runtime.ready)).toBe(true);
    expect(reopened.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    reopened.setReady(codex.runtime.id, true);
    expect(reopened.claimDelivery(codex.runtime.id, "codex")!.message.id).toBe(second.message.id);
    code(() => reopened.finishDelivery(first.message.id, { state: "accepted" }), "conflict");
    reopened.recover();
    expect(reopened.messages().every((record) => record.receipt.state === "ambiguous")).toBe(true);
  });

  test("pause blocks new dispatch but permits recording in-flight outcomes and requires resume revalidation", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    const first = f.store.send(claude.token, { to: "reviewer", body: "In flight", idempotencyKey: "first" });
    f.store.claimDelivery(codex.runtime.id, "codex");
    f.store.pauseRuntime(codex.runtime.id, true);
    const second = f.store.send(claude.token, { to: "reviewer", body: "Held", idempotencyKey: "second" });
    expect(second.receipt.policy).toBe("held");
    expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    expect(f.store.finishDelivery(first.message.id, { state: "accepted" }).receipt.state).toBe("accepted");
    code(() => f.store.setReady(codex.runtime.id, true), "unavailable");
    f.store.pauseRuntime(codex.runtime.id, false);
    expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    f.store.setReady(codex.runtime.id, true);
    f.store.pauseRun(f.run.id, true);
    expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    f.store.pauseRun(f.run.id, false);
    expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    f.store.setReady(codex.runtime.id, true);
    expect(f.store.claimDelivery(codex.runtime.id, "codex")!.message.id).toBe(second.message.id);
  });

  test("rejection and ambiguity preserve raw correlated detail without retries or route fallback", () => {
    const f = fixture();
    const { claude, codex } = f.pair();
    for (const state of ["rejected", "ambiguous"] as const) {
      const sent = f.store.send(claude.token, { to: "reviewer", body: state, idempotencyKey: state });
      f.store.claimDelivery(codex.runtime.id, "codex");
      const detail = JSON.stringify({ code: -32603, message: "pinned native response" });
      const finished = f.store.finishDelivery(sent.message.id, { state, detail });
      expect(finished.receipt).toMatchObject({
        state,
        detail,
        policy: state === "ambiguous" ? "held" : "refused",
      });
      expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    }
  });
});

describe("run limits and checkout ownership", () => {
  test("writer exclusion uses real checkout paths and survives revocation and expired runs", () => {
    const f = fixture();
    const owner = f.allocate("implementer", "claude", { access: "write" });
    const alias = join(f.dir, "alias");
    symlinkSync(join(f.dir, "implementer"), alias);
    const competing = { workspace: alias, access: "write" as const };
    code(() => f.allocate("reviewer", "codex", competing), "conflict");
    f.store.revokeRuntime(owner.runtime.id);
    code(() => f.allocate("reviewer", "codex", competing), "conflict");
    const reader = f.allocate("reviewer", "codex", { workspace: alias, access: "read" });
    expect(reader.runtime.workspace).toBe(realpathSync(join(f.dir, "implementer")));
    f.store.exitRuntime(reader.runtime.id);
    f.store.exitRuntime(owner.runtime.id);
    const next = f.allocate("reviewer", "codex", competing);
    expect(next.runtime.access).toBe("write");
    expect(f.store.runtime(owner.runtime.id).exited).toBe(true);
    f.advance(30_000);
    expect(f.store.runtime(next.runtime.id).exited).toBe(false);
    expect(f.store.run()!.brief).toBe(f.run.brief);
  });

  test("different linked checkout roots remain separate writer identities", () => {
    const f = fixture();
    const firstPath = join(f.dir, "implementer");
    const secondPath = join(f.dir, "reviewer");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "--quiet", "--initial-branch=main", firstPath);
    git(
      "-C",
      firstPath,
      "-c",
      "user.name=Bridge fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("-C", firstPath, "worktree", "add", "--quiet", "--detach", secondPath, "HEAD");
    expect(git("-C", firstPath, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
      git("-C", secondPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    mkdirSync(join(firstPath, "src"));
    const first = f.allocate("implementer", "claude", { access: "write", workspace: join(firstPath, "src") });
    expect(first.runtime.workspace).toBe(realpathSync(firstPath));
    code(() => f.allocate("other", "codex", { access: "write", workspace: firstPath }), "conflict");
    const second = f.allocate("reviewer", "codex", { access: "write" });
    expect(first.runtime.workspace).not.toBe(second.runtime.workspace);
    expect(f.store.runtimes().filter((runtime) => runtime.access === "write")).toHaveLength(2);
  });

  test("run expiry and message budget stop new delivery without breaking idempotent receipts", () => {
    const f = fixture({ maxMessages: 1 });
    const { claude, codex } = f.pair();
    const input = { to: "reviewer", body: "Only message", idempotencyKey: "one" };
    const sent = f.store.send(claude.token, input);
    code(() => f.store.send(claude.token, { ...input, idempotencyKey: "two" }), "limit");
    expect(f.store.send(claude.token, input).message.id).toBe(sent.message.id);
    f.advance(20_000);
    expect(f.store.claimDelivery(codex.runtime.id, "codex")).toBeNull();
    expect(f.store.send(claude.token, input).receipt.policy).toBe("expired");
    code(() => f.store.send(claude.token, { ...input, idempotencyKey: "late" }), "unavailable");
  });

  test("reply chains enforce exact peer scope and follow-up budget", () => {
    const f = fixture({ maxHops: 1 });
    const { claude, codex } = f.pair();
    const third = f.bind(f.allocate("other", "claude"));
    const first = f.store.send(claude.token, { to: "reviewer", body: "Review", idempotencyKey: "first" });
    code(
      () =>
        f.store.send(third.token, {
          to: "implementer",
          body: "Pretend reply",
          idempotencyKey: "wrong",
          replyTo: first.message.id,
        }),
      "forbidden",
    );
    const response = f.store.send(codex.token, {
      to: "implementer",
      body: "Findings",
      idempotencyKey: "response",
      replyTo: first.message.id,
    });
    expect(response.message.hops).toBe(1);
    code(
      () =>
        f.store.send(claude.token, {
          to: "reviewer",
          body: "More",
          idempotencyKey: "again",
          replyTo: response.message.id,
        }),
      "limit",
    );
    expect(f.store.messages()).toHaveLength(2);
    expect(f.store.receipt(claude.token, first.message.id).application).toBe("replied");
    expect(f.store.receipt(codex.token, response.message.id).application).toBe("unread");
  });

  test("observations persist exact session provenance without binding or readiness changes", () => {
    const f = fixture();
    const allocated = f.allocate("implementer", "claude");
    const event = {
      source: "hook",
      name: "SessionStart",
      sessionId: allocated.runtime.expectedSessionId!,
      data: { cwd: allocated.runtime.workspace },
    };
    const appended = f.store.appendObservation(allocated.runtime.id, event);
    expect(f.store.runtime(allocated.runtime.id).sessionId).toBeNull();
    expect(f.store.runtime(allocated.runtime.id).ready).toBe(false);
    code(
      () => f.store.appendObservation(allocated.runtime.id, { ...event, sessionId: randomUUID() }),
      "conflict",
    );
    const reopened = f.open();
    expect(reopened.observations()).toEqual([appended]);
    code(() => reopened.observations(1001), "invalid");
  });
});

describe("versioned task and review coordination", () => {
  const artifact = { commit: "a".repeat(40), summary: "Implemented the requested artifact and checked it." };
  function setup(limits: Partial<CreateRunInput> = {}) {
    const f = fixture(limits);
    const { claude, codex } = f.pair();
    const task = f.store.createTask({
      runId: f.run.id,
      title: "Implement and review",
      brief: "Produce an artifact; the reviewer must accept it.",
      implementerRuntimeId: claude.runtime.id,
      reviewerRuntimeId: codex.runtime.id,
    });
    const claim = () => f.store.claimTask(claude.token, { taskId: task.id, expectedVersion: 1 });
    const submit = () => f.store.submitTask(claude.token, { taskId: task.id, expectedVersion: 2, artifact });
    return { ...f, claude, codex, task, claim, submit };
  }

  test("creates one task before native binding without fabricating an agent notification", () => {
    const f = fixture();
    const claude = f.allocate("implementer", "claude");
    const codex = f.allocate("reviewer", "codex");
    const input = {
      runId: f.run.id,
      title: "Artifact",
      brief: "Implement and review it.",
      implementerRuntimeId: claude.runtime.id,
      reviewerRuntimeId: codex.runtime.id,
    };
    code(() => f.store.createTask({ ...input, reviewerRuntimeId: claude.runtime.id }), "forbidden");
    const task = f.store.createTask(input);
    expect(task).toMatchObject({ ...input, state: "ready", version: 1, artifact: null, reviewSummary: null });
    expect(f.store.task()).toEqual(task);
    expect(f.store.messages()).toEqual([]);
    code(() => f.store.createTask(input), "conflict");
    code(() => f.store.readTask(claude.token), "unauthorized");
    code(() => f.store.claimTask(claude.token, { taskId: task.id, expectedVersion: 1 }), "unauthorized");
    f.bind(claude);
    f.bind(codex);
    expect(f.store.readTask(claude.token)).toEqual(task);
    expect(f.store.readTask(codex.token, task.id)).toEqual(task);
    const stranger = f.bind(f.allocate("other", "claude"));
    code(() => f.store.readTask(stranger.token), "forbidden");
    expect(JSON.stringify(task)).not.toContain(claude.token);
    expect(JSON.stringify(task)).not.toContain("credential");
  });

  test("only assigned roles progress work, request changes, and accept the submitted artifact", () => {
    const f = setup();
    const input = { taskId: f.task.id, expectedVersion: 1 };
    code(() => f.store.claimTask(f.codex.token, input), "forbidden");
    code(() => f.store.submitTask(f.claude.token, { ...input, artifact }), "conflict");
    expect(f.claim()).toMatchObject({ state: "working", version: 2, artifact: null });
    expect(f.store.messages()).toHaveLength(0);
    f.advance(5);
    const submitted = f.submit();
    expect(submitted.task).toMatchObject({ state: "review", version: 3, artifact, updatedAt: 1005 });
    expect(submitted.notification.message).toMatchObject({
      senderRuntimeId: f.claude.runtime.id,
      recipientRuntimeId: f.codex.runtime.id,
      recipientSessionId: f.codex.runtime.sessionId,
      idempotencyKey: `task:${f.task.id}:v3`,
    });
    expect(JSON.parse(submitted.notification.message.body)).toEqual({
      type: "task_transition", taskId: f.task.id, state: "review", version: 3, artifact, reviewSummary: null,
    });
    f.store.acknowledge(f.codex.token, submitted.notification.message.id);
    expect(f.store.task()).toEqual(submitted.task);
    const review = { taskId: f.task.id, expectedVersion: 3, decision: "changes_requested" as const, summary: "Add the missing check." };
    code(() => f.store.reviewTask(f.claude.token, review), "forbidden");
    const changes = f.store.reviewTask(f.codex.token, review);
    expect(changes.task).toMatchObject({ state: "changes_requested", version: 4, reviewSummary: review.summary });
    expect(changes.notification.message.recipientRuntimeId).toBe(f.claude.runtime.id);
    expect(f.store.claimTask(f.claude.token, { taskId: f.task.id, expectedVersion: 4 })).toMatchObject({
      state: "working", version: 5, reviewSummary: review.summary,
    });
    const revised = { commit: "b".repeat(40), summary: "Added the missing check." };
    expect(f.store.submitTask(f.claude.token, { taskId: f.task.id, expectedVersion: 5, artifact: revised }).task)
      .toMatchObject({ state: "review", version: 6, artifact: revised, reviewSummary: null });
    const accepted = f.store.reviewTask(f.codex.token, {
      taskId: f.task.id, expectedVersion: 6, decision: "accept", summary: "Verified the revised commit.",
    });
    expect(accepted.task).toMatchObject({ state: "accepted", version: 7, artifact: revised });
    expect(accepted.notification.receipt).toMatchObject({ state: "prepared", application: "unread" });
    code(() => f.store.claimTask(f.claude.token, { taskId: f.task.id, expectedVersion: 7 }), "conflict");
    f.store.exitRuntime(f.claude.runtime.id);
    f.store.exitRuntime(f.codex.runtime.id);
    expect(f.store.task()).toEqual(accepted.task);
    expect(f.store.messages()).toHaveLength(4);
  });

  test("independent store connections reject stale versions without duplicate transitions or notices", () => {
    const f = setup();
    const another = f.open();
    f.claim();
    code(() => another.claimTask(f.claude.token, { taskId: f.task.id, expectedVersion: 1 }), "conflict");
    const submitted = another.submitTask(f.claude.token, { taskId: f.task.id, expectedVersion: 2, artifact });
    code(() => f.submit(), "conflict");
    const review = { taskId: f.task.id, expectedVersion: 3, decision: "accept" as const, summary: "Reviewed." };
    const accepted = f.store.reviewTask(f.codex.token, review);
    code(() => another.reviewTask(f.codex.token, review), "conflict");
    expect(another.readTask(f.claude.token)).toEqual(accepted.task);
    expect(another.messages()).toHaveLength(2);
    expect(another.messages()[0]!.message.id).toBe(submitted.notification.message.id);
  });

  test("recovery preserves task state and never treats notification delivery as acceptance", () => {
    const f = setup();
    f.claim();
    const submitted = f.submit();
    f.store.claimDelivery(f.codex.runtime.id, "codex");
    const reopened = f.open();
    expect(reopened.task()).toEqual(submitted.task);
    reopened.recover();
    expect(reopened.task()).toEqual(submitted.task);
    expect(reopened.messages()[0]!.receipt).toMatchObject({ state: "ambiguous", policy: "held" });
    reopened.acknowledge(f.codex.token, submitted.notification.message.id);
    reopened.exitRuntime(f.claude.runtime.id);
    expect(reopened.task()).toEqual(submitted.task);
    code(() => reopened.reviewTask(f.codex.token, {
      taskId: f.task.id, expectedVersion: 3, decision: "accept", summary: "Reviewed.",
    }), "unauthorized");
    expect(reopened.task()).toEqual(submitted.task);
  });

  test("notification budgets roll back both submission and reviewer acceptance", () => {
    const f = setup({ maxMessages: 1 });
    const working = f.claim();
    f.store.send(f.claude.token, { to: "reviewer", body: "Existing message", idempotencyKey: "existing" });
    code(() => f.submit(), "limit");
    expect(f.store.task()).toEqual(working);
    expect(f.store.messages()).toHaveLength(1);

    const g = setup({ maxMessages: 1 });
    g.claim();
    const submitted = g.submit();
    code(() => g.store.reviewTask(g.codex.token, {
      taskId: g.task.id, expectedVersion: 3, decision: "accept", summary: "Reviewed.",
    }), "limit");
    expect(g.store.task()).toEqual(submitted.task);
    expect(g.store.messages()).toEqual([submitted.notification]);
  });

  test("task notices form exact reply chains and roll back when the follow-up limit is reached", () => {
    const f = setup({ maxHops: 1 });
    f.claim();
    const submitted = f.submit();
    const changes = f.store.reviewTask(f.codex.token, {
      taskId: f.task.id, expectedVersion: 3, decision: "changes_requested", summary: "Revise it.",
    });
    expect(submitted.notification.message).toMatchObject({ replyTo: null, hops: 0 });
    expect(changes.notification.message).toMatchObject({ replyTo: submitted.notification.message.id, hops: 1 });
    const working = f.store.claimTask(f.claude.token, { taskId: f.task.id, expectedVersion: 4 });
    code(() => f.store.submitTask(f.claude.token, {
      taskId: f.task.id, expectedVersion: 5, artifact: { ...artifact, commit: "b".repeat(40) },
    }), "limit");
    expect(f.store.task()).toEqual(working);
    expect(f.store.messages()).toHaveLength(2);
    expect(f.store.receipt(f.codex.token, changes.notification.message.id).application).toBe("unread");
    const reopened = f.open();
    code(() => reopened.submitTask(f.claude.token, {
      taskId: f.task.id, expectedVersion: 5, artifact,
    }), "limit");
    expect(reopened.task()).toEqual(working);
  });

  test("submission requires the assigned reviewer binding and leaves work intact while unavailable", () => {
    const f = fixture();
    const claude = f.bind(f.allocate("implementer", "claude"));
    const codex = f.allocate("reviewer", "codex");
    const task = f.store.createTask({
      runId: f.run.id, title: "Artifact", brief: "Implement and review it.",
      implementerRuntimeId: claude.runtime.id, reviewerRuntimeId: codex.runtime.id,
    });
    const working = f.store.claimTask(claude.token, { taskId: task.id, expectedVersion: 1 });
    code(() => f.store.submitTask(claude.token, { taskId: task.id, expectedVersion: 2, artifact }), "unavailable");
    expect(f.store.task()).toEqual(working);
    expect(f.store.messages()).toHaveLength(0);
    f.bind(codex);
    expect(f.store.submitTask(claude.token, { taskId: task.id, expectedVersion: 2, artifact }).task.state).toBe("review");
  });

  test("adds the private notice pointer to an earlier task table without changing its task", () => {
    const f = setup();
    const working = f.claim();
    const raw = new Database(f.path);
    raw.exec("ALTER TABLE coordination_task DROP COLUMN last_notice_id");
    raw.close();
    const reopened = f.open();
    expect(reopened.task()).toEqual(working);
    expect(reopened.submitTask(f.claude.token, { taskId: f.task.id, expectedVersion: 2, artifact }).task.state).toBe("review");
    expect(f.open().task()).toMatchObject({ state: "review", version: 3 });
  });

  test("a delivery-row failure rolls back the task and its already-inserted message", () => {
    const f = setup();
    const working = f.claim();
    const raw = new Database(f.path);
    raw.exec("CREATE TRIGGER reject_task_notice BEFORE INSERT ON delivery_attempt BEGIN SELECT RAISE(ABORT, 'fixture delivery failure'); END");
    raw.close();
    expect(() => f.submit()).toThrow("fixture delivery failure");
    const reopened = f.open();
    expect(reopened.task()).toEqual(working);
    expect(reopened.messages()).toHaveLength(0);
    expect(reopened.readTask(f.codex.token)).toEqual(working);
  });

  test("task participants never follow replacements with the same AgentId", () => {
    const f = setup();
    const working = f.claim();
    f.store.revokeRuntime(f.codex.runtime.id);
    const replacement = f.bind(f.allocate("reviewer", "codex"));
    code(() => f.store.readTask(replacement.token), "forbidden");
    code(() => f.store.reviewTask(replacement.token, {
      taskId: f.task.id, expectedVersion: 2, decision: "accept", summary: "Pretend review.",
    }), "forbidden");
    code(() => f.submit(), "unauthorized");
    expect(f.store.task()).toEqual(working);
    expect(f.store.messages()).toHaveLength(0);
  });

  test("pause holds task notifications while expiry blocks mutations without erasing review state", () => {
    const f = setup();
    f.store.pauseRun(f.run.id, true);
    f.claim();
    const submitted = f.submit();
    expect(submitted.notification.receipt.policy).toBe("held");
    expect(f.store.claimDelivery(f.codex.runtime.id, "codex")).toBeNull();
    f.advance(20_000);
    code(() => f.store.reviewTask(f.codex.token, {
      taskId: f.task.id, expectedVersion: 3, decision: "accept", summary: "Reviewed too late.",
    }), "unavailable");
    expect(f.store.readTask(f.codex.token)).toEqual(submitted.task);
    expect(f.store.messages()[0]!.receipt.policy).toBe("expired");
  });

  test("rejects malformed versions, artifacts, extra authority, and preoccupied notice keys", () => {
    const f = setup();
    for (const expectedVersion of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      code(() => f.store.claimTask(f.claude.token, { taskId: f.task.id, expectedVersion }), "invalid");
    code(() => f.store.claimTask(f.claude.token, { taskId: "x".repeat(257), expectedVersion: 1 }), "invalid");
    f.claim();
    const input = { taskId: f.task.id, expectedVersion: 2, artifact };
    for (const commit of ["HEAD", "a".repeat(39), "a".repeat(64), "A".repeat(40)])
      code(() => f.store.submitTask(f.claude.token, { ...input, artifact: { ...artifact, commit } }), "invalid");
    for (const summary of [" ", "é".repeat(2049)])
      code(() => f.store.submitTask(f.claude.token, { ...input, artifact: { ...artifact, summary } }), "invalid");
    code(() => f.store.submitTask(f.claude.token, { ...input, reviewerRuntimeId: f.claude.runtime.id } as SubmitTaskInput), "invalid");
    code(() => f.store.submitTask(f.claude.token, { ...input, artifact: null } as unknown as SubmitTaskInput), "invalid");
    f.store.send(f.claude.token, {
      to: "reviewer", body: "Preoccupied task key", idempotencyKey: `task:${f.task.id}:v3`,
    });
    code(() => f.submit(), "conflict");
    expect(f.store.task()).toMatchObject({ state: "working", version: 2, artifact: null });
    expect(f.store.messages()).toHaveLength(1);
  });
});
