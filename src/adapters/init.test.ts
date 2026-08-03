import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_AGENT_ID_ENV,
  BRIDGE_AGENT_ID_HEADER,
  BRIDGE_CONFIG_FINGERPRINT_ENV,
  BRIDGE_CONFIG_FINGERPRINT_HEADER,
} from "../attribution.ts";
import { defaultConfig, type BridgeConfig } from "../config.ts";
import {
  claudeSessionStartShimPath,
  initClaude,
  removeClaudeHooks,
} from "./claude/init.ts";
import {
  initCodex,
  codexHookShimPath,
  removeCodexHooks,
} from "./codex/init.ts";
import { retireLegacyIntegrations } from "./retireLegacy.ts";
import { quoteShellArg } from "./initCommon.ts";

const silent = { print: () => {} };

function setup(): { cfg: BridgeConfig; home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "bridge-init-home-"));
  const repo = mkdtempSync(join(tmpdir(), "bridge-init-repo-"));
  return { cfg: defaultConfig(repo), home, repo };
}

describe("initClaude", () => {
  test("writes http hooks for all bridged events", () => {
    const { cfg, home, repo } = setup();
    const opts = { ...silent, home };
    const res = initClaude(cfg, opts);
    expect(res.changed).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    );
    for (const event of [
      "SessionEnd",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "PermissionRequest",
      "PermissionDenied",
      "PostToolUse",
      "Notification",
    ]) {
      const groups = settings.hooks[event];
      expect(Array.isArray(groups)).toBe(true);
      expect(groups[0].hooks[0]).toEqual({
        type: "http",
        url: "http://127.0.0.1:4770/events/claude",
        timeout: 10,
        headers: {
          "X-Agent-Bridge": "1",
          [BRIDGE_AGENT_ID_HEADER]: `$${BRIDGE_AGENT_ID_ENV}`,
          [BRIDGE_CONFIG_FINGERPRINT_HEADER]:
            `$${BRIDGE_CONFIG_FINGERPRINT_ENV}`,
        },
        allowedEnvVars: [
          BRIDGE_AGENT_ID_ENV,
          BRIDGE_CONFIG_FINGERPRINT_ENV,
        ],
      });
    }
    expect(settings.hooks.Notification[0].matcher).toBe(
      "permission_prompt|agent_needs_input",
    );
    const sessionStart = settings.hooks.SessionStart[0].hooks[0];
    expect(sessionStart).toEqual({
      type: "command",
      command: quoteShellArg(claudeSessionStartShimPath(cfg, opts)),
      timeout: 10,
    });
    const sessionStartShim = claudeSessionStartShimPath(cfg, opts);
    expect(statSync(sessionStartShim).mode & 0o111).toBeGreaterThan(0);
    const shim = readFileSync(sessionStartShim, "utf8");
    expect(shim).toContain(
      "http://127.0.0.1:4770/events/claude",
    );
    expect(shim).toContain(
      `-H "${BRIDGE_AGENT_ID_HEADER}: \${${BRIDGE_AGENT_ID_ENV}:-}"`,
    );
    expect(shim).toContain(
      `-H "${BRIDGE_CONFIG_FINGERPRINT_HEADER}: \${${BRIDGE_CONFIG_FINGERPRINT_ENV}:-}"`,
    );
  });

  test("is idempotent", () => {
    const { cfg, home } = setup();
    initClaude(cfg, { ...silent, home });
    const res = initClaude(cfg, { ...silent, home });
    expect(res.changed).toBe(false);
  });

  test("replaces the previous idle-prompt matcher without accumulating groups", () => {
    const { cfg, home, repo } = setup();
    const opts = { ...silent, home };
    initClaude(cfg, opts);
    const path = join(repo, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.hooks.Notification[0].matcher =
      "permission_prompt|idle_prompt|agent_needs_input";
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(initClaude(cfg, opts).changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.Notification).toHaveLength(1);
    expect(after.hooks.Notification[0].matcher).toBe(
      "permission_prompt|agent_needs_input",
    );
  });

  test("preserves foreign settings and foreign hooks", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/my/thing.sh" }] },
            {
              hooks: [
                { type: "http", url: "http://127.0.0.1:9999/events/foreign" },
              ],
            },
          ],
        },
      }),
    );
    initClaude(cfg, { ...silent, home });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(3);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("/my/thing.sh");
    expect(settings.hooks.Stop[1].hooks[0].url).toContain("/events/foreign");
    expect(settings.hooks.Stop[2].hooks[0].headers["X-Agent-Bridge"]).toBe("1");
  });

  test("keeps foreign settings byte-stable on the second run without another backup", () => {
    const { cfg, home, repo } = setup();
    const directory = join(repo, ".claude");
    const path = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify({
      model: "opus",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/foreign.sh" }] }],
      },
    }));
    const opts = { ...silent, home };

    expect(initClaude(cfg, opts).changed).toBe(true);
    const afterFirst = readFileSync(path, "utf8");
    const backupsAfterFirst = readdirSync(directory)
      .filter((name) => name.startsWith("settings.json.bak."));
    expect(backupsAfterFirst).toHaveLength(1);

    expect(initClaude(cfg, opts).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(readdirSync(directory).filter((name) => name.startsWith("settings.json.bak.")))
      .toEqual(backupsAfterFirst);
  });

  test("prunes owned handlers inside a mixed group without losing foreign metadata", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: "keep-me",
            hooks: [
              {
                type: "http",
                url: "http://127.0.0.1:4770/events/old-id",
                headers: { "X-Agent-Bridge": "1" },
              },
              { type: "command", command: "/foreign.sh" },
            ],
          }],
        },
      }),
    );
    initClaude(cfg, { ...silent, home });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toEqual({
      matcher: "keep-me",
      hooks: [{ type: "command", command: "/foreign.sh" }],
    });
  });

  test("disabled cleanup removes only bridge-owned Claude handlers", () => {
    const { cfg, home, repo } = setup();
    initClaude(cfg, { ...silent, home });
    const path = join(repo, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.hooks.Stop.unshift({ hooks: [{ type: "command", command: "/foreign.sh" }] });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    expect(removeClaudeHooks(cfg, { ...silent, home }).changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "/foreign.sh" }] },
    ]);
    expect(after.hooks.SessionStart).toBeUndefined();
  });

  test("refuses to clobber unparseable settings", () => {
    const { cfg, home, repo } = setup();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), "{not json");
    expect(() => initClaude(cfg, { ...silent, home })).toThrow(/refusing to touch/);
  });

  test("refuses to replace a present non-object hooks section", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ model: "opus", hooks: [] }, null, 2)}\n`;
    writeFileSync(path, before);

    expect(() => initClaude(cfg, { ...silent, home })).toThrow(/refusing to touch/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses to replace a present non-array Claude event entry", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const before = `${JSON.stringify({ hooks: { Stop: { foreign: true } } }, null, 2)}\n`;
    writeFileSync(path, before);
    const opts = { ...silent, home };

    expect(() => initClaude(cfg, opts)).toThrow(/hook event "Stop".*refusing to touch/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(claudeSessionStartShimPath(cfg, opts))).toBe(false);
  });

  test("validates Claude SessionStart before writing its shim", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".claude", "settings.json");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const before = `${JSON.stringify({
      hooks: { SessionStart: { foreign: true } },
    }, null, 2)}\n`;
    writeFileSync(path, before);
    const opts = { ...silent, home };

    expect(() => initClaude(cfg, opts))
      .toThrow(/hook event "SessionStart".*refusing to touch/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(claudeSessionStartShimPath(cfg, opts))).toBe(false);
  });

  test("daemon port is respected in the url", () => {
    const { cfg, home, repo } = setup();
    cfg.daemonPort = 9999;
    initClaude(cfg, { ...silent, home });
    const settings = JSON.parse(
      readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop[0].hooks[0].url).toBe(
      "http://127.0.0.1:9999/events/claude",
    );
  });

  test("changing daemonPort replaces old bridge groups instead of accumulating them", () => {
    const { cfg, home, repo } = setup();
    initClaude(cfg, { ...silent, home });
    cfg.daemonPort = 4771;
    initClaude(cfg, { ...silent, home });
    const settings = JSON.parse(
      readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].url).toBe(
      "http://127.0.0.1:4771/events/claude",
    );
  });

  test("changing AgentId migrates the old bridge groups", () => {
    const { cfg, home, repo } = setup();
    initClaude(cfg, { ...silent, home });
    const claude = cfg.agents.find((agent) => agent.kind === "claude");
    if (claude === undefined) throw new Error("default Claude instance missing");
    claude.id = "primary-claude";
    initClaude(cfg, { ...silent, home });
    const settings = JSON.parse(
      readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].url).toBe(
      "http://127.0.0.1:4770/events/primary-claude",
    );
  });

  test("writes settings.json into the configured Claude instance cwd", () => {
    const { cfg, home, repo } = setup();
    const paneCwd = mkdtempSync(join(tmpdir(), "bridge-claude-cwd-"));
    const claude = cfg.agents.find((agent) => agent.kind === "claude");
    if (claude === undefined) throw new Error("default Claude instance missing");
    claude.id = "primary-claude";
    claude.cwd = paneCwd;

    initClaude(cfg, { ...silent, home });

    expect(existsSync(join(paneCwd, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
    const settings = JSON.parse(
      readFileSync(join(paneCwd, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop[0].hooks[0].url).toBe(
      "http://127.0.0.1:4770/events/primary-claude",
    );
  });
});

describe("initCodex", () => {
  test("writes an executable hook shim and hooks.json without claiming notify", () => {
    const { cfg, home, repo } = setup();
    const opts = { ...silent, home };
    const res = initCodex(cfg, opts);
    expect(res.hooksJson.changed).toBe(true);

    const shim = codexHookShimPath(cfg, opts);
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o111).toBeGreaterThan(0);
    const shimSource = readFileSync(shim, "utf8");
    expect(shimSource).toContain("#!/usr/bin/env bash");
    expect(shimSource).toContain(
      "http://127.0.0.1:4770/events/codex",
    );
    expect(shimSource).toContain(
      `-H "${BRIDGE_AGENT_ID_HEADER}: \${${BRIDGE_AGENT_ID_ENV}:-}"`,
    );
    expect(shimSource).toContain(
      `-H "${BRIDGE_CONFIG_FINGERPRINT_HEADER}: \${${BRIDGE_CONFIG_FINGERPRINT_ENV}:-}"`,
    );

    const hooks = JSON.parse(
      readFileSync(join(repo, ".codex", "hooks.json"), "utf8"),
    );
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PermissionRequest",
      "PostToolUse",
    ]) {
      expect(hooks.hooks[event][0].hooks[0]).toEqual({
        type: "command",
        command: quoteShellArg(shim),
        timeout: 10,
      });
    }

    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  test("is idempotent and trust-hash safe", () => {
    const { cfg, home, repo } = setup();
    initCodex(cfg, { ...silent, home });
    const before = readFileSync(join(repo, ".codex", "hooks.json"), "utf8");
    const res = initCodex(cfg, { ...silent, home });
    expect(res.hooksJson.changed).toBe(false);
    expect(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")).toBe(
      before,
    );
  });

  test("leaves an existing config.toml byte-identical", () => {
    const { cfg, home } = setup();
    const codexDir = join(home, ".codex");
    const tomlPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const before = 'notify = ["my-notifier"]\n[profiles.default]\nmodel = "o4"\n';
    writeFileSync(tomlPath, before);

    initCodex(cfg, { ...silent, home });

    expect(readFileSync(tomlPath, "utf8")).toBe(before);
  });

  test("targets the configured Codex instance id", () => {
    const { cfg, home } = setup();
    const codex = cfg.agents.find((agent) => agent.kind === "codex");
    if (codex === undefined) throw new Error("default Codex instance missing");
    codex.id = "review_codex";
    const opts = { ...silent, home };
    initCodex(cfg, opts);
    expect(readFileSync(codexHookShimPath(cfg, opts), "utf8")).toContain(
      "http://127.0.0.1:4770/events/review_codex",
    );
  });

  test("writes project hooks into the configured Codex instance cwd", () => {
    const { cfg, home, repo } = setup();
    const paneCwd = mkdtempSync(join(tmpdir(), "bridge-codex-cwd-"));
    const codex = cfg.agents.find((agent) => agent.kind === "codex");
    if (codex === undefined) throw new Error("default Codex instance missing");
    codex.cwd = paneCwd;
    initCodex(cfg, { ...silent, home });
    expect(existsSync(join(paneCwd, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(repo, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  test("preserves foreign Codex hooks", () => {
    const { cfg, home, repo } = setup();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "/mine.sh" }] }],
        },
      }),
    );
    initCodex(cfg, { ...silent, home });
    const hooks = JSON.parse(
      readFileSync(join(repo, ".codex", "hooks.json"), "utf8"),
    );
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("/mine.sh");
  });

  test("keeps foreign Codex hooks byte-stable on the second run without another backup", () => {
    const { cfg, home, repo } = setup();
    const directory = join(repo, ".codex");
    const path = join(directory, "hooks.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify({
      foreign: { keep: true },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/foreign.sh" }] }],
      },
    }));
    const opts = { ...silent, home };

    expect(initCodex(cfg, opts).hooksJson.changed).toBe(true);
    const afterFirst = readFileSync(path, "utf8");
    const backupsAfterFirst = readdirSync(directory)
      .filter((name) => name.startsWith("hooks.json.bak."));
    expect(backupsAfterFirst).toHaveLength(1);

    expect(initCodex(cfg, opts).hooksJson.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(readdirSync(directory).filter((name) => name.startsWith("hooks.json.bak.")))
      .toEqual(backupsAfterFirst);
  });

  test("refuses to replace a present non-object Codex hooks section", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".codex", "hooks.json");
    mkdirSync(join(repo, ".codex"), { recursive: true });
    const before = `${JSON.stringify({ foreign: true, hooks: [] }, null, 2)}\n`;
    writeFileSync(path, before);

    expect(() => initCodex(cfg, { ...silent, home })).toThrow(/refusing to touch/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses to replace a present non-array Codex event entry", () => {
    const { cfg, home, repo } = setup();
    const path = join(repo, ".codex", "hooks.json");
    mkdirSync(join(repo, ".codex"), { recursive: true });
    const before = `${JSON.stringify({ hooks: { Stop: { foreign: true } } }, null, 2)}\n`;
    writeFileSync(path, before);
    const opts = { ...silent, home };

    expect(() => initCodex(cfg, opts)).toThrow(/hook event "Stop".*refusing to touch/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(codexHookShimPath(cfg, opts))).toBe(false);
  });

  test("prunes owned Codex handlers inside mixed groups", () => {
    const { cfg, home, repo } = setup();
    const opts = { ...silent, home };
    const shim = codexHookShimPath(cfg, opts);
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: "keep-me",
            hooks: [
              { type: "command", command: shim },
              { type: "command", command: "/foreign.sh" },
            ],
          }],
        },
      }),
    );
    initCodex(cfg, opts);
    const root = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
    expect(root.hooks.Stop).toHaveLength(2);
    expect(root.hooks.Stop[0]).toEqual({
      matcher: "keep-me",
      hooks: [{ type: "command", command: "/foreign.sh" }],
    });
  });

  test("disabled cleanup removes only bridge-owned Codex handlers", () => {
    const { cfg, home, repo } = setup();
    const opts = { ...silent, home };
    initCodex(cfg, opts);
    const path = join(repo, ".codex", "hooks.json");
    const root = JSON.parse(readFileSync(path, "utf8"));
    root.hooks.Stop.unshift({ hooks: [{ type: "command", command: "/foreign.sh" }] });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
    expect(removeCodexHooks(cfg, opts).changed).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "/foreign.sh" }] },
    ]);
  });

  test("quotes generated hook paths for shell-special home directories", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge init home with space '"));
    const repo = mkdtempSync(join(tmpdir(), "bridge-init-repo-"));
    const cfg = defaultConfig(repo);
    const opts = { ...silent, home };
    initClaude(cfg, opts);
    initCodex(cfg, opts);

    const claude = JSON.parse(
      readFileSync(join(repo, ".claude", "settings.json"), "utf8"),
    );
    const codex = JSON.parse(
      readFileSync(join(repo, ".codex", "hooks.json"), "utf8"),
    );
    const commands = [
      claude.hooks.SessionStart[0].hooks[0].command,
      codex.hooks.SessionStart[0].hooks[0].command,
    ];
    expect(commands).toEqual([
      quoteShellArg(claudeSessionStartShimPath(cfg, opts)),
      quoteShellArg(codexHookShimPath(cfg, opts)),
    ]);
    for (const command of commands) {
      expect(Bun.spawnSync(["bash", "-c", `${command} </dev/null`]).exitCode).toBe(0);
    }
  });
});

describe("legacy integration retirement", () => {
  test("removes exact old notify and agy blocks but preserves unrelated config", () => {
    const { home } = setup();
    const opts = { ...silent, home };
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const notifyShim = join(
      home,
      ".local",
      "state",
      "agent-bridge",
      "shims",
      "bridge-codex-notify.sh",
    );
    writeFileSync(
      join(codexDir, "config.toml"),
      `# agent-bridge: forward turn-complete notifications to the daemon\nnotify = ["${notifyShim}"]\nmodel = "keep"\n`,
    );
    const oldHookShim = join(
      home,
      ".local",
      "state",
      "agent-bridge",
      "shims",
      "bridge-codex-hook.sh",
    );
    writeFileSync(
      join(codexDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: oldHookShim }] }],
          Stop: [{
            matcher: "keep-metadata",
            hooks: [
              { type: "command", command: oldHookShim },
              { type: "command", command: "/foreign.sh" },
            ],
          }],
        },
      }),
    );

    const agyDir = join(home, ".gemini", "config");
    mkdirSync(agyDir, { recursive: true });
    const block: Record<string, unknown> = {};
    for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
      block[event] = [{
        matcher: "*",
        hooks: [{
          type: "command",
          command: join(
            home,
            ".local",
            "state",
            "agent-bridge",
            "shims",
            `bridge-agy-hook-${event}.sh`,
          ),
          timeout: 10,
        }],
      }];
    }
    writeFileSync(
      join(agyDir, "hooks.json"),
      JSON.stringify({ "agent-bridge": block, foreign: { keep: true } }),
    );

    expect(retireLegacyIntegrations(opts)).toBe(0);
    expect(readFileSync(join(codexDir, "config.toml"), "utf8")).toBe(
      'model = "keep"\n',
    );
    const codexHooks = JSON.parse(readFileSync(join(codexDir, "hooks.json"), "utf8"));
    expect(codexHooks.hooks.SessionStart).toBeUndefined();
    expect(codexHooks.hooks.Stop).toEqual([{
      matcher: "keep-metadata",
      hooks: [{ type: "command", command: "/foreign.sh" }],
    }]);
    const after = JSON.parse(readFileSync(join(agyDir, "hooks.json"), "utf8"));
    expect(after["agent-bridge"]).toBeUndefined();
    expect(after.foreign).toEqual({ keep: true });
  });

  test("leaves a modified legacy agy block untouched", () => {
    const { home } = setup();
    const opts = { ...silent, home };
    const path = join(home, ".gemini", "config", "hooks.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    const before = '{"agent-bridge":{"Stop":[]},"foreign":true}';
    writeFileSync(path, before);
    expect(retireLegacyIntegrations(opts)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
