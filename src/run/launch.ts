import type { ClaudeLaunchSettings, CodexLaunchSettings } from "./settings.ts";

export const THINKING_ON_BUDGET = 31_999;

export interface EnvironmentDisposition {
  name: string;
  disposition: "replaced" | "inherited";
}

export type ConfiguredClaudeLaunch = ClaudeLaunchSettings & {
  thinkingBudgetTokens?: number;
};

export interface NativeLaunchRecord {
  version: 1;
  runtimeId: string;
  role: "claude" | "codex-host";
  recordedAt: number;
  configured: ConfiguredClaudeLaunch | CodexLaunchSettings;
  environment: EnvironmentDisposition[];
}

const CLAUDE_ENVIRONMENT = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
] as const;

export function claudeNativeSettings(settings: ClaudeLaunchSettings): {
  env: Record<string, string>;
  alwaysThinkingEnabled?: boolean;
} {
  const env: Record<string, string> = {};
  if (settings.model !== "inherit") env.ANTHROPIC_MODEL = settings.model;
  if (settings.effort !== "inherit") env.CLAUDE_CODE_EFFORT_LEVEL = settings.effort;
  if (settings.thinking === "inherit") return { env };
  env.MAX_THINKING_TOKENS = settings.thinking === "on" ? String(THINKING_ON_BUDGET) : "0";
  env.CLAUDE_CODE_DISABLE_THINKING = "0";
  env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "0";
  return { env, alwaysThinkingEnabled: settings.thinking === "on" };
}

export function claudeLaunchControls(settings: ClaudeLaunchSettings, inherited: NodeJS.ProcessEnv) {
  const native = claudeNativeSettings(settings);
  const environment: EnvironmentDisposition[] = CLAUDE_ENVIRONMENT.filter(
    (name) => inherited[name] !== undefined || native.env[name] !== undefined,
  ).map((name) => ({
    name,
    disposition: native.env[name] === undefined ? "inherited" : "replaced",
  }));
  return {
    args: [
      ...(settings.model === "inherit" ? [] : ["--model", settings.model]),
      ...(settings.effort === "inherit" ? [] : ["--effort", settings.effort]),
      "--permission-mode",
      settings.permissionMode,
    ],
    env: { ...inherited, ...native.env },
    configured: {
      ...settings,
      ...(settings.thinking === "inherit"
        ? {}
        : {
            thinkingBudgetTokens: settings.thinking === "on" ? THINKING_ON_BUDGET : 0,
          }),
    } satisfies ConfiguredClaudeLaunch,
    environment,
  };
}

export function codexHostLaunchControls(settings: CodexLaunchSettings) {
  return {
    args: [
      "-c",
      `model=${JSON.stringify(settings.model)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(settings.effort)}`,
      "-c",
      `approval_policy=${JSON.stringify(settings.approvalPolicy)}`,
      "-c",
      `sandbox_mode=${JSON.stringify(settings.sandbox)}`,
    ],
    configured: { ...settings },
    environment: [] satisfies EnvironmentDisposition[],
  };
}
