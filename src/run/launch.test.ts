import { describe, expect, test } from "bun:test";
import { claudeLaunchControls, claudeNativeSettings, codexHostLaunchControls } from "./launch.ts";
import { resolveLaunchSettings } from "./settings.ts";

describe("native launch controls", () => {
  test("explicit controls beat inherited and lower settings values without changing provider routing", () => {
    const settings = resolveLaunchSettings({
      version: 1,
      claude: {
        model: "sonnet",
        effort: "max",
        thinking: "on",
        permissionMode: "plan",
      },
    }).claude;
    const inherited = Object.freeze({
      ANTHROPIC_MODEL: "private-model-value",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "private-deployment-id",
      CLAUDE_CODE_EFFORT_LEVEL: "private-effort-value",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      ANTHROPIC_AUTH_TOKEN: "private-auth-value",
      ANTHROPIC_BASE_URL: "https://provider.invalid/api",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      PATH: "/fixture/bin:/usr/bin",
    });
    const controls = claudeLaunchControls(settings, inherited);
    expect(controls.args).toEqual(["--model", "sonnet", "--effort", "max", "--permission-mode", "plan"]);
    expect(controls.env).toMatchObject({
      ANTHROPIC_MODEL: "sonnet",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDE_CODE_DISABLE_THINKING: "0",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "0",
      ANTHROPIC_DEFAULT_SONNET_MODEL: inherited.ANTHROPIC_DEFAULT_SONNET_MODEL,
      ANTHROPIC_AUTH_TOKEN: inherited.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: inherited.ANTHROPIC_BASE_URL,
      HTTPS_PROXY: inherited.HTTPS_PROXY,
      PATH: inherited.PATH,
    });
    const nativeSettings = claudeNativeSettings(settings);
    const effective = {
      ...controls.env,
      CLAUDE_CODE_EFFORT_LEVEL: "low",
      MAX_THINKING_TOKENS: "0",
      ...nativeSettings.env,
    };
    expect(effective.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    expect(Number(effective.MAX_THINKING_TOKENS)).toBeGreaterThanOrEqual(1024);
    expect(Number(effective.MAX_THINKING_TOKENS)).toBe(controls.configured.thinkingBudgetTokens!);
    expect(nativeSettings.alwaysThinkingEnabled).toBe(true);
    expect(controls.environment).toContainEqual({
      name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      disposition: "inherited",
    });
    expect(controls.environment).toContainEqual({
      name: "CLAUDE_CODE_EFFORT_LEVEL",
      disposition: "replaced",
    });
    expect(
      JSON.stringify({
        configured: controls.configured,
        environment: controls.environment,
      }),
    ).not.toMatch(/private-|proxy\.invalid|provider\.invalid/);
    expect(inherited.MAX_THINKING_TOKENS).toBe("0");
    expect(inherited.CLAUDE_CODE_EFFORT_LEVEL).toBe("private-effort-value");
  });

  test("inherit preserves native selection and thinking policy without manufacturing configured values", () => {
    const settings = resolveLaunchSettings({
      version: 1,
      claude: {
        model: "inherit",
        effort: "inherit",
        thinking: "inherit",
        permissionMode: "acceptEdits",
      },
    }).claude;
    const inherited = {
      ANTHROPIC_MODEL: "private-model",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      MAX_THINKING_TOKENS: "0",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    };
    const controls = claudeLaunchControls(settings, inherited);
    expect(controls.args).toEqual(["--permission-mode", "acceptEdits"]);
    expect(controls.env).toEqual(inherited);
    expect(claudeNativeSettings(settings)).toEqual({ env: {} });
    expect(controls.configured).not.toHaveProperty("thinkingBudgetTokens");
    expect(controls.environment.every((entry) => entry.disposition === "inherited")).toBe(true);
    expect(JSON.stringify(controls.environment)).not.toContain("private-model");
  });

  test("thinking off overrides inherited positive budgets and reports its exact mapping", () => {
    const settings = resolveLaunchSettings({
      version: 1,
      claude: {
        model: "claude-sonnet-4-6",
        thinking: "off",
      },
    }).claude;
    const controls = claudeLaunchControls(settings, {
      MAX_THINKING_TOKENS: "50000",
    });
    expect(controls.env.MAX_THINKING_TOKENS).toBe("0");
    expect(controls.configured.thinkingBudgetTokens).toBe(0);
    expect(claudeNativeSettings(settings).alwaysThinkingEnabled).toBe(false);
    expect(controls.args.slice(-2)).toEqual(["--permission-mode", "bypassPermissions"]);
  });

  test("Codex config arguments keep model IDs literal and apply matching host policy", () => {
    const settings = resolveLaunchSettings({
      version: 1,
      codex: {
        model: 'custom/model";literal',
        effort: "minimal",
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      },
    }).codex;
    const controls = codexHostLaunchControls(settings);
    const values = Object.fromEntries(
      controls.args
        .filter((_, i) => i % 2 === 1)
        .map((arg) => {
          const equals = arg.indexOf("=");
          return [arg.slice(0, equals), JSON.parse(arg.slice(equals + 1))];
        }),
    );
    expect(values).toEqual({
      model: settings.model,
      model_reasoning_effort: "minimal",
      approval_policy: "untrusted",
      sandbox_mode: "workspace-write",
    });
    expect(controls.configured).toEqual(settings);
    expect(controls.environment).toEqual([]);
    const defaults = codexHostLaunchControls(resolveLaunchSettings().codex);
    expect(defaults.args).toContain('approval_policy="never"');
    expect(defaults.args).toContain('sandbox_mode="danger-full-access"');
  });
});
