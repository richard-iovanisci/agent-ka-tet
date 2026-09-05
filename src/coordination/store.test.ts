import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationError, openCoordinationStore } from "./store.ts";
import type { CreateRunInput, CreateRuntimeInput, RuntimeKind } from "./types.ts";

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
