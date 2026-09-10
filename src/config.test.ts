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
  test("missing file returns the ordered Claude + Codex roster", () => {
    const dir = tempRepo();
    const cfg = loadConfig(dir);

    expect(cfg.daemonPort).toBe(4770);
    expect(cfg.session).toBe("bridge");
    expect(cfg.agents).toEqual([
      { id: "claude", kind: "claude", enabled: true, command: "claude" },
      { id: "codex", kind: "codex", enabled: true, command: "codex" },
    ]);
    expect(cfg.repo).toContain("bridge-config-");
  });

  test("ordered roster accepts custom ids and fills per-kind defaults", () => {
    const dir = tempRepo(`{
      // custom port and deliberately reversed display/pane order
      "daemonPort": 5000,
      "agents": [
        { "id": "review_codex", "kind": "codex", "enabled": false },
        { "id": "primary-claude", "kind": "claude", "command": "claude --model opus" },
      ],
    }`);
    const cfg = loadConfig(dir);

    expect(cfg.daemonPort).toBe(5000);
    expect(cfg.agents).toEqual([
      { id: "review_codex", kind: "codex", enabled: false, command: "codex" },
      {
        id: "primary-claude",
        kind: "claude",
        enabled: true,
        command: "claude --model opus",
      },
    ]);
  });

  test("agents must be an ordered array", () => {
    for (const agents of ["claude", null, { claude: {} }]) {
      const dir = tempRepo(JSON.stringify({ agents }));
      expect(() => loadConfig(dir)).toThrow(/must be an ordered array/);
    }
  });

  test("unsupported adapter kind is rejected", () => {
    const dir = tempRepo('{"agents": [{"id": "cursor", "kind": "cursor"}]}');
    expect(() => loadConfig(dir)).toThrow(/must be "claude" or "codex"/);
  });

  test("duplicate agent ids are rejected", () => {
    const dir = tempRepo(`{
      "agents": [
        { "id": "pair", "kind": "claude" },
        { "id": "pair", "kind": "codex" },
      ]
    }`);
    expect(() => loadConfig(dir)).toThrow(/duplicate agent id "pair"/);
  });

  test("the current launcher rejects duplicate adapter kinds", () => {
    const dir = tempRepo(`{
      "agents": [
        { "id": "claude-a", "kind": "claude" },
        { "id": "claude-b", "kind": "claude" },
      ]
    }`);
    expect(() => loadConfig(dir)).toThrow(/multiple "claude" instances are not supported/);
  });

  test("the current launcher requires both adapter kinds", () => {
    const dir = tempRepo('{"agents": [{"id": "claude", "kind": "claude"}]}');
    expect(() => loadConfig(dir)).toThrow(/requires one configured "codex"/);
  });

  test("invalid agent ids are rejected", () => {
    const dir = tempRepo('{"agents": [{"id": "claude primary", "kind": "claude"}]}');
    expect(() => loadConfig(dir)).toThrow(/must use letters, numbers/);
  });

  test("bad port is rejected", () => {
    const dir = tempRepo('{"daemonPort": "4770"}');
    expect(() => loadConfig(dir)).toThrow(/must be an integer port/);
  });

  test("agent cwd resolves relative to the repo", () => {
    const dir = tempRepo(`{
      "agents": [
        { "id": "primary", "kind": "claude", "cwd": "sub/dir" },
        { "id": "reviewer", "kind": "codex" },
      ]
    }`);
    const cfg = loadConfig(dir);
    expect(cfg.agents[0]?.cwd).toBe(join(cfg.repo, "sub/dir"));
  });

  test("defaultConfig covers exactly two agents in pane order", () => {
    const cfg = defaultConfig("/x");
    expect(cfg.agents.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "claude", kind: "claude" },
      { id: "codex", kind: "codex" },
    ]);
  });

  test("default event database is namespaced by target repo", () => {
    expect(defaultConfig("/repo/a").db).not.toBe(defaultConfig("/repo/b").db);
    expect(defaultConfig("/repo/a").db).toBe(defaultConfig("/repo/a").db);
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
