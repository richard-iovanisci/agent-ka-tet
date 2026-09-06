import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPilot,
  preparePilot,
  readPrivateJson,
  shellQuote,
  sourceFile,
  writeNativeConfig,
  writePrivateJson,
  type PilotConfig,
  type PilotEndpoint,
} from "./config.ts";
import { openCoordinationStore } from "../coordination/store.ts";
import type { Run, Task } from "../coordination/types.ts";

const cleanup: string[] = [];
const endpoint: PilotEndpoint = {
  pid: 1234,
  born: "fixture-start",
  port: 4771,
  instance: "fixture-instance",
};

afterEach(() => {
  for (const path of cleanup.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "bridge-pilot-config-test-")));
  cleanup.push(path);
  return path;
}

function pilot(): PilotConfig {
  const cfg = preparePilot(join(directory(), "pilot with spaces"));
  cleanup.push(cfg.socketDir);
  return cfg;
}

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(
    ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function sourceRepository() {
  const source = directory();
  git(source, "init", "--quiet", "--template=", "--initial-branch=main");
  writeFileSync(join(source, "artifact.txt"), "committed source\n");
  git(source, "add", "artifact.txt");
  git(
    source,
    "-c",
    "user.name=Bridge fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Committed source",
  );
  return { source, baseCommit: git(source, "rev-parse", "HEAD") };
}

function taskPilot() {
  const source = sourceRepository();
  const brief = "Implement the requested change.\nReview the committed artifact.";
  const cfg = preparePilot(join(directory(), "task run with spaces"), { project: source.source, brief });
  cleanup.push(cfg.socketDir);
  return { ...source, brief, cfg };
}

describe("disposable pilot configuration", () => {
  test("prepares distinct Git worktrees behind a private root with private state and sockets", () => {
    const cfg = pilot();
    expect(loadPilot(cfg.root)).toEqual(cfg);
    expect(cfg.agents.map((agent) => [agent.id, agent.kind])).toEqual([
      ["claude", "claude"],
      ["codex", "codex"],
    ]);
    expect(new Set(cfg.agents.map((agent) => agent.workspace)).size).toBe(2);
    expect(new Set(cfg.agents.map((agent) => agent.runtimeId)).size).toBe(2);
    expect(new Set([cfg.operatorToken, ...cfg.agents.map((agent) => agent.token)]).size).toBe(3);
    expect(cfg.agents[0]!.sessionId).toBeDefined();
    expect(cfg.agents[1]!.sessionId).toBeUndefined();
    for (const path of [cfg.root, cfg.socketDir]) {
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(statSync(path).uid).toBe(process.getuid!());
    }
    for (const path of [cfg.db, join(cfg.root, "pilot.json"), join(cfg.root, "PLAN.md")]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    for (const agent of cfg.agents) {
      expect(dirname(agent.workspace)).toBe(cfg.root);
      expect(git(agent.workspace, "rev-parse", "--show-toplevel")).toBe(agent.workspace);
      expect(realpathSync(git(agent.workspace, "rev-parse", "--git-common-dir"))).toBe(
        join(cfg.repo, ".git"),
      );
      expect(git(agent.workspace, "branch", "--show-current")).toBe(`pilot/${agent.kind}`);
      expect(git(agent.workspace, "status", "--porcelain")).toBe("");
    }
    writeFileSync(join(cfg.agents[0]!.workspace, "claude-only.txt"), "separate checkout\n");
    expect(existsSync(join(cfg.agents[1]!.workspace, "claude-only.txt"))).toBe(false);
    expect(existsSync(cfg.socketPath)).toBe(false);
    expect(existsSync(join(cfg.root, "endpoint.json"))).toBe(false);
    const hooks = readPrivateJson<{ hooks: Record<string, unknown> }>(join(cfg.repo, ".codex", "hooks.json"));
    expect(Object.keys(hooks.hooks)).toHaveLength(7);
    const prepared = readFileSync(join(cfg.repo, ".codex", "hooks.json"), "utf8");
    for (const token of [cfg.operatorToken, ...cfg.agents.map((agent) => agent.token)])
      expect(prepared).not.toContain(token);
  });

  test("refuses an existing destination without modifying its contents", () => {
    const path = directory();
    const sentinel = join(path, "keep.txt");
    writeFileSync(sentinel, "existing work");
    expect(() => preparePilot(path)).toThrow(/already exists/);
    expect(readFileSync(sentinel, "utf8")).toBe("existing work");
    expect(existsSync(join(path, "pilot.json"))).toBe(false);
  });

  test("loads a canonical root alias but rejects a mismatched stored root", () => {
    const cfg = pilot();
    const alias = join(dirname(cfg.root), "pilot alias");
    symlinkSync(cfg.root, alias);
    expect(loadPilot(alias)).toEqual(cfg);
    writePrivateJson(join(cfg.root, "pilot.json"), { ...cfg, root: alias });
    expect(() => loadPilot(cfg.root)).toThrow(/invalid pilot identity/);
  });

  test("rejects a public root or configuration file and a symlinked configuration", () => {
    const cfg = pilot();
    const path = join(cfg.root, "pilot.json");
    chmodSync(cfg.root, 0o755);
    expect(() => loadPilot(cfg.root)).toThrow(/private and owned/);
    chmodSync(cfg.root, 0o700);
    chmodSync(path, 0o644);
    expect(() => loadPilot(cfg.root)).toThrow(/owned private file/);
    chmodSync(path, 0o600);
    const target = join(cfg.root, "other.json");
    writePrivateJson(target, cfg);
    unlinkSync(path);
    symlinkSync(target, path);
    expect(() => loadPilot(cfg.root)).toThrow(/owned private file/);
    expect(readPrivateJson<PilotConfig>(target)).toEqual(cfg);
  });

  test("rejects malformed identity and roster changes", () => {
    const cfg = pilot();
    const path = join(cfg.root, "pilot.json");
    for (const changed of [
      { ...cfg, version: 2 },
      { ...cfg, id: "not-a-pilot-id" },
      { ...cfg, agents: cfg.agents.slice(0, 1) },
      { ...cfg, agents: cfg.agents.slice().reverse() },
    ]) {
      writePrivateJson(path, changed);
      expect(() => loadPilot(cfg.root)).toThrow(/invalid pilot (identity|roster)/);
    }
  });

  test("rejects changed derived paths, kind identities, and persisted runtime credentials", () => {
    const cfg = pilot();
    const path = join(cfg.root, "pilot.json");
    const claude = cfg.agents[0]!;
    const codex = cfg.agents[1]!;
    const cases = [
      { ...cfg, repo: dirname(cfg.root) },
      { ...cfg, db: join(cfg.root, "another.sqlite") },
      { ...cfg, socketPath: join(cfg.socketDir, "default.sock") },
      { ...cfg, tmuxSocket: "default" },
      { ...cfg, tmuxSession: "another-session" },
      { ...cfg, agents: [{ ...claude, kind: "codex" }, codex] },
      { ...cfg, agents: [{ ...claude, workspace: codex.workspace }, codex] },
      { ...cfg, agents: [{ ...claude, runtimeId: randomUUID() }, codex] },
      { ...cfg, agents: [{ ...claude, token: randomBytes(32).toString("base64url") }, codex] },
      { ...cfg, agents: [{ ...claude, sessionId: randomUUID() }, codex] },
      { ...cfg, runId: randomUUID() },
    ];
    for (const changed of cases) {
      writePrivateJson(path, changed);
      expect(() => loadPilot(cfg.root)).toThrow(/invalid pilot|does not match persisted state/);
    }
    writePrivateJson(path, cfg);
    expect(loadPilot(cfg.root)).toEqual(cfg);
  });

  test("rejects another pilot's socket directory and preserves its ownership marker", () => {
    const cfg = pilot();
    const other = pilot();
    const marker = join(other.socketDir, "pilot-owner.json");
    const before = readFileSync(marker, "utf8");
    writePrivateJson(join(cfg.root, "pilot.json"), {
      ...cfg,
      socketDir: other.socketDir,
      socketPath: other.socketPath,
    });
    expect(() => loadPilot(cfg.root)).toThrow(/belongs to another pilot/);
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  test("rejects a redirected checkout directory or database before opening foreign state", () => {
    const cfg = pilot();
    const originalRepo = join(cfg.root, "original-repo");
    renameSync(cfg.repo, originalRepo);
    symlinkSync(originalRepo, cfg.repo);
    expect(() => loadPilot(cfg.root)).toThrow(/directory without symlinks/);
    unlinkSync(cfg.repo);
    renameSync(originalRepo, cfg.repo);
    const originalDb = join(cfg.root, "original.sqlite");
    renameSync(cfg.db, originalDb);
    const before = readFileSync(originalDb);
    symlinkSync(originalDb, cfg.db);
    expect(() => loadPilot(cfg.root)).toThrow(/owned private pilot database/);
    expect(readFileSync(originalDb)).toEqual(before);
  });

  test("retains credentials and loadable ownership records after revocation and verified exit", () => {
    const cfg = pilot();
    const before = readFileSync(join(cfg.root, "pilot.json"), "utf8");
    const store = openCoordinationStore(cfg.db);
    try {
      store.revokeRuntime(cfg.agents[0]!.runtimeId);
      store.exitRuntime(cfg.agents[1]!.runtimeId);
    } finally {
      store.close();
    }
    expect(loadPilot(cfg.root)).toEqual(cfg);
    expect(readFileSync(join(cfg.root, "pilot.json"), "utf8")).toBe(before);
  });
});

describe("private JSON state", () => {
  test("publishes replacement state privately without following a destination symlink", () => {
    const root = directory();
    const path = join(root, "state.json");
    writePrivateJson(path, { revision: 1 });
    writePrivateJson(path, { revision: 2 });
    expect(readPrivateJson<unknown>(path)).toEqual({ revision: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const target = join(root, "untouched.json");
    writePrivateJson(target, { untouched: true });
    unlinkSync(path);
    symlinkSync(target, path);
    writePrivateJson(path, { revision: 3 });
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readPrivateJson<unknown>(path)).toEqual({ revision: 3 });
    expect(readPrivateJson<unknown>(target)).toEqual({ untouched: true });
  });

  test("rejects directories, public files, symlinks, and ownership mismatch", () => {
    const root = directory();
    const path = join(root, "private.json");
    writePrivateJson(path, { private: true });
    expect(() => readPrivateJson(root)).toThrow(/owned private file/);
    chmodSync(path, 0o640);
    expect(() => readPrivateJson(path)).toThrow(/owned private file/);
    chmodSync(path, 0o600);
    const alias = join(root, "alias.json");
    symlinkSync(path, alias);
    expect(() => readPrivateJson(alias)).toThrow(/owned private file/);
    const currentUid = statSync(path).uid;
    const uid = spyOn(process, "getuid").mockReturnValue(currentUid + 1);
    try {
      expect(() => readPrivateJson(path)).toThrow(/owned private file/);
    } finally {
      uid.mockRestore();
    }
  });
});

describe("task run preparation", () => {
  test("refuses nested destinations directly or through a symlink before touching the source", () => {
    const { source, baseCommit } = sourceRepository();
    const alias = join(directory(), "source alias");
    symlinkSync(source, alias);
    const entries = readdirSync(source).sort();
    const config = readFileSync(join(source, ".git", "config"));
    for (const parent of [source, alias]) {
      const destination = join(parent, "new runs", "nested run");
      expect(() => preparePilot(destination, { project: source, brief: "Make a change." })).toThrow(
        /outside the source checkout/,
      );
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(source, "new runs"))).toBe(false);
      expect(readdirSync(source).sort()).toEqual(entries);
      expect(readFileSync(join(source, ".git", "config"))).toEqual(config);
      expect(readFileSync(join(source, "artifact.txt"), "utf8")).toBe("committed source\n");
      expect(git(source, "status", "--porcelain")).toBe("");
      expect(git(source, "rev-parse", "HEAD")).toBe(baseCommit);
    }
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(realpathSync(alias)).toBe(source);
  });

  test("clones committed source without sharing object files or changing source worktrees", () => {
    const { source, baseCommit } = sourceRepository();
    const before = {
      status: git(source, "status", "--porcelain"),
      branches: git(source, "for-each-ref", "--format=%(refname) %(objectname)"),
      config: readFileSync(join(source, ".git", "config")),
    };
    const cfg = preparePilot(join(directory(), "isolated task"), {
      project: source,
      brief: "Make a change.",
    });
    cleanup.push(cfg.socketDir);
    expect(cfg.task).toEqual({ sourceRepo: source, baseCommit });
    expect(loadPilot(cfg.root)).toEqual(cfg);
    expect(git(cfg.repo, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(git(cfg.repo, "branch", "--show-current")).toBe("");
    const object = join("objects", baseCommit.slice(0, 2), baseCommit.slice(2));
    const sourceObject = join(source, ".git", object);
    const cloneObject = join(cfg.repo, ".git", object);
    expect(readFileSync(cloneObject)).toEqual(readFileSync(sourceObject));
    expect(statSync(cloneObject).ino).not.toBe(statSync(sourceObject).ino);
    expect(existsSync(join(cfg.repo, ".git", "objects", "info", "alternates"))).toBe(false);
    for (const agent of cfg.agents) {
      expect(git(agent.workspace, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(git(agent.workspace, "branch", "--show-current")).toBe(`bridge/${cfg.id}/${agent.kind}`);
      expect(realpathSync(git(agent.workspace, "rev-parse", "--git-common-dir"))).toBe(
        join(cfg.repo, ".git"),
      );
    }
    writeFileSync(join(cfg.agents[0]!.workspace, "artifact.txt"), "isolated edit\n");
    expect(readFileSync(join(source, "artifact.txt"), "utf8")).toBe("committed source\n");
    expect(readFileSync(join(cfg.agents[1]!.workspace, "artifact.txt"), "utf8")).toBe("committed source\n");
    expect(git(source, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(git(source, "status", "--porcelain")).toBe(before.status);
    expect(git(source, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before.branches);
    expect(readFileSync(join(source, ".git", "config"))).toEqual(before.config);
    expect(existsSync(join(source, ".git", "worktrees"))).toBe(false);
    expect(existsSync(join(source, ".codex"))).toBe(false);
  });

  test("persists immutable task roles and nine explicit Bridge permissions with separate checkout access", () => {
    const { cfg, brief } = taskPilot();
    const db = new Database(cfg.db, { readonly: true });
    try {
      const runtimes = db
        .query<
          { id: string; agent_id: string; access: string; workspace: string },
          []
        >("SELECT id, agent_id, access, workspace FROM runtime_attempt ORDER BY agent_id")
        .all();
      expect(runtimes).toEqual([
        {
          id: cfg.agents[0]!.runtimeId,
          agent_id: "claude",
          access: "write",
          workspace: cfg.agents[0]!.workspace,
        },
        {
          id: cfg.agents[1]!.runtimeId,
          agent_id: "codex",
          access: "read",
          workspace: cfg.agents[1]!.workspace,
        },
      ]);
      const tasks = db.query<{ value: string }, []>("SELECT value FROM coordination_task").all();
      expect(tasks).toHaveLength(1);
      expect(JSON.parse(tasks[0]!.value) as Task).toMatchObject({
        runId: cfg.runId,
        brief,
        implementerRuntimeId: cfg.agents[0]!.runtimeId,
        reviewerRuntimeId: cfg.agents[1]!.runtimeId,
        state: "ready",
        version: 1,
        artifact: null,
        reviewSummary: null,
      });
      const run = JSON.parse(
        db.query<{ value: string }, []>("SELECT value FROM coordination_run").get()!.value,
      ) as Run;
      expect(run).toMatchObject({ brief, maxMessages: 32, maxHops: 8 });
      expect(run.expiresAt - run.createdAt).toBeGreaterThan(4 * 60 * 60 * 1000 - 1000);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM bridge_message").get()!.count,
      ).toBe(0);
    } finally {
      db.close();
    }
    writeNativeConfig(cfg, endpoint);
    const settings = readPrivateJson<{ permissions: { allow: string[] } }>(
      join(cfg.root, "claude.settings.json"),
    );
    expect(settings.permissions.allow).toEqual([
      "mcp__agent-bridge__bridge_send_message",
      "mcp__agent-bridge__bridge_read_message",
      "mcp__agent-bridge__bridge_ack_message",
      "mcp__agent-bridge__bridge_list_agents",
      "mcp__agent-bridge__bridge_inbox",
      "mcp__agent-bridge__bridge_task_read",
      "mcp__agent-bridge__bridge_task_claim",
      "mcp__agent-bridge__bridge_task_submit",
      "mcp__agent-bridge__bridge_task_review",
    ]);
    expect(Object.keys(settings.permissions)).toEqual(["allow"]);
  });

  test.each(["tracked", "staged", "untracked"] as const)(
    "refuses %s source changes before creating the destination",
    (kind) => {
      const { source, baseCommit } = sourceRepository();
      const changed = join(source, kind === "untracked" ? "new.txt" : "artifact.txt");
      writeFileSync(changed, "uncommitted work\n");
      if (kind === "staged") git(source, "add", "artifact.txt");
      const status = git(source, "status", "--porcelain");
      const destination = join(directory(), "must not exist");
      expect(() => preparePilot(destination, { project: source, brief: "Make a change." })).toThrow(
        /uncommitted/,
      );
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(changed, "utf8")).toBe("uncommitted work\n");
      expect(git(source, "status", "--porcelain")).toBe(status);
      expect(git(source, "rev-parse", "HEAD")).toBe(baseCommit);
    },
  );

  test.each(["hooks", "symlink", "file"] as const)(
    "refuses a tracked Codex %s conflict before creating the run",
    (kind) => {
      const { source } = sourceRepository();
      const path = join(source, ".codex");
      if (kind === "hooks") {
        mkdirSync(path);
        writeFileSync(join(path, "hooks.json"), '{"hooks":{}}\n');
      } else if (kind === "symlink") symlinkSync("missing-config", path);
      else writeFileSync(path, "tracked config placeholder\n");
      git(source, "add", ".codex");
      git(
        source,
        "-c",
        "user.name=Bridge fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Track existing config",
      );
      const base = git(source, "rev-parse", "HEAD");
      const destination = join(directory(), "must not exist");
      expect(() => preparePilot(destination, { project: source, brief: "Make a change." })).toThrow(
        /cannot reconcile tracked/,
      );
      expect(existsSync(destination)).toBe(false);
      expect(git(source, "rev-parse", "HEAD")).toBe(base);
      expect(git(source, "status", "--porcelain")).toBe("");
    },
  );

  test("ignores inherited Git directory and worktree overrides during source probes, clone, and setup", () => {
    const { source, baseCommit } = sourceRepository();
    const foreign = sourceRepository();
    writeFileSync(join(foreign.source, "foreign.txt"), "foreign sentinel\n");
    const before = git(foreign.source, "status", "--porcelain");
    const inherited = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    try {
      process.env.GIT_DIR = join(foreign.source, ".git");
      process.env.GIT_WORK_TREE = foreign.source;
      const cfg = preparePilot(join(directory(), "clean clone"), {
        project: source,
        brief: "Make a change.",
      });
      cleanup.push(cfg.socketDir);
      expect(cfg.task).toEqual({ sourceRepo: source, baseCommit });
      expect(loadPilot(cfg.root)).toEqual(cfg);
      writeNativeConfig(cfg, endpoint);
      expect(git(cfg.repo, "rev-parse", "--show-toplevel")).toBe(cfg.repo);
      expect(existsSync(join(cfg.repo, ".codex", "hooks.json"))).toBe(true);
      expect(existsSync(join(foreign.source, ".codex"))).toBe(false);
      expect(existsSync(join(foreign.source, ".git", "worktrees"))).toBe(false);
      expect(git(foreign.source, "status", "--porcelain")).toBe(before);
      expect(git(foreign.source, "rev-parse", "HEAD")).toBe(foreign.baseCommit);
      expect(readFileSync(join(foreign.source, "foreign.txt"), "utf8")).toBe("foreign sentinel\n");
      expect(git(source, "status", "--porcelain")).toBe("");
    } finally {
      for (const key of ["GIT_DIR", "GIT_WORK_TREE"] as const) {
        if (inherited[key] === undefined) delete process.env[key];
        else process.env[key] = inherited[key];
      }
    }
  });

  test("source inspection never executes a repository fsmonitor callback", () => {
    const { source } = sourceRepository();
    const sentinel = join(directory(), "fsmonitor-ran");
    const callback = join(directory(), "fsmonitor.sh");
    writeFileSync(callback, `#!/bin/sh\ntouch ${shellQuote(sentinel)}\n`, { mode: 0o700 });
    git(source, "config", "core.fsmonitor", callback);
    const config = readFileSync(join(source, ".git", "config"));
    const cfg = preparePilot(join(directory(), "isolated task"), {
      project: source,
      brief: "Make a change.",
    });
    cleanup.push(cfg.socketDir);
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(source, ".git", "config"))).toEqual(config);
    expect(loadPilot(cfg.root)).toEqual(cfg);
  });

  test("rejects task mode removal, a changed base, and persisted role or access mismatches", () => {
    const { cfg } = taskPilot();
    const path = join(cfg.root, "pilot.json");
    writePrivateJson(path, { ...cfg, task: undefined });
    expect(() => loadPilot(cfg.root)).toThrow(/does not match persisted state/);
    writePrivateJson(path, { ...cfg, task: { ...cfg.task, baseCommit: "0".repeat(40) } });
    expect(() => loadPilot(cfg.root)).toThrow(/does not match persisted state/);
    writePrivateJson(path, cfg);
    const db = new Database(cfg.db);
    try {
      db.query("UPDATE coordination_task SET implementer_id = ?, reviewer_id = ?").run(
        cfg.agents[1]!.runtimeId,
        cfg.agents[0]!.runtimeId,
      );
      expect(() => loadPilot(cfg.root)).toThrow(/does not match persisted state/);
      db.query("UPDATE coordination_task SET implementer_id = ?, reviewer_id = ?").run(
        cfg.agents[0]!.runtimeId,
        cfg.agents[1]!.runtimeId,
      );
      db.query("UPDATE runtime_attempt SET access = 'write' WHERE id = ?").run(cfg.agents[1]!.runtimeId);
      expect(() => loadPilot(cfg.root)).toThrow(/does not match persisted state/);
      db.query("UPDATE runtime_attempt SET access = 'read' WHERE id = ?").run(cfg.agents[1]!.runtimeId);
      expect(loadPilot(cfg.root)).toEqual(cfg);
    } finally {
      db.close();
    }
  });
});

describe("generated native configuration", () => {
  test("rejects symlinked Codex parent directories before creating any native configuration", () => {
    const cfg = pilot();
    const outside = directory();
    rmSync(join(cfg.repo, ".codex"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "outside pilot");
    for (const parent of [cfg.repo, ...cfg.agents.map((agent) => agent.workspace)]) {
      const path = join(parent, ".codex");
      symlinkSync(outside, path);
      expect(() => loadPilot(cfg.root)).toThrow(/directory without symlinks/);
      expect(() => writeNativeConfig(cfg, endpoint)).toThrow(/directory without symlinks/);
      expect(readdirSync(outside)).toEqual(["keep.txt"]);
      expect(existsSync(join(cfg.root, "claude.settings.json"))).toBe(false);
      expect(existsSync(join(cfg.root, "claude.mcp.json"))).toBe(false);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      unlinkSync(path);
    }
  });

  test("rejects invalid caller destinations and endpoint ports before native writes", () => {
    const cfg = pilot();
    const outside = directory();
    const prepared = readFileSync(join(cfg.repo, ".codex", "hooks.json"), "utf8");
    expect(() => writeNativeConfig({ ...cfg, repo: outside }, endpoint)).toThrow(
      /invalid pilot derived paths/,
    );
    for (const port of [0, 65536, 1.5])
      expect(() => writeNativeConfig(cfg, { ...endpoint, port })).toThrow(/invalid pilot endpoint port/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(cfg.root, "claude.settings.json"))).toBe(false);
    expect(readFileSync(join(cfg.repo, ".codex", "hooks.json"), "utf8")).toBe(prepared);
  });

  test("generates token-free configs with command-only SessionStart and main-checkout Codex hooks", () => {
    const cfg = pilot();
    writeNativeConfig(cfg, endpoint);
    const settingsPath = join(cfg.root, "claude.settings.json");
    const mcpPath = join(cfg.root, "claude.mcp.json");
    const codexPath = join(cfg.repo, ".codex", "hooks.json");
    const settings = readPrivateJson<{
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
      permissions: { allow: string[] };
    }>(settingsPath);
    expect(settings.permissions.allow).toEqual([
      "mcp__agent-bridge__bridge_send_message",
      "mcp__agent-bridge__bridge_read_message",
      "mcp__agent-bridge__bridge_ack_message",
      "mcp__agent-bridge__bridge_list_agents",
      "mcp__agent-bridge__bridge_inbox",
    ]);
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.type).toBe("command");
    for (const event of ["UserPromptSubmit", "Stop", "SessionEnd", "PermissionRequest", "PostToolUse"]) {
      const hook = settings.hooks[event]![0]!.hooks[0]!;
      expect(hook.type).toBe("http");
      expect(hook.url).toBe(`http://127.0.0.1:${endpoint.port}/events`);
      expect(hook.headers).toEqual({ Authorization: "Bearer $AGENT_BRIDGE_TOKEN" });
      expect(hook.allowedEnvVars).toEqual(["AGENT_BRIDGE_TOKEN"]);
    }
    const mcp = readPrivateJson<{
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    }>(mcpPath);
    expect(mcp.mcpServers["agent-bridge"]).toEqual({
      command: process.execPath,
      args: [sourceFile("../native/mcp.ts"), "--channel"],
    });
    const codex = readPrivateJson<{ hooks: Record<string, unknown> }>(codexPath);
    expect(codex.hooks.SessionEnd).toBeDefined();
    expect(codex.hooks.Interrupt).toBeDefined();
    for (const agent of cfg.agents) {
      expect(statSync(join(agent.workspace, ".codex")).isDirectory()).toBe(true);
      expect(existsSync(join(agent.workspace, ".codex", "hooks.json"))).toBe(false);
    }
    for (const path of [settingsPath, mcpPath, codexPath]) {
      const text = readFileSync(path, "utf8");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const token of [cfg.operatorToken, ...cfg.agents.map((agent) => agent.token)])
        expect(text).not.toContain(token);
    }
    expect(readFileSync(join(cfg.root, "PLAN.md"), "utf8")).not.toContain(cfg.operatorToken);
  });

  test("identical regeneration preserves files and operator edits are refused intact", () => {
    const cfg = pilot();
    writeNativeConfig(cfg, endpoint);
    const paths = [
      join(cfg.root, "claude.settings.json"),
      join(cfg.root, "claude.mcp.json"),
      join(cfg.repo, ".codex", "hooks.json"),
    ];
    const before = paths.map((path) => ({ text: readFileSync(path, "utf8"), inode: statSync(path).ino }));
    writeNativeConfig(cfg, endpoint);
    for (const [i, path] of paths.entries()) {
      expect(readFileSync(path, "utf8")).toBe(before[i]!.text);
      expect(statSync(path).ino).toBe(before[i]!.inode);
    }
    const edited = `${before[2]!.text}\n`;
    writeFileSync(paths[2]!, edited);
    expect(() => writeNativeConfig(cfg, endpoint)).toThrow(/configuration changed/);
    expect(readFileSync(paths[2]!, "utf8")).toBe(edited);
    expect(readFileSync(paths[0]!, "utf8")).toBe(before[0]!.text);
    expect(readFileSync(paths[1]!, "utf8")).toBe(before[1]!.text);
  });

  test("refuses generated config symlinks without modifying their targets", () => {
    const cfg = pilot();
    const target = join(cfg.root, "keep.json");
    writePrivateJson(target, { keep: true });
    const path = join(cfg.root, "claude.settings.json");
    symlinkSync(target, path);
    expect(() => writeNativeConfig(cfg, endpoint)).toThrow(/owned private file/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readPrivateJson<unknown>(target)).toEqual({ keep: true });
  });
});

test("source paths decode spaces and shell quoting preserves literal metacharacters", () => {
  expect(sourceFile("fixture with spaces.ts")).toBe(
    join(dirname(fileURLToPath(import.meta.url)), "fixture with spaces.ts"),
  );
  const value = "spaces 'quotes' $(printf expanded) `printf expanded`\nnext";
  const result = Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${shellQuote(value)}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(value);
  expect(result.stderr.toString()).toBe("");
});
