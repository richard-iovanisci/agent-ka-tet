/**
 * Process-scoped attribution carried from a managed tmux pane into native
 * lifecycle hooks. Project-local hook files are shared by every agent session
 * in that cwd, so cwd alone cannot prove that an event came from the pane that
 * Agent Bridge launched.
 */

export const BRIDGE_AGENT_ID_ENV = "AGENT_BRIDGE_AGENT_ID";
export const BRIDGE_CONFIG_FINGERPRINT_ENV =
  "AGENT_BRIDGE_CONFIG_FINGERPRINT";

export const BRIDGE_AGENT_ID_HEADER = "X-Agent-Bridge-Agent-Id";
export const BRIDGE_CONFIG_FINGERPRINT_HEADER =
  "X-Agent-Bridge-Config-Fingerprint";

/** tmux pane option present only while bridge's native launch is still live. */
export const BRIDGE_MANAGED_PROCESS_OPTION = "@agent-bridge-managed-process";

export interface ManagedProcessMarker {
  agentId: string;
  configFingerprint: string;
  runToken: string;
  pid: number;
}

/** Prefix completed with the marker-owning foreground wrapper PID in-pane. */
export function managedProcessMarkerPrefix(
  agentId: string,
  configFingerprint: string,
  runToken: string,
): string {
  if ([agentId, configFingerprint, runToken].some((part) => part.includes(":"))) {
    throw new Error("managed-process marker fields must not contain ':'");
  }
  return `v1:${agentId}:${configFingerprint}:${runToken}:`;
}

export function parseManagedProcessMarker(value: string | null): ManagedProcessMarker | null {
  if (value === null) return null;
  const [version, agentId, configFingerprint, runToken, pidText, ...extra] =
    value.split(":");
  if (
    version !== "v1" || agentId === undefined || agentId.length === 0 ||
    configFingerprint === undefined || configFingerprint.length === 0 ||
    runToken === undefined || runToken.length === 0 || pidText === undefined ||
    !/^[1-9][0-9]*$/u.test(pidText) || extra.length > 0
  ) return null;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { agentId, configFingerprint, runToken, pid };
}

/** Literal environment reference for hook configuration and shell shims. */
export function envReference(name: string): string {
  return `$${name}`;
}
