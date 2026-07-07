import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type BridgeConfig } from "../config.ts";
import { initClaude } from "./claude/init.ts";
import { initCodex, codexHookShimPath, codexNotifyShimPath } from "./codex/init.ts";
import { initAgy, agyHookShimPath, agyStatuslineShimPath } from "./agy/init.ts";
import { composeOpencodeCommand } from "./opencode/init.ts";

const silent = { print: () => {} };

function setup(): { cfg: BridgeConfig; home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "bridge-init-home-"));
  const repo = mkdtempSync(join(tmpdir(), "bridge-init-repo-"));
  return { cfg: defaultConfig(repo), home, repo };
}

describe("initClaude", () => {
  test("writes http hooks for all bridged events", () => {
    const { cfg, repo } = setup();
    const res = initClaude(cfg, { ...silent });
    expect(res.changed).toBe(true);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    for (const event of ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "PostToolUse", "Notification"]) {
      const groups = settings.hooks[event];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups[0].hooks[0]).toEqual({
        type: "http",
        url: "http://127.0.0.1:4770/events/claude",
        timeout: 10,
      });
    }
    expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt|idle_prompt|agent_needs_input");
  });

  test("is idempotent", () => {
    const { cfg } = setup();
    initClaude(cfg, { ...silent });
    const res = initClaude(cfg, { ...silent });
    expect(res.changed).toBe(false);
  });

  test("preserves foreign settings and foreign hooks", () => {
    const { cfg, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "/my/thing.sh" }] }] },
      }),
    );
    initClaude(cfg, { ...silent });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("/my/thing.sh");
    expect(settings.hooks.Stop[1].hooks[0].type).toBe("http");
  });

  test("refuses to clobber unparseable settings", () => {
    const { cfg, repo } = setup();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), "{not json");
    expect(() => initClaude(cfg, { ...silent })).toThrow(/refusing to touch/);
  });

  test("daemon port is respected in the url", () => {
    const { cfg, repo } = setup();
    cfg.daemonPort = 9999;
    initClaude(cfg, { ...silent });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].url).toBe("http://127.0.0.1:9999/events/claude");
  });

  test("changing daemonPort replaces old bridge groups instead of accumulating them", () => {
    const { cfg, repo } = setup();
    initClaude(cfg, { ...silent });
    cfg.daemonPort = 4771;
    initClaude(cfg, { ...silent });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].url).toBe("http://127.0.0.1:4771/events/claude");
  });

  test("writes settings.json into the claude pane's cwd override, not cfg.repo", () => {
    const { cfg, repo } = setup();
    const paneCwd = mkdtempSync(join(tmpdir(), "bridge-claude-cwd-"));
    cfg.agents.claude = { ...cfg.agents.claude, cwd: paneCwd };
    initClaude(cfg, { ...silent });
    expect(existsSync(join(paneCwd, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });
});

describe("initCodex", () => {
  test("writes executable shims, hooks.json and notify", () => {
    const { cfg, home } = setup();
    const opts = { ...silent, home };
    const res = initCodex(cfg, opts);
    expect(res.hooksJson.changed).toBe(true);
    expect(res.configTomlChanged).toBe(true);
    expect(res.notifyConflict).toBeNull();

    for (const shim of [codexHookShimPath(opts), codexNotifyShimPath(opts)]) {
      expect(existsSync(shim)).toBe(true);
      expect(statSync(shim).mode & 0o111).toBeGreaterThan(0);
      expect(readFileSync(shim, "utf8")).toContain("#!/usr/bin/env bash");
      expect(readFileSync(shim, "utf8")).toContain("http://127.0.0.1:4770/events/codex");
    }

    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"]) {
      expect(hooks.hooks[event][0].hooks[0]).toEqual({
        type: "command",
        command: codexHookShimPath(opts),
        timeout: 10,
      });
    }

    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain(`notify = ["${codexNotifyShimPath(opts)}"]`);
  });

  test("is idempotent (trust-hash safe: byte-identical re-runs)", () => {
    const { cfg, home } = setup();
    initCodex(cfg, { ...silent, home });
    const before = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
    const res = initCodex(cfg, { ...silent, home });
    expect(res.hooksJson.changed).toBe(false);
    expect(res.configTomlChanged).toBe(false);
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe(before);
  });

  test("notify conflict: foreign value left untouched, reported", () => {
    const { cfg, home } = setup();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'notify = ["my-notifier"]\n[section]\nx = 1\n');
    const res = initCodex(cfg, { ...silent, home });
    expect(res.notifyConflict).toBe('notify = ["my-notifier"]');
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('notify = ["my-notifier"]');
    expect(toml).not.toContain("bridge-codex-notify");
  });

  test("notify inserted at top, before any [section]", () => {
    const { cfg, home } = setup();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[profiles.default]\nmodel = \"o4\"\n");
    initCodex(cfg, { ...silent, home });
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const notifyIdx = toml.indexOf("notify = ");
    const sectionIdx = toml.indexOf("[profiles.default]");
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(notifyIdx).toBeLessThan(sectionIdx);
    expect(toml).toContain("model = \"o4\"");
  });

  test("preserves foreign codex hooks", () => {
    const { cfg, home } = setup();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/mine.sh" }] }] } }),
    );
    initCodex(cfg, { ...silent, home });
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("/mine.sh");
  });
});

