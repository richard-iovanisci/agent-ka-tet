import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openCoordinationStore } from "../coordination/store.ts";
import type { RuntimeKind } from "../coordination/types.ts";
import { claudeNativeSettings } from "../run/launch.ts";
import { resolveLaunchSettings, validateLaunchSettings, type RunLaunchSettings } from "../run/settings.ts";

export interface PilotAgent {
  id: string;
  kind: RuntimeKind;
  workspace: string;
  runtimeId: string;
  token: string;
  sessionId?: string;
}

export interface PilotConfig {
  version: 1 | 2;
  launch?: RunLaunchSettings;
  id: string;
  root: string;
  repo: string;
  db: string;
  socketDir: string;
  socketPath: string;
  tmuxSocket: string;
  tmuxSession: string;
  operatorToken: string;
  runId: string;
  codexHistoryMode?: "legacy";
  task?: { sourceRepo: string; baseCommit: string };
  agents: PilotAgent[];
}

export interface PilotEndpoint {
  pid: number;
  born: string;
  port: number;
  instance: string;
}

export const pilotFile = (root: string, name: string) => join(root, name);
export const agentFile = (root: string, id: string, name: string) => join(root, `${id}.${name}.json`);
export const sourceFile = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function writeNativeJson(path: string, value: unknown): void {
  ownedDirectory(dirname(path));
  const text = JSON.stringify(value, null, 2) + "\n";
  if (existsSync(path)) {
    readPrivateJson(path);
    if (readFileSync(path, "utf8") !== text)
      throw new Error(`native pilot configuration changed; preserve and reconcile ${path}`);
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

export function readPrivateJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error(`expected an owned private file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function ownedDirectory(path: string, privateMode = false): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    realpathSync(path) !== path ||
    (privateMode && stat.mode & 0o077)
  ) {
    throw new Error(`expected an owned ${privateMode ? "private " : ""}directory without symlinks: ${path}`);
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function validatePilot(cfg: PilotConfig, canonical: string): void {
  if (!cfg || ![1, 2].includes(cfg.version) || cfg.root !== canonical || !/^[a-f0-9]{12}$/.test(cfg.id))
    throw new Error("invalid pilot identity");
  if (cfg.version === 2) {
    validateLaunchSettings(cfg.launch);
    if (!cfg.task) throw new Error("task configuration does not match persisted state");
  } else if (cfg.launch !== undefined) throw new Error("version-1 runs cannot change launch policy");
  if (cfg.version === 2) {
    const policy = readPrivateJson<{
      version: number;
      runId: string;
      digest: string;
    }>(pilotFile(canonical, "launch-policy.json"));
    if (policy.version !== 1 || policy.runId !== cfg.runId || policy.digest !== launchDigest(cfg.launch!))
      throw new Error("launch settings changed after preparation; prepare a new run");
  }
  if (cfg.codexHistoryMode !== undefined && cfg.codexHistoryMode !== "legacy")
    throw new Error("unsupported pilot Codex history mode");
  if (
    cfg.task &&
    (typeof cfg.task.sourceRepo !== "string" ||
      !cfg.task.sourceRepo.startsWith("/") ||
      !/^[a-f0-9]{40}$/.test(cfg.task.baseCommit))
  )
    throw new Error("invalid task source");
  if (
    !Array.isArray(cfg.agents) ||
    cfg.agents.length !== 2 ||
    cfg.agents.some(
      (agent, i) =>
        !agent ||
        agent.id !== ["claude", "codex"][i] ||
        agent.kind !== agent.id ||
        !UUID.test(agent.runtimeId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(agent.token) ||
        (agent.kind === "claude"
          ? !agent.sessionId || !UUID.test(agent.sessionId)
          : agent.sessionId !== undefined),
    ) ||
    new Set(cfg.agents.map((agent) => agent.runtimeId)).size !== 2 ||
    new Set(cfg.agents.map((agent) => agent.token)).size !== 2
  )
    throw new Error("invalid pilot roster");
  if (
    cfg.repo !== join(canonical, "repo") ||
    cfg.db !== join(canonical, "pilot.sqlite") ||
    cfg.tmuxSocket !== `ab-${cfg.id}` ||
    cfg.tmuxSession !== `bridge-pilot-${cfg.id}` ||
    cfg.agents.some((agent) => agent.workspace !== join(canonical, agent.id)) ||
    !UUID.test(cfg.runId) ||
    !/^[a-f0-9]{64}$/.test(cfg.operatorToken) ||
    typeof cfg.socketDir !== "string" ||
    dirname(cfg.socketDir) !== realpathSync("/tmp") ||
    !/^ab-[A-Za-z0-9]{6}$/.test(basename(cfg.socketDir)) ||
    cfg.socketPath !== join(cfg.socketDir, "codex.sock")
  )
    throw new Error("invalid pilot derived paths or credentials");
  for (const path of [cfg.repo, ...cfg.agents.map((agent) => agent.workspace)]) {
    ownedDirectory(path);
    const configDir = join(path, ".codex");
    if (lstatSync(configDir, { throwIfNoEntry: false })) ownedDirectory(configDir);
  }
  ownedDirectory(cfg.socketDir, true);
  const owner = readPrivateJson<{ id: string; root: string }>(join(cfg.socketDir, "pilot-owner.json"));
  if (owner.id !== cfg.id || owner.root !== canonical)
    throw new Error("pilot socket directory belongs to another pilot");
  const dbStat = lstatSync(cfg.db);
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.uid !== process.getuid?.() || dbStat.mode & 0o077)
    throw new Error("expected an owned private pilot database");
  const db = new Database(cfg.db, { readonly: true });
  try {
    if (!db.query("SELECT id FROM coordination_run WHERE id = ?").get(cfg.runId))
      throw new Error("pilot run does not match persisted state");
    for (const agent of cfg.agents) {
      const runtime = db
        .query<
          {
            run_id: string;
            agent_id: string;
            kind: string;
            workspace: string;
            access: string;
            credential_hash: string;
            expected_session_id: string | null;
            session_id: string | null;
          },
          [string]
        >(
          "SELECT run_id, agent_id, kind, workspace, access, credential_hash, expected_session_id, session_id FROM runtime_attempt WHERE id = ?",
        )
        .get(agent.runtimeId);
      if (
        !runtime ||
        runtime.run_id !== cfg.runId ||
        runtime.agent_id !== agent.id ||
        runtime.kind !== agent.kind ||
        runtime.workspace !== agent.workspace ||
        runtime.access !== (cfg.version === 1 && cfg.task && agent.kind === "codex" ? "read" : "write") ||
        runtime.credential_hash !== createHash("sha256").update(agent.token).digest("hex") ||
        (agent.kind === "claude" && runtime.expected_session_id !== agent.sessionId) ||
        (runtime.session_id !== null && runtime.session_id !== runtime.expected_session_id)
      )
        throw new Error("pilot runtime does not match persisted state");
    }
    if (cfg.task) {
      const task = db
        .query<
          { implementer_id: string; reviewer_id: string },
          [string]
        >("SELECT implementer_id, reviewer_id FROM coordination_task WHERE run_id = ?")
        .get(cfg.runId);
      if (
        !task ||
        task.implementer_id !== cfg.agents[0]!.runtimeId ||
        task.reviewer_id !== cfg.agents[1]!.runtimeId ||
        git(cfg.repo, ["rev-parse", "HEAD"]) !== cfg.task.baseCommit
      )
        throw new Error("task configuration does not match persisted state");
    }
  } finally {
    db.close();
  }
}

export function loadPilot(root: string): PilotConfig {
  const canonical = realpathSync(resolve(root));
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("pilot directory must be private and owned by this user");
  }
  const cfg = readPrivateJson<PilotConfig>(pilotFile(canonical, "pilot.json"));
  validatePilot(cfg, canonical);
  return cfg;
}

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = Bun.spawnSync(
    [
      "git",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function launchDigest(settings: RunLaunchSettings): string {
  return createHash("sha256")
    .update(JSON.stringify(resolveLaunchSettings(settings)))
    .digest("hex");
}

export function preparePilot(
  directory?: string,
  task?: { project: string; brief: string; settings?: RunLaunchSettings },
): PilotConfig {
  const launch = task ? resolveLaunchSettings(task.settings) : undefined;
  let source: { sourceRepo: string; baseCommit: string } | undefined;
  if (task) {
    if (!task.brief.trim() || Buffer.byteLength(task.brief) > 64 * 1024)
      throw new Error("task brief must contain 1–65536 bytes");
    const sourceRepo = realpathSync(git(realpathSync(task.project), ["rev-parse", "--show-toplevel"]));
    if (
      git(sourceRepo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none", "-z"])
    )
      throw new Error("source checkout has uncommitted changes; commit or stash them before preparing a run");
    const baseCommit = git(sourceRepo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("the prototype requires a SHA-1 Git repository");
    const trackedPaths = git(sourceRepo, ["ls-tree", "-r", "-z", "--name-only", baseCommit, "--"])
      .split("\0")
      .map((path) => path.toLowerCase());
    if (
      trackedPaths.some(
        (path) => path === ".codex" || path === ".codex/hooks.json" || path.startsWith(".codex/hooks.json/"),
      )
    )
      throw new Error(
        "the prototype cannot reconcile tracked .codex/hooks.json or a non-directory .codex path",
      );
    source = { sourceRepo, baseCommit };
  }
  const proposed = resolve(directory ?? join(tmpdir(), `bridge-pilot-${randomUUID()}`));
  if (existsSync(proposed)) throw new Error("pilot directory already exists");
  if (source) {
    let ancestor = proposed;
    const tail: string[] = [];
    while (!existsSync(ancestor)) {
      tail.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    const canonical = join(realpathSync(ancestor), ...tail);
    if (canonical === source.sourceRepo || canonical.startsWith(`${source.sourceRepo}/`))
      throw new Error("run directory must be outside the source checkout");
  }
  mkdirSync(proposed, { recursive: true, mode: 0o700 });
  chmodSync(proposed, 0o700);
  const root = realpathSync(proposed);
  const id = randomBytes(6).toString("hex");
  const repo = join(root, "repo");
  if (source) {
    git(root, ["clone", "--quiet", "--no-hardlinks", "--template=", "--", source.sourceRepo, repo]);
    git(repo, ["checkout", "--quiet", "--detach", source.baseCommit]);
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), ".claude/\n.codex/\n");
  } else {
    mkdirSync(repo);
    git(repo, ["init", "--quiet", "--template=", "--initial-branch=main"]);
    writeFileSync(
      join(repo, "README.md"),
      "# Agent Bridge native messaging pilot\n\nThis disposable repository contains no production work.\n",
    );
    writeFileSync(join(repo, ".gitignore"), ".claude/\n.codex/\n");
    git(repo, ["add", "README.md", ".gitignore"]);
    git(repo, [
      "-c",
      "user.name=Agent Bridge",
      "-c",
      "user.email=bridge@localhost",
      "commit",
      "--quiet",
      "-m",
      "Initialize isolated native pilot",
    ]);
  }
  const store = openCoordinationStore(join(root, "pilot.sqlite"));
  let cfg: PilotConfig;
  try {
    const run = store.createRun({
      brief: task?.brief.trim() ?? "S9/S13 native peer round trip",
      maxMessages: task ? 32 : 8,
      maxHops: task ? 8 : 4,
      ...(task ? { expiresAt: Date.now() + 4 * 60 * 60 * 1000 } : {}),
    });
    const agents = (["claude", "codex"] as const).map((kind) => {
      const workspace = join(root, kind);
      git(repo, [
        "worktree",
        "add",
        "--quiet",
        "-b",
        task ? `bridge/${id}/${kind}` : `pilot/${kind}`,
        workspace,
      ]);
      const sessionId = kind === "claude" ? randomUUID() : undefined;
      const { runtime, token } = store.createRuntime({
        runId: run.id,
        agentId: kind,
        kind,
        workspace,
        access: "write",
        ...(sessionId ? { expectedSessionId: sessionId } : {}),
      });
      return {
        id: kind,
        kind,
        workspace,
        runtimeId: runtime.id,
        token,
        ...(sessionId ? { sessionId } : {}),
      };
    });
    const socketDir = realpathSync(mkdtempSync("/tmp/ab-"));
    chmodSync(socketDir, 0o700);
    writePrivateJson(join(socketDir, "pilot-owner.json"), { id, root });
    cfg = {
      version: task ? 2 : 1,
      ...(launch ? { launch } : {}),
      id,
      root,
      repo,
      db: join(root, "pilot.sqlite"),
      socketDir,
      socketPath: join(socketDir, "codex.sock"),
      tmuxSocket: `ab-${id}`,
      tmuxSession: `bridge-pilot-${id}`,
      operatorToken: randomBytes(32).toString("hex"),
      runId: run.id,
      codexHistoryMode: "legacy",
      ...(source ? { task: source } : {}),
      agents,
    };
    if (task)
      store.createTask({
        runId: run.id,
        title: task.brief.trim().split("\n")[0]!.slice(0, 80),
        brief: task.brief.trim(),
        implementerRuntimeId: agents[0]!.runtimeId,
        reviewerRuntimeId: agents[1]!.runtimeId,
      });
    if (launch)
      writeNativeJson(pilotFile(root, "launch-policy.json"), {
        version: 1,
        runId: run.id,
        digest: launchDigest(launch),
      });
    writePrivateJson(pilotFile(root, "pilot.json"), cfg);
    const bridge = `${shellQuote(process.execPath)} ${shellQuote(sourceFile("../../bin/bridge"))} pilot`;
    const target = shellQuote(root);
    writeFileSync(
      pilotFile(root, "PLAN.md"),
      [
        "# S9/S13 native messaging pilot",
        "",
        `Run: ${id}`,
        "",
        "- New Claude Code and Codex native TUIs in a private tmux server.",
        "- Separate disposable Git worktrees; normal native trust and permissions.",
        "- One private Codex app-server; Claude development Channel; Bridge MCP tools.",
        "- Codex uses legacy history via an experimental startup capability; Astra with ultra reasoning.",
        "- Claude allows only the five Bridge MCP tools through this pilot's private settings file.",
        "- Operator starts a nonce-only Codex → Claude → Codex exchange after checking both TUIs.",
        "- No automatic composer mutation, approval forwarding, or retry after ambiguity.",
        "- Eight messages maximum, four reply hops, one-hour expiry from preparation.",
        "- The coordinator may stop independently; explicit stop terminates only this pilot.",
        "",
        "## Procedure",
        "",
        "After operator authorization:",
        "",
        "```sh",
        "claude --version",
        "codex --version",
        `env -u AGENT_BRIDGE_URL -u AGENT_BRIDGE_TOKEN codex -c 'model_reasoning_effort="ultra"' --model gpt-6-astra --cd ${shellQuote(repo)}`,
        "```",
        "",
        "In this setup TUI, trust the disposable project and enable its seven prepared /hooks handlers.",
        "Exit without submitting a prompt. Project trust must precede the private host; approving it",
        "after launch does not activate hooks in an already-loaded untrusted project layer.",
        "",
        "```sh",
        `${bridge} launch ${target} --live`,
        `${bridge} attach ${target}`,
        "```",
        "",
        "In the native TUIs, review project trust, the development Channel warning, Bridge MCP tools,",
        "and Codex /hooks. Leave each composer empty. Detach tmux with Ctrl-b d; then:",
        "",
        "```sh",
        `${bridge} ready ${target} claude`,
        `${bridge} ready ${target} codex`,
        `${bridge} start ${target}`,
        `${bridge} status ${target}`,
        "```",
        "",
        "The initial Codex operator turn requests PING. Claude reads and acknowledges it, replies PONG,",
        "and Codex reads and acknowledges that reply. Answer native permission prompts in the TUI.",
        "",
        "## Evidence and result",
        "",
        "Pass requires exactly two immutable messages with matching nonces, native session bindings,",
        "a Claude Channel write, a correlated Codex tool-output item/turn, and recipient read/ACK evidence",
        "in both directions. Confirm the same native TUIs remain usable. A transport write alone is not a pass.",
        "",
        "Record hook coverage separately. Missing hooks, Channel gating, hidden native items, drafts, and",
        "interruption/recovery need their own observations; this round trip does not close those gates.",
        "",
        "On failure or ambiguity, retain state and do not repeat start or delivery. Stop only this pilot:",
        "",
        "```sh",
        `${bridge} stop ${target}`,
        "```",
        "",
        `State: ${root}`,
        `Workspaces: ${agents.map((a) => a.workspace).join(", ")}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  } finally {
    store.close();
  }
  chmodSync(cfg.db, 0o600);
  writeCodexHooks(cfg);
  if (task) writeTaskPlan(cfg);
  return cfg;
}

function writeTaskPlan(cfg: PilotConfig): void {
  const bridge = `${shellQuote(process.execPath)} ${shellQuote(sourceFile("../../bin/bridge"))} run`;
  const root = shellQuote(cfg.root);
  writeFileSync(
    pilotFile(cfg.root, "PLAN.md"),
    [
      "# Native agent pair",
      "",
      "Claude implements and Codex reviews the committed artifact in separate worktrees.",
      "Both runtimes can write. The reviewer must keep its checkout clean at the recorded base.",
      "The source checkout is untouched. A task finishes only after reviewer acceptance.",
      "",
      "## Setup",
      "",
      "Review the prepared project and seven hooks in this setup Codex TUI, then exit without a prompt:",
      "",
      "```sh",
      `env -u AGENT_BRIDGE_URL -u AGENT_BRIDGE_TOKEN codex -c ${shellQuote(`model_reasoning_effort=${JSON.stringify(cfg.launch!.codex.effort)}`)} --model ${shellQuote(cfg.launch!.codex.model)} --cd ${shellQuote(cfg.repo)}`,
      "```",
      "",
      "Launch the native pair, review Claude's project/Channel prompts and both native sessions, then detach:",
      "",
      "```sh",
      `${bridge} launch ${root} --live`,
      `${bridge} attach ${root}`,
      "```",
      "",
      "The nine Bridge tools are pre-approved. Native launch settings are fixed at preparation:",
      "",
      "```json",
      JSON.stringify(cfg.launch, null, 2),
      "```",
      "",
      "Bypass is the default for new runs; native managed policies may still restrict it.",
      "Codex uses experimental legacy history on its private host. The budget is 32 messages and four hours.",
      "",
      "```sh",
      `${bridge} console ${root}`,
      "```",
      "",
      "Select each agent and press r after checking its native TUI. Press s to start the task.",
      "Enter opens the selected native session; Ctrl-b d returns. Entry pauses delivery until r resumes it.",
      "q closes only the console. Use the native TUI for permission prompts; peer messages cannot approve them.",
      "",
      "## Finish",
      "",
      "Inspect the accepted commit in the console. Export it without changing the source checkout:",
      "",
      "```sh",
      `${bridge} export ${root}`,
      `${bridge} stop ${root}`,
      "```",
      "",
      "If the coordinator fails, use run recover; unconfirmed sends remain held and are never replayed.",
      "Native agents retain their sessions. Trust changes after host startup require a fresh run.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function writeCodexHooks(cfg: PilotConfig): void {
  const directory = join(cfg.repo, ".codex");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const command = `${shellQuote(process.execPath)} ${shellQuote(sourceFile("../native/hook.ts"))}`;
  const hooks = Object.fromEntries(
    [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PermissionRequest",
      "PostToolUse",
      "SessionEnd",
      "Interrupt",
    ].map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 1 }] }]]),
  );
  writeNativeJson(join(directory, "hooks.json"), { hooks });
}

