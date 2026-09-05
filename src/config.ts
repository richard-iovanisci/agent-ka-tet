import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./util/jsonc.ts";
import {
  AGENT_KINDS,
  isAgentKind,
  type AgentId,
  type AgentKind,
} from "./types.ts";

export interface AgentConfig {
  /** Stable configured instance identity used by panes, state, and handoffs. */
  id: AgentId;
  /** Native-TUI adapter implementation. */
  kind: AgentKind;
  enabled: boolean;
  /** Shell command that launches the native TUI (never a headless mode). */
  command: string;
  /** Working directory for the pane; defaults to the repo bridge runs in. */
  cwd?: string;
}

export interface BridgeConfig {
  /** Agent Bridge source checkout/build providing this runtime. */
  sourceRoot: string;
  /** Source-content identity captured when this runtime process loaded. */
  sourceFingerprint: string;
  /** tmux session name. */
  session: string;
  /** Daemon HTTP port, 127.0.0.1 only. */
  daemonPort: number;
  /** SQLite path for the event store. */
  db: string;
  /** Repo/workdir agents launch in when an agent has no cwd override. */
  repo: string;
  /**
   * Directory the config was loaded from (where bridge.config.jsonc lives).
   * The daemon is spawned with this — NOT cfg.repo, which may point elsewhere.
   */
  configDir: string;
  /** Ordered roster; this launcher supports one instance per adapter kind. */
  agents: AgentConfig[];
}

export function stateDir(): string {
  return join(homedir(), ".local", "state", "agent-bridge");
}

export const BRIDGE_SOURCE_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

function runtimeSourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (relative: string): void => {
    const absolute = join(root, relative);
    if (!existsSync(absolute)) {
      hash.update(`missing\0${relative}\0`);
      return;
    }
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        visit(join(relative, name));
      }
      return;
    }
    if (!stat.isFile()) return;
    hash.update(`file\0${relative}\0`);
    hash.update(readFileSync(absolute));
    hash.update("\0");
  };
  for (const relative of ["bin/bridge", "bun.lock", "package.json", "src", "tsconfig.json"]) {
    visit(relative);
  }
  return hash.digest("hex");
}

/** Captured once: a daemon keeps the identity of the code it actually loaded. */
export const BRIDGE_SOURCE_FINGERPRINT = runtimeSourceFingerprint(BRIDGE_SOURCE_ROOT);

export function defaultConfig(repo: string): BridgeConfig {
  return {
    sourceRoot: BRIDGE_SOURCE_ROOT,
    sourceFingerprint: BRIDGE_SOURCE_FINGERPRINT,
    session: "bridge",
    daemonPort: 4770,
    // AgentId is session-local, so history must be namespaced by target repo.
    db: join(
      stateDir(),
      "repos",
      createHash("sha256").update(repo).digest("hex").slice(0, 16),
      "events.sqlite",
    ),
    repo,
    configDir: repo,
    agents: [
      { id: "claude", kind: "claude", enabled: true, command: "claude" },
      { id: "codex", kind: "codex", enabled: true, command: "codex" },
    ],
  };
}

export const CONFIG_FILENAME = "bridge.config.jsonc";

/**
 * Stable identity for one loaded runtime configuration. The daemon exposes
 * this so `bridge up` never reuses a healthy process belonging to stale
 * settings or another target repo merely because the port matches.
 */
