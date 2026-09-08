import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parsePrepare } from "./cli.ts";

describe("native run arguments", () => {
  test("preserves a literal task brief and rejects ambiguous repeated or missing options", () => {
    const brief = "Keep $(echo literal) and `code` unchanged.\nUse two lines.";
    expect(parsePrepare([".", "--task", brief]).brief).toBe(brief);
    expect(parsePrepare([".", "--task", brief, "--config", "run-settings.json"]).config).toBe(
      resolve("run-settings.json"),
    );
    for (const args of [
      [],
      ["."],
      [".", "--task"],
      [".", "--task", "x", "--task", "y"],
      [".", "--task", "x", "--unknown", "y"],
      [".", "--task", "x", "--config", "a", "--config", "b"],
    ])
      expect(() => parsePrepare(args)).toThrow();
  });
});
