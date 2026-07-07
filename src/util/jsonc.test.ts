import { describe, expect, test } from "bun:test";
import { parseJsonc } from "./jsonc.ts";

describe("parseJsonc", () => {
  test("plain JSON passes through", () => {
    expect(parseJsonc('{"a": 1, "b": [true, null]}')).toEqual({ a: 1, b: [true, null] });
  });

  test("line comments", () => {
    expect(parseJsonc('{\n// comment\n"a": 1 // trailing\n}')).toEqual({ a: 1 });
  });

  test("block comments", () => {
    expect(parseJsonc('{/* x */ "a": /* y */ 1}')).toEqual({ a: 1 });
  });

  test("trailing commas in objects and arrays", () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  test("trailing comma followed by comment", () => {
    expect(parseJsonc('{"a": 1, // note\n}')).toEqual({ a: 1 });
  });

  test("comment markers inside strings are preserved", () => {
    expect(parseJsonc('{"url": "http://x/y", "s": "a // b /* c */"}')).toEqual({
      url: "http://x/y",
      s: "a // b /* c */",
    });
  });

  test("escaped quotes inside strings", () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // ok"}')).toEqual({ a: 'say "hi" // ok' });
  });

  test("non-trailing commas survive", () => {
    expect(parseJsonc('{"a": 1, "b": 2}')).toEqual({ a: 1, b: 2 });
  });
});
