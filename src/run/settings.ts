export interface ClaudeLaunchSettings {
  model: string;
  effort: "inherit" | "low" | "medium" | "high" | "xhigh" | "max";
  thinking: "inherit" | "on" | "off";
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan";
  accountRef?: string;
}

export interface CodexLaunchSettings {
  model: string;
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  approvalPolicy: "never" | "on-request" | "untrusted";
  sandbox: "danger-full-access" | "read-only" | "workspace-write";
  accountRef?: string;
}

export interface RunLaunchSettings {
  version: 1;
  claude: ClaudeLaunchSettings;
  codex: CodexLaunchSettings;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`unsupported ${name} setting`);
}

function selection<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`unsupported ${name}`);
  return value as T;
}

function model(value: unknown, inherit: boolean): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    /[\s\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("-") ||
    (!inherit && value === "inherit")
  )
    throw new Error("model must be a native alias or explicit model ID");
  return value;
}

function account(value: unknown): { accountRef?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    throw new Error("accountRef must be a non-secret label of 1–64 characters");
  return { accountRef: value };
}

export function resolveLaunchSettings(value: unknown = { version: 1 }): RunLaunchSettings {
  const input = object(value, "run settings");
  keys(input, ["version", "claude", "codex"], "run");
  if (input.version !== 1) throw new Error("unsupported run settings version");
  const claude = object(input.claude === undefined ? {} : input.claude, "Claude settings");
  const codex = object(input.codex === undefined ? {} : input.codex, "Codex settings");
  keys(claude, ["model", "effort", "thinking", "permissionMode", "accountRef"], "Claude");
  keys(codex, ["model", "effort", "approvalPolicy", "sandbox", "accountRef"], "Codex");
  if ([...Object.values(claude), ...Object.values(codex)].some((item) => item === null))
    throw new Error("launch settings cannot be null");
  const result: RunLaunchSettings = {
    version: 1,
    claude: {
      model: model(claude.model ?? "inherit", true),
      effort: selection(
        claude.effort ?? "high",
        ["inherit", "low", "medium", "high", "xhigh", "max"],
        "Claude effort",
      ),
      thinking: selection(claude.thinking ?? "inherit", ["inherit", "on", "off"], "Claude thinking"),
      permissionMode: selection(
        claude.permissionMode ?? "bypassPermissions",
        ["bypassPermissions", "default", "acceptEdits", "plan"],
        "Claude permission mode",
      ),
      ...account(claude.accountRef),
    },
    codex: {
      model: model(codex.model ?? "gpt-6-astra", false),
      effort: selection(
        codex.effort ?? "ultra",
        ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        "Codex effort",
      ),
      approvalPolicy: selection(
        codex.approvalPolicy ?? "never",
        ["never", "on-request", "untrusted"],
        "Codex approval policy",
      ),
      sandbox: selection(
        codex.sandbox ?? "danger-full-access",
        ["danger-full-access", "read-only", "workspace-write"],
        "Codex sandbox",
      ),
      ...account(codex.accountRef),
    },
  };
  if (
    result.claude.thinking === "off" &&
    (result.claude.model === "inherit" ||
      /^fable(?:\[1m\])?$/i.test(result.claude.model) ||
      /(?:^|[-_/])fable[-_.]?5(?:[-_.]1)?(?=$|@|[-_](?:20\d{6}|latest)(?:$|[-_:])|\[)/i.test(
        result.claude.model,
      ))
  )
    throw new Error(
      "thinking off requires an explicit compatible model; Fable 5 and 5.1 cannot disable thinking",
    );
  return result;
}

export function validateLaunchSettings(value: unknown): asserts value is RunLaunchSettings {
  object(value, "persisted launch settings");
  const resolved = resolveLaunchSettings(value);
  const input = value as RunLaunchSettings;
  for (const kind of ["claude", "codex"] as const) {
    if (!input[kind] || Object.keys(resolved[kind]).some((key) => !(key in input[kind])))
      throw new Error("persisted launch settings must be complete");
  }
}