describe("initAgy", () => {
  test("writes per-event shims with ?native= and both hooks.json locations", () => {
    const { cfg, home } = setup();
    const opts = { ...silent, home };
    const res = initAgy(cfg, opts);
    expect(res.hooksFiles).toHaveLength(2);

    for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
      const shim = agyHookShimPath(event, opts);
      expect(existsSync(shim)).toBe(true);
      expect(statSync(shim).mode & 0o111).toBeGreaterThan(0);
      expect(readFileSync(shim, "utf8")).toContain(`/events/agy?native=${event}`);
    }
    expect(existsSync(agyStatuslineShimPath(opts))).toBe(true);

    for (const path of [
      join(home, ".gemini", "config", "hooks.json"),
      join(home, ".gemini", "antigravity-cli", "hooks.json"),
    ]) {
      const root = JSON.parse(readFileSync(path, "utf8"));
      const block = root["agent-bridge"];
      expect(Object.keys(block).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
      expect(block.Stop[0].matcher).toBe("*");
      expect(block.Stop[0].hooks[0].type).toBe("command");
    }
  });

  test("is idempotent and preserves foreign named hooks", () => {
    const { cfg, home } = setup();
    const path = join(home, ".gemini", "config", "hooks.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(path, JSON.stringify({ "my-hook": { PreToolUse: [] } }));
    initAgy(cfg, { ...silent, home });
    const second = initAgy(cfg, { ...silent, home });
    expect(second.hooksFiles.every((r) => !r.changed)).toBe(true);
    const root = JSON.parse(readFileSync(path, "utf8"));
    expect(root["my-hook"]).toEqual({ PreToolUse: [] });
    expect(root["agent-bridge"]).toBeDefined();
  });
});

describe("composeOpencodeCommand", () => {
  test("appends --port and --hostname when missing", () => {
    const { cfg } = setup();
    expect(composeOpencodeCommand(cfg)).toBe("opencode --port 4096 --hostname 127.0.0.1");
  });

  test("respects an existing --port", () => {
    const { cfg } = setup();
    cfg.agents.opencode.command = "opencode --port 5000";
    expect(composeOpencodeCommand(cfg)).toBe("opencode --port 5000 --hostname 127.0.0.1");
  });

  test("respects a fully specified command", () => {
    const { cfg } = setup();
    cfg.agents.opencode.command = "opencode --port=5000 --hostname=0.0.0.0";
    expect(composeOpencodeCommand(cfg)).toBe("opencode --port=5000 --hostname=0.0.0.0");
  });

  test("uses the configured opencodePort", () => {
    const { cfg } = setup();
    cfg.opencodePort = 7777;
    expect(composeOpencodeCommand(cfg)).toContain("--port 7777");
  });
});
