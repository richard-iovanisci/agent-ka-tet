import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFile } from "./configFile.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bridge-configfile-"));
}

describe("writeConfigFile", () => {
  test("creates a new file and prints a diff", () => {
    const dir = tempDir();
    const path = join(dir, "sub", "settings.json");
    const printed: string[] = [];
    const res = writeConfigFile(path, '{"a":1}\n', { print: (l) => printed.push(l) });
    expect(res.changed).toBe(true);
    expect(res.backupPath).toBeNull();
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
    expect(printed.join("\n")).toContain('+ {"a":1}');
  });

  test("is idempotent: identical content writes nothing, no backup", () => {
    const dir = tempDir();
    const path = join(dir, "f.json");
    writeConfigFile(path, "same\n", { print: () => {} });
    const res = writeConfigFile(path, "same\n", { print: () => {} });
    expect(res.changed).toBe(false);
    expect(res.backupPath).toBeNull();
    expect(readdirSync(dir)).toEqual(["f.json"]); // no .bak files
  });

  test("backs up the original before overwriting", () => {
    const dir = tempDir();
    const path = join(dir, "f.json");
    writeFileSync(path, "old\n");
    const res = writeConfigFile(path, "new\n", { print: () => {} });
    expect(res.changed).toBe(true);
    expect(res.backupPath).not.toBeNull();
    expect(existsSync(res.backupPath!)).toBe(true);
    expect(readFileSync(res.backupPath!, "utf8")).toBe("old\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  test("dry run prints the diff but writes nothing", () => {
    const dir = tempDir();
    const path = join(dir, "f.json");
    writeFileSync(path, "old\n");
    const res = writeConfigFile(path, "new\n", { print: () => {}, dryRun: true });
    expect(res.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("old\n");
  });
});
