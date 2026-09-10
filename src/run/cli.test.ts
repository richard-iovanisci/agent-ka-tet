import { describe, expect, test } from "bun:test";
import { parsePrepare } from "./cli.ts";

describe("native run arguments", () => {
  test("preserves a literal task brief and rejects ambiguous repeated or missing options", () => {
    const brief = "Keep $(echo literal) and `code` unchanged.\nUse two lines.";
    expect(parsePrepare([".", "--task", brief]).brief).toBe(brief);
    for (const args of [
      [],
      ["."],
      [".", "--task"],
      [".", "--task", "x", "--task", "y"],
      [".", "--task", "x", "--unknown", "y"],
    ])
      expect(() => parsePrepare(args)).toThrow();
  });
});
