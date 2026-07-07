import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./util/jsonc.ts";
import { AGENT_NAMES, type AgentName } from "./types.ts";

export interface AgentConfig {
  enabled: boolean;
  /** Shell command that launches the native TUI (never a headless mode). */
  command: string;
  /** Working directory for the pane; defaults to the repo bridge runs in. */
  cwd?: string;
}

export interface BridgeConfig {
  /** tmux session name. */
  session: string;
  /** Daemon HTTP port, 127.0.0.1 only. */
  daemonPort: number;
  /** OpenCode's pinned server port (its TUI always runs a local server). */
  opencodePort: number;
  /** SQLite path for the event store. */
  db: string;
  /** Repo/workdir agents launch in when an agent has no cwd override. */
  repo: string;
  /**
   * Directory the config was loaded from (where bridge.config.jsonc lives).
   * The daemon is spawned with this — NOT cfg.repo, which may point elsewhere.
   */
  configDir: string;
  agents: Record<AgentName, AgentConfig>;
}

export function stateDir(): string {
  return join(homedir(), ".local", "state", "agent-bridge");
}

export function defaultConfig(repo: string): BridgeConfig {
  return {
    session: "bridge",
    daemonPort: 4770,
    opencodePort: 4096,
    db: join(stateDir(), "events.sqlite"),
    repo,
    configDir: repo,
    agents: {
      claude: { enabled: true, command: "claude" },
      codex: { enabled: true, command: "codex" },
      agy: { enabled: true, command: "agy" },
      opencode: { enabled: true, command: "opencode" },
    },
  };
}

export const CONFIG_FILENAME = "bridge.config.jsonc";

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
  if (o.opencodePort !== undefined) cfg.opencodePort = expectPort(o.opencodePort, "opencodePort");
  if (o.db !== undefined) cfg.db = expectString(o.db, "db");
  if (o.repo !== undefined) cfg.repo = resolve(repo, expectString(o.repo, "repo"));

  if (o.agents !== undefined) {
    if (typeof o.agents !== "object" || o.agents === null) {
      throw new Error(`${path}: "agents" must be an object`);
    }
    const agents = o.agents as Record<string, unknown>;
    for (const key of Object.keys(agents)) {
      if (!(AGENT_NAMES as readonly string[]).includes(key)) {
        throw new Error(`${path}: unknown agent "${key}" (expected ${AGENT_NAMES.join(", ")})`);
      }
      const name = key as AgentName;
      const a = agents[key];
      if (typeof a !== "object" || a === null) {
        throw new Error(`${path}: agents.${key} must be an object`);
      }
      const ao = a as Record<string, unknown>;
      const merged: AgentConfig = { ...base.agents[name] };
      if (ao.enabled !== undefined) merged.enabled = expectBoolean(ao.enabled, `agents.${key}.enabled`);
      if (ao.command !== undefined) merged.command = expectString(ao.command, `agents.${key}.command`);
      if (ao.cwd !== undefined) merged.cwd = resolve(repo, expectString(ao.cwd, `agents.${key}.cwd`));
      cfg.agents = { ...cfg.agents, [name]: merged };
    }
  }
  return cfg;
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

function expectPort(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(`config: "${field}" must be an integer port (1-65535)`);
  }
  return v;
}
