import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_BIN = fileURLToPath(new URL("../../bin/bridge", import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "bridge-main-"));
  fixtures.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(
    join(repo, "bridge.config.jsonc"),
    JSON.stringify({
      session: `bridge-help-${process.pid}`,
      daemonPort: 55_000 + (process.pid % 1_000),
      agents: [
        { id: "claude", kind: "claude", command: "claude" },
        { id: "codex", kind: "codex", command: "codex" },
      ],
    }),
  );
  return { repo, home };
}

function runBridge(
  repo: string,
  home: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["bun", BRIDGE_BIN, ...args],
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

describe("bridge argument validation", () => {
  test("down --help prints help without dispatching teardown", () => {
    const { repo, home } = fixture();
    const result = runBridge(repo, home, ["down", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: bridge <command>");
    expect(result.stdout).not.toContain("not running");
    expect(result.stdout).not.toContain("nothing to stop");
    expect(result.stderr).toBe("");
  });

  test("a typoed init flag fails before writing any hook config", () => {
    const { repo, home } = fixture();
    const result = runBridge(repo, home, ["init", "--dryrun"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown option or argument "--dryrun"');
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(repo, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".local", "state", "agent-bridge"))).toBe(false);
  });
});
