import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
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

describe("generated native configuration", () => {
  test("rejects symlinked Codex parent directories before creating any native configuration", () => {
    const cfg = pilot();
    const outside = directory();
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
    expect(() => writeNativeConfig({ ...cfg, repo: outside }, endpoint)).toThrow(
      /invalid pilot derived paths/,
    );
    for (const port of [0, 65536, 1.5])
      expect(() => writeNativeConfig(cfg, { ...endpoint, port })).toThrow(/invalid pilot endpoint port/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(cfg.root, "claude.settings.json"))).toBe(false);
    expect(existsSync(join(cfg.repo, ".codex"))).toBe(false);
  });

  test("generates token-free configs with command-only SessionStart and main-checkout Codex hooks", () => {
    const cfg = pilot();
    writeNativeConfig(cfg, endpoint);
    const settingsPath = join(cfg.root, "claude.settings.json");
    const mcpPath = join(cfg.root, "claude.mcp.json");
    const codexPath = join(cfg.repo, ".codex", "hooks.json");
    const settings = readPrivateJson<{
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    }>(settingsPath);
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
