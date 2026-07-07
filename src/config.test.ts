import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, defaultConfig, loadConfig } from "./config.ts";

function tempRepo(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  if (config !== undefined) writeFileSync(join(dir, CONFIG_FILENAME), config);
  return dir;
}

describe("loadConfig", () => {
  test("missing file returns defaults", () => {
    const dir = tempRepo();
    const cfg = loadConfig(dir);
    expect(cfg.daemonPort).toBe(4770);
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.session).toBe("bridge");
    expect(cfg.agents.claude.command).toBe("claude");
    expect(cfg.repo).toContain("bridge-config-");
  });

  test("partial config merges over defaults", () => {
    const dir = tempRepo(`{
      // custom port
      "daemonPort": 5000,
      "agents": { "codex": { "enabled": false } },
    }`);
    const cfg = loadConfig(dir);
    expect(cfg.daemonPort).toBe(5000);
    expect(cfg.agents.codex.enabled).toBe(false);
    expect(cfg.agents.codex.command).toBe("codex"); // untouched default
    expect(cfg.agents.claude.enabled).toBe(true);
  });

  test("unknown agent name is rejected", () => {
    const dir = tempRepo('{"agents": {"cursor": {}}}');
    expect(() => loadConfig(dir)).toThrow(/unknown agent "cursor"/);
  });

  test("bad port is rejected", () => {
    const dir = tempRepo('{"daemonPort": "4770"}');
    expect(() => loadConfig(dir)).toThrow(/must be an integer port/);
  });

  test("agent cwd resolves relative to the repo", () => {
    const dir = tempRepo('{"agents": {"claude": {"cwd": "sub/dir"}}}');
    const cfg = loadConfig(dir);
    expect(cfg.agents.claude.cwd).toBe(join(cfg.repo, "sub/dir"));
  });

  test("defaultConfig covers all four agents", () => {
    const cfg = defaultConfig("/x");
    expect(Object.keys(cfg.agents).sort()).toEqual(["agy", "claude", "codex", "opencode"]);
  });

  test("configDir records where the config was loaded from, independent of repo", () => {
    const dir = tempRepo('{"repo": "sub"}');
    const cfg = loadConfig(dir);
    expect(cfg.configDir).toBe(join(dir));
    expect(cfg.repo).toBe(join(dir, "sub"));
  });

  test("session names tmux would rename are rejected", () => {
    for (const bad of ["my.session", "a:b", "has space"]) {
      const dir = tempRepo(JSON.stringify({ session: bad }));
      expect(() => loadConfig(dir)).toThrow(/must not contain/);
    }
  });
});
