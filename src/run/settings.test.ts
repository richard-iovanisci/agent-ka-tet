import { describe, expect, test } from "bun:test";
import { resolveLaunchSettings, validateLaunchSettings } from "./settings.ts";

describe("run launch settings", () => {
  test("defaults to bypass while preserving the operator's Claude model selection", () => {
    expect(resolveLaunchSettings()).toEqual({
      version: 1,
      claude: {
        model: "inherit",
        effort: "high",
        thinking: "inherit",
        permissionMode: "bypassPermissions",
      },
      codex: {
        model: "gpt-6-astra",
        effort: "ultra",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
  });

  test("accepts explicit provider models and per-agent policy overrides", () => {
    const settings = resolveLaunchSettings({
      version: 1,
      claude: {
        model: "provider/custom-deployment",
        effort: "inherit",
        permissionMode: "plan",
        thinking: "on",
        accountRef: "primary",
      },
      codex: {
        model: "custom-model",
        effort: "medium",
        approvalPolicy: "on-request",
        sandbox: "read-only",
      },
    });
    expect(settings.claude.model).toBe("provider/custom-deployment");
    expect(settings.codex.sandbox).toBe("read-only");
    expect(() => validateLaunchSettings(settings)).not.toThrow();
    expect(() => validateLaunchSettings({ version: 1, claude: {}, codex: {} })).toThrow(/complete/);
  });

  test("preserves Claude xhigh and Codex max through persisted settings validation", () => {
    for (const model of ["claude-fable-5", "claude-fable-5-1"]) {
      const settings = resolveLaunchSettings({
        version: 1,
        claude: { model, effort: "xhigh" },
        codex: { model: "gpt-6-astra", effort: "max" },
      });
      expect(settings.claude.effort).toBe("xhigh");
      expect(settings.codex.effort).toBe("max");
      expect(() => validateLaunchSettings(JSON.parse(JSON.stringify(settings)))).not.toThrow();
    }
  });

  test("keeps Codex persistent mode outside the supported launch controls", () => {
    expect(() => resolveLaunchSettings({ version: 1, codex: { effort: "persistent" } })).toThrow(
      /unsupported Codex effort/,
    );
  });

  test("rejects unsupported controls before preparing native state", () => {
    for (const input of [
      { version: 2 },
      { version: 1, claude: null },
      { version: 1, claude: { effort: null } },
      { version: 1, typo: true },
      { version: 1, claude: { effort: "ultra" } },
      { version: 1, claude: { model: "--resume" } },
      { version: 1, codex: { model: "bad\nmodel" } },
      { version: 1, codex: { model: "inherit" } },
      { version: 1, codex: { thinking: "off" } },
      { version: 1, codex: { sandbox: "yolo" } },
      { version: 1, claude: { accountRef: "token: secret" } },
    ])
      expect(() => resolveLaunchSettings(input)).toThrow();
  });

  test("refuses thinking off for known always-thinking models without inventing future capabilities", () => {
    for (const model of [
      "inherit",
      "fable",
      "fable[1m]",
      "claude-fable-5",
      "claude-fable-5-20260901",
      "claude-fable-5-1",
      "claude-fable-5.1",
      "claude-fable-5@20260901",
      "claude-fable-5-1@20260901",
      "claude-fable-5.1@20260901",
      "publishers/anthropic/models/claude-fable-5-1@20260901",
      "us.anthropic.claude-fable-5-1-20260901-v1:0",
    ])
      expect(() =>
        resolveLaunchSettings({
          version: 1,
          claude: { model, thinking: "off" },
        }),
      ).toThrow(/cannot disable thinking/);
    for (const model of [
      "claude-fable-4",
      "claude-fable-5-2",
      "claude-fable-5.2",
      "claude-fable-5-2@20260901",
      "claude-fable-5.2@20260901",
      "publishers/anthropic/models/claude-fable-5-2@20260901",
      "claude-fable-5-10",
    ])
      expect(resolveLaunchSettings({ version: 1, claude: { model, thinking: "off" } }).claude.thinking).toBe(
        "off",
      );
  });
});