export function writeNativeConfig(cfg: PilotConfig, endpoint: PilotEndpoint): void {
  ownedDirectory(cfg.root, true);
  validatePilot(cfg, cfg.root);
  if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)
    throw new Error("invalid pilot endpoint port");
  const configDirs = [cfg.repo, ...cfg.agents.map((agent) => agent.workspace)].map((path) =>
    join(path, ".codex"),
  );
  for (const path of configDirs) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  }
  const hook = sourceFile("../native/hook.ts");
  const mcp = sourceFile("../native/mcp.ts");
  const url = `http://127.0.0.1:${endpoint.port}`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(hook)}`;
  const headers = { Authorization: "Bearer $AGENT_BRIDGE_TOKEN" };
  const http = {
    type: "http",
    url: `${url}/events`,
    headers,
    allowedEnvVars: ["AGENT_BRIDGE_TOKEN"],
    timeout: 1,
  };
  const hooks: Record<string, unknown> = {
    SessionStart: [{ hooks: [{ type: "command", command, timeout: 1 }] }],
  };
  for (const event of [
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "PermissionRequest",
    "PermissionDenied",
    ...(cfg.version === 2 ? ["PreToolUse"] : []),
    "PostToolUse",
    "Notification",
  ]) {
    hooks[event] = [{ hooks: [http] }];
  }
  const allow = bridgeToolNames(cfg).map((name) => `mcp__agent-bridge__${name}`);
  writeNativeJson(pilotFile(cfg.root, "claude.settings.json"), {
    hooks,
    permissions: { allow },
    ...(cfg.launch ? claudeNativeSettings(cfg.launch.claude) : {}),
  });
  writeNativeJson(pilotFile(cfg.root, "claude.mcp.json"), {
    mcpServers: {
      "agent-bridge": { command: process.execPath, args: [mcp, "--channel"] },
    },
  });
  writeCodexHooks(cfg);
}

export function bridgeToolNames(cfg: PilotConfig): string[] {
  return [
    "send_message",
    "read_message",
    "ack_message",
    "list_agents",
    "inbox",
    ...(cfg.task ? ["task_read", "task_claim", "task_submit", "task_review"] : []),
  ].map((name) => `bridge_${name}`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