export function configFingerprint(cfg: BridgeConfig): string {
  const canonical = JSON.stringify({
    sourceRoot: cfg.sourceRoot,
    sourceFingerprint: cfg.sourceFingerprint,
    session: cfg.session,
    daemonPort: cfg.daemonPort,
    db: cfg.db,
    repo: cfg.repo,
    configDir: cfg.configDir,
    agents: cfg.agents,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface BridgeSessionMarker {
  configDir: string;
  configFingerprint: string;
}

/** Opaque value stored as a tmux user option on bridge-owned sessions. */
export function bridgeSessionMarker(cfg: BridgeConfig): string {
  return JSON.stringify({
    configDir: cfg.configDir,
    configFingerprint: configFingerprint(cfg),
  } satisfies BridgeSessionMarker);
}

export function parseBridgeSessionMarker(value: string | null): BridgeSessionMarker | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BridgeSessionMarker>;
    return typeof parsed.configDir === "string" &&
      typeof parsed.configFingerprint === "string"
      ? {
          configDir: parsed.configDir,
          configFingerprint: parsed.configFingerprint,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Load bridge.config.jsonc from `dir` (default cwd), merged over defaults.
 * Missing file is fine — defaults describe a working setup.
 */
export function loadConfig(dir: string = process.cwd()): BridgeConfig {
  const repo = resolve(dir);
  const base = defaultConfig(repo);
  const path = join(repo, CONFIG_FILENAME);
  if (!existsSync(path)) return base;

  const raw = parseJsonc(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: top level must be an object`);
  }
  const o = raw as Record<string, unknown>;

  const cfg: BridgeConfig = { ...base };
  if (o.session !== undefined) cfg.session = expectSessionName(o.session);
  if (o.daemonPort !== undefined) cfg.daemonPort = expectPort(o.daemonPort, "daemonPort");
  if (o.db !== undefined) cfg.db = expectString(o.db, "db");
  if (o.repo !== undefined) cfg.repo = resolve(repo, expectString(o.repo, "repo"));

  if (o.agents !== undefined) {
    if (!Array.isArray(o.agents)) throw new Error(`${path}: "agents" must be an ordered array`);
    const agents = parseCurrentRoster(o.agents, repo);
    validateRoster(agents, path);
    cfg.agents = agents;
  }
  return cfg;
}

function parseCurrentRoster(raw: unknown[], repo: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  for (const [index, a] of raw.entries()) {
    if (typeof a !== "object" || a === null) {
      throw new Error(`config: agents[${index}] must be an object`);
    }
    const ao = a as Record<string, unknown>;
    const id = expectAgentId(ao.id, `agents[${index}].id`);
    const kind = expectAgentKind(ao.kind, `agents[${index}].kind`);
    const agent: AgentConfig = {
      id,
      kind,
      enabled: ao.enabled === undefined ? true : expectBoolean(ao.enabled, `agents[${index}].enabled`),
      command: ao.command === undefined ? kind : expectString(ao.command, `agents[${index}].command`),
    };
    if (ao.cwd !== undefined) agent.cwd = resolve(repo, expectString(ao.cwd, `agents[${index}].cwd`));
    agents.push(agent);
  }
  return agents;
}

/** Return the configured instance for an adapter kind, if present. */
export function agentForKind(cfg: BridgeConfig, kind: AgentKind): AgentConfig | undefined {
  return cfg.agents.find((agent) => agent.kind === kind);
}

function expectString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`config: "${field}" must be a non-empty string`);
  return v;
}

function expectSessionName(v: unknown): string {
  const s = expectString(v, "session");
  // tmux silently rewrites '.' and ':' in session names, which would leave a
  // session that down/attach can never target — reject up front instead.
  if (/[.:\s]/.test(s)) {
    throw new Error(`config: "session" must not contain '.', ':' or whitespace (tmux renames such sessions): ${JSON.stringify(s)}`);
  }
  return s;
}

function expectBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new Error(`config: "${field}" must be a boolean`);
  return v;
}

function expectAgentKind(v: unknown, field: string): AgentKind {
  const kind = expectString(v, field);
  if (!isAgentKind(kind)) {
    throw new Error(`config: "${field}" must be "claude" or "codex"`);
  }
  return kind;
}

function expectAgentId(v: unknown, field: string): AgentId {
  const id = expectString(v, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`config: "${field}" must use letters, numbers, '_' or '-' and start with a letter or number`);
  }
  return id;
}

function validateRoster(agents: AgentConfig[], path: string): void {
  const ids = new Set<string>();
  const kinds = new Set<AgentKind>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`${path}: duplicate agent id "${agent.id}"`);
    if (kinds.has(agent.kind)) {
      throw new Error(`${path}: multiple "${agent.kind}" instances are not supported by this launcher`);
    }
    ids.add(agent.id);
    kinds.add(agent.kind);
  }
  for (const kind of AGENT_KINDS) {
    if (!kinds.has(kind)) {
      throw new Error(`${path}: this launcher requires one configured "${kind}" instance`);
    }
  }
}

function expectPort(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(`config: "${field}" must be an integer port (1-65535)`);
  }
  return v;
}
