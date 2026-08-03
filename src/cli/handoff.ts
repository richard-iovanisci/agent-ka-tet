import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  bridgeSessionMarker,
  configFingerprint,
  type AgentConfig,
  type BridgeConfig,
} from "../config.ts";
import { parseManagedProcessMarker } from "../attribution.ts";
import {
  buildCompletionContext,
  collectGitContext,
  HandoffValidationError,
} from "../handoffs/context.ts";
import {
  createHandoffArtifact,
  updateHandoffReceipt,
} from "../handoffs/packet.ts";
import type {
  HandoffArtifact,
  HandoffReceiptUpdate,
} from "../handoffs/types.ts";
import {
  releaseDeliveryReservation,
  tryAcquireDeliveryReservation,
  type DeliveryReservation,
} from "../handoffs/reservation.ts";
import type { MuxAdapter, PaneInfo } from "../mux/adapter.ts";
import type { AgentStatus, StatusResponse } from "../types.ts";
import {
  daemonMatchesConfig,
  fetchDaemonStatus,
  fetchRecentEvents,
} from "./daemonClient.ts";

export interface HandoffArgs {
  from: string;
  to: string;
  task: string;
}

export interface HandoffOptions {
  mux: MuxAdapter;
  print?: (line: string) => void;
  /** Interactive approval seam. Tests provide this while retaining real tmux. */
  approve?: (expected: string) => Promise<string>;
  /** How long to retain the target lock while awaiting its turn.start hook. */
  reservationObservationMs?: number;
}

interface LiveEndpoints {
  status: StatusResponse;
  source: AgentStatus;
  target: AgentStatus;
}

interface OwnedPanes {
  source: PaneInfo;
  target: PaneInfo;
}

class HandoffPreconditionError extends Error {
  override name = "HandoffPreconditionError";
}

function enabledAgent(cfg: BridgeConfig, id: string): AgentConfig {
  const agent = cfg.agents.find((candidate) => candidate.id === id);
  if (agent === undefined) {
    throw new HandoffPreconditionError(`agent ${JSON.stringify(id)} is not configured`);
  }
  if (!agent.enabled) {
    throw new HandoffPreconditionError(`agent ${JSON.stringify(id)} is disabled`);
  }
  return agent;
}

function exactAgentStatus(status: StatusResponse, agent: AgentConfig): AgentStatus {
  const matches = status.agents.filter((candidate) => candidate.agent === agent.id);
  if (matches.length !== 1 || matches[0]?.kind !== agent.kind || !matches[0].enabled) {
    throw new HandoffPreconditionError(
      `daemon status does not contain the enabled ${agent.id} (${agent.kind}) instance exactly once`,
    );
  }
  return matches[0];
}

async function runtimeEndpoints(
  cfg: BridgeConfig,
  source: AgentConfig,
  target: AgentConfig,
): Promise<LiveEndpoints> {
  const status = await fetchDaemonStatus(cfg.daemonPort);
  if (status === null) {
    throw new HandoffPreconditionError(
      `daemon is unreachable at 127.0.0.1:${cfg.daemonPort} — no handoff was delivered`,
    );
  }
  if (!daemonMatchesConfig(status, cfg)) {
    throw new HandoffPreconditionError(
      "daemon belongs to another or stale bridge configuration",
    );
  }
  const sourceStatus = exactAgentStatus(status, source);
  const targetStatus = exactAgentStatus(status, target);
  return { status, source: sourceStatus, target: targetStatus };
}

function requireSourceSnapshotReady(source: AgentStatus): asserts source is AgentStatus & {
  sessionId: string;
} {
  if (source.state !== "idle") {
    throw new HandoffPreconditionError(
      `source agent ${source.agent} is ${source.state}, not idle`,
    );
  }
  if (source.sessionId === null) {
    throw new HandoffPreconditionError(
      `source agent ${source.agent} has no observed native session`,
    );
  }
}

function requireTargetBound(target: AgentStatus): asserts target is AgentStatus & {
  sessionId: string;
} {
  if (target.sessionId === null) {
    throw new HandoffPreconditionError(
      `target agent ${target.agent} has no observed native session`,
    );
  }
}

function requireTargetDeliveryReady(target: AgentStatus, expectedSession: string): void {
  if (target.sessionId !== expectedSession) {
    throw new HandoffPreconditionError(
      `target agent ${target.agent} changed native session while the handoff awaited approval`,
    );
  }
  if (target.state !== "idle") {
    throw new HandoffPreconditionError(
      `target agent ${target.agent} is ${target.state}, not idle`,
    );
  }
}

function requireSeparateApprovalTerminal(): void {
  if (
    (typeof process.env.TMUX === "string" && process.env.TMUX.length > 0) ||
    (typeof process.env.TMUX_PANE === "string" && process.env.TMUX_PANE.length > 0)
  ) {
    throw new HandoffPreconditionError(
      "approve-mode handoff must run from a separate terminal outside tmux; " +
        "refusing before focusing a managed agent pane",
    );
  }
}

function processParentPid(pid: number): number | null {
  const result = Bun.spawnSync({
    cmd: ["ps", "-o", "ppid=", "-p", String(pid)],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const parent = Number.parseInt(new TextDecoder().decode(result.stdout).trim(), 10);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
}

function targetProcessIsLive(
  pane: PaneInfo,
  target: AgentConfig,
  cfg: BridgeConfig,
): boolean {
  const marker = parseManagedProcessMarker(pane.managedProcess);
  if (
    marker === null || marker.agentId !== target.id ||
    marker.configFingerprint !== configFingerprint(cfg)
  ) return false;
  try {
    process.kill(marker.pid, 0);
  } catch {
    return false;
  }
  // The marker-owning foreground wrapper is a direct child of the pane's
  // long-lived login shell. This closes stale-marker/PID-reuse false positives.
  return processParentPid(marker.pid) === pane.pid;
}

async function ownedPanes(
  cfg: BridgeConfig,
  source: AgentConfig,
  target: AgentConfig,
  mux: MuxAdapter,
): Promise<OwnedPanes> {
  if (!(await mux.hasSession(cfg.session))) {
    throw new HandoffPreconditionError(
      `tmux session ${JSON.stringify(cfg.session)} is not running`,
    );
  }
  if ((await mux.getSessionMarker(cfg.session)) !== bridgeSessionMarker(cfg)) {
    throw new HandoffPreconditionError(
      `tmux session ${JSON.stringify(cfg.session)} belongs to another or stale bridge configuration`,
    );
  }
  const panes = await mux.listPanes(cfg.session);
  const enabledIds = cfg.agents.filter((agent) => agent.enabled).map((agent) => agent.id);
  const markerCounts = new Map<string, number>();
  for (const pane of panes) {
    if (pane.agentId !== null) {
      markerCounts.set(pane.agentId, (markerCounts.get(pane.agentId) ?? 0) + 1);
    }
  }
  const topologyExact = panes.length === enabledIds.length &&
    enabledIds.every((id) => markerCounts.get(id) === 1) &&
    panes.every((pane) => pane.agentId !== null && enabledIds.includes(pane.agentId));
  if (!topologyExact) {
    throw new HandoffPreconditionError(
      "tmux pane identity markers do not exactly match the enabled agent roster",
    );
  }
  const sourcePane = panes.find((pane) => pane.agentId === source.id);
  const targetPane = panes.find((pane) => pane.agentId === target.id);
  if (sourcePane === undefined || targetPane === undefined) {
    throw new HandoffPreconditionError("source or target pane is missing");
  }
  if (!targetProcessIsLive(targetPane, target, cfg)) {
    throw new HandoffPreconditionError(
      `target agent ${target.id} is not running in its managed pane; refusing to inject into a fallback shell`,
    );
  }
  return { source: sourcePane, target: targetPane };
}

async function terminalApproval(expected: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new HandoffPreconditionError(
      `approval requires an interactive terminal; re-run and type ${JSON.stringify(expected)}`,
    );
  }
  const prompt = createInterface({ input, output });
  try {
    return await prompt.question("> ");
  } finally {
    prompt.close();
  }
}

function cancellationDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateArtifactReceipt(
  artifact: HandoffArtifact,
  update: HandoffReceiptUpdate,
): void {
  updateHandoffReceipt(artifact.receiptPath, update, artifact.receipt);
}

function storedEventBody(payload: string): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(payload) as unknown;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null;
    const body = (envelope as { body?: unknown }).body;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function reservationPacketFooter(reservation: DeliveryReservation): string {
  return `Agent Bridge packet ${reservation.packetId}`;
}

function promptContainsExactFooter(prompt: string, footer: string): boolean {
  return prompt.split(/\r?\n/u).some((line) => line === footer);
}

interface ReservedPacketTurnStart {
  eventId: number;
  promptId: string | null;
  turnId: string | null;
  observedAt: string;
}

function eventToken(body: Record<string, unknown>, key: "prompt_id" | "turn_id"): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function observedReservedPacketTurnStart(
  cfg: BridgeConfig,
  target: AgentConfig,
  reservation: DeliveryReservation,
): Promise<ReservedPacketTurnStart | null> {
  const events = await fetchRecentEvents(cfg.daemonPort, target.id);
  if (events === null) return null;
  const footer = reservationPacketFooter(reservation);
  for (const row of events) {
    if (
      row.id <= reservation.baselineEventId || row.agent !== target.id ||
      row.kind !== target.kind || row.session_id !== reservation.targetSession ||
      row.type !== "turn.start" || row.native_type !== "UserPromptSubmit"
    ) continue;
    const body = storedEventBody(row.payload);
    if (body === null) continue;
    const prompt = body.prompt;
    const promptId = eventToken(body, "prompt_id");
    const turnId = eventToken(body, "turn_id");
    const providerToken = target.kind === "claude" ? promptId : turnId;
    if (
      providerToken === null || typeof prompt !== "string" ||
      !promptContainsExactFooter(prompt, footer)
    ) continue;
    const observedAt = new Date(row.ts);
    if (!Number.isFinite(observedAt.valueOf())) continue;
    return {
      eventId: row.id,
      promptId,
      turnId,
      observedAt: observedAt.toISOString(),
    };
  }
  return null;
}

function unresolvedReservationDetail(
  target: AgentConfig,
  result: Extract<ReturnType<typeof tryAcquireDeliveryReservation>, { acquired: false }>,
): string {
  if (result.existing === null) {
    return `target agent ${target.id} has a malformed or unreadable unresolved delivery ` +
      `reservation at ${result.path}; automatic cleanup is disabled, so inspect and ` +
      "reconcile that lock explicitly";
  }
  return `target agent ${target.id} already has an unresolved delivery reservation at ` +
    `${result.path} owned by packet ${result.existing.packetId} ` +
    `(receipt ${result.existing.receiptPath}, owner PID ${result.existing.ownerPid}); ` +
    "automatic takeover is disabled; no background cleanup will occur, so the lock " +
    "remains until it is explicitly reconciled";
}

function printRetainedReservation(
  print: (line: string) => void,
  reservation: DeliveryReservation,
  reason: string,
): void {
  print(
    `delivery reservation retained for packet ${reservation.packetId} at ` +
      `${reservation.path}: ${reason}`,
  );
  print(`reservation receipt: ${reservation.receiptPath}`);
  print(
    "reruns to this target are refused; no later background cleanup occurs, and the lock " +
      "remains until it is explicitly reconciled",
  );
  print(
    "a managed same-session UserPromptSubmit containing the exact footer " +
      `${JSON.stringify(reservationPacketFooter(reservation))} is evidence to inspect ` +
      "during that reconciliation",
  );
}

async function acquireTargetReservation(
  cfg: BridgeConfig,
  target: AgentConfig,
  targetSession: string,
  packetId: string,
  receiptPath: string,
): Promise<DeliveryReservation> {
  const events = await fetchRecentEvents(cfg.daemonPort, target.id);
  if (events === null) {
    throw new HandoffPreconditionError(
      `could not read target history before reserving ${target.id}`,
    );
  }
  const baselineEventId = events.reduce((max, row) => Math.max(max, row.id), 0);
  const result = tryAcquireDeliveryReservation({
    repo: cfg.repo,
    target: target.id,
    targetSession,
    configFingerprint: configFingerprint(cfg),
    packetId,
    receiptPath,
    baselineEventId,
  });
  if (!result.acquired) {
    throw new HandoffPreconditionError(unresolvedReservationDetail(target, result));
  }
  return result.reservation;
}

async function waitForReservedPacketTurnStart(
  cfg: BridgeConfig,
  target: AgentConfig,
  reservation: DeliveryReservation,
  timeoutMs: number,
): Promise<ReservedPacketTurnStart | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const observed = await observedReservedPacketTurnStart(cfg, target, reservation);
    if (observed !== null) return observed;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(50);
  }
}

/**
 * Prepare, preview, explicitly approve, and finally idle-gate one native-TUI
 * handoff. The immutable packet shown here is the exact text sent to tmux.
 */
export async function handoff(
  cfg: BridgeConfig,
  args: HandoffArgs,
  opts: HandoffOptions,
): Promise<number> {
  const print = opts.print ?? console.log;
  let artifact: ReturnType<typeof createHandoffArtifact> | null = null;
  let reservation: DeliveryReservation | null = null;
  let terminalBoundaryTouched = false;

  try {
    if (args.from === args.to) {
      throw new HandoffPreconditionError("source and target agents must be different");
    }
    // `approve` is an in-process test seam and never reads the invoking tty.
    if (opts.approve === undefined) requireSeparateApprovalTerminal();
    const source = enabledAgent(cfg, args.from);
    const target = enabledAgent(cfg, args.to);
    const initial = await runtimeEndpoints(cfg, source, target);
    requireSourceSnapshotReady(initial.source);
    requireTargetBound(initial.target);
    const initialTargetSession = initial.target.sessionId;
    const initialPanes = await ownedPanes(cfg, source, target, opts.mux);

    const events = await fetchRecentEvents(cfg.daemonPort, source.id);
    if (events === null) {
      throw new HandoffPreconditionError(
        `could not read retained events for source agent ${source.id}`,
      );
    }
    const completion = buildCompletionContext(events, {
      agentId: source.id,
      kind: source.kind,
      sessionId: initial.source.sessionId,
    });
    if (completion === null) {
      throw new HandoffPreconditionError(
        `source agent ${source.id} has no completed turn in its current session`,
      );
    }

    artifact = createHandoffArtifact({
      repo: cfg.repo,
      from: source.id,
      to: target.id,
      targetKind: target.kind,
      sourceSession: initial.source.sessionId,
      targetSession: initialTargetSession,
      completion,
      requestedAction: args.task,
      git: collectGitContext(source.cwd ?? cfg.repo),
    });

    print(`prepared handoff ${artifact.id}: ${source.id} -> ${target.id}`);
    print(`packet:  ${artifact.packetPath}`);
    print(`receipt: ${artifact.receiptPath}`);
    print("");
    print("----- exact packet to be delivered -----");
    print(artifact.packet);
    print("----- end packet -----");
    print("");
    await opts.mux.focusPane(cfg.session, initialPanes.target.id);
    const expected = `DELIVER ${artifact.id}`;
    print(
      `Inspect ${target.id} pane ${initialPanes.target.id}; confirm its composer is empty.`,
    );
    print(`Type ${expected} here to paste and submit this packet; anything else cancels.`);

    let answer: string;
    try {
      answer = await (opts.approve ?? terminalApproval)(expected);
    } catch (error) {
      updateArtifactReceipt(artifact, {
        status: "cancelled",
        detail: cancellationDetail(error),
      });
      throw error;
    }
    if (answer.trim() !== expected) {
      updateArtifactReceipt(artifact, {
        status: "cancelled",
        detail: "operator did not enter the exact delivery approval",
      });
      print(`cancelled handoff ${artifact.id}; packet retained, nothing was delivered`);
      return 1;
    }
    updateArtifactReceipt(artifact, { status: "approved", detail: null });

    try {
      reservation = await acquireTargetReservation(
        cfg,
        target,
        initialTargetSession,
        artifact.id,
        artifact.receiptPath,
      );
    } catch (error) {
      updateArtifactReceipt(artifact, {
        status: "cancelled",
        detail: cancellationDetail(error),
      });
      throw error;
    }

    // Approval can take arbitrarily long. Re-establish every semantic and tmux
    // invariant immediately before the terminal-boundary paste.
    let finalState: LiveEndpoints;
    let finalPanes: OwnedPanes;
    try {
      finalState = await runtimeEndpoints(cfg, source, target);
      requireTargetDeliveryReady(finalState.target, initialTargetSession);
      finalPanes = await ownedPanes(cfg, source, target, opts.mux);
      if (finalPanes.target.id !== initialPanes.target.id) {
        throw new HandoffPreconditionError(
          "target tmux pane changed while the handoff awaited approval",
        );
      }
    } catch (error) {
      if (reservation !== null) {
        releaseDeliveryReservation(reservation);
        reservation = null;
      }
      updateArtifactReceipt(artifact, {
        status: "cancelled",
        detail: cancellationDetail(error),
      });
      throw error;
    }

    // Persist the ambiguous-in-flight state before touching the pane. A crash
    // from this point never silently replays the handoff.
    try {
      updateArtifactReceipt(artifact, { status: "delivering", detail: null });
    } catch (error) {
      if (reservation !== null) {
        releaseDeliveryReservation(reservation);
        reservation = null;
      }
      updateArtifactReceipt(artifact, {
        status: "cancelled",
        detail: `approved packet failed persisted content verification: ${cancellationDetail(error)}`,
      });
      throw error;
    }
    let sent;
    try {
      terminalBoundaryTouched = true;
      sent = await opts.mux.sendText(finalPanes.target.id, artifact.packet, {
        submit: true,
        verification: { mode: "native-tui", agentKind: target.kind },
        beforeSubmit: async () => {
          const submitState = await runtimeEndpoints(cfg, source, target);
          requireTargetDeliveryReady(
            submitState.target,
            initialTargetSession,
          );
          const submitPanes = await ownedPanes(cfg, source, target, opts.mux);
          if (submitPanes.target.id !== finalPanes.target.id) {
            throw new HandoffPreconditionError(
              "target tmux pane changed after paste verification and before Enter",
            );
          }
        },
      });
    } catch (error) {
      updateArtifactReceipt(artifact, {
        status: "failed",
        detail: `tmux delivery raised an error; outcome may be ambiguous: ${cancellationDetail(error)}`,
      });
      if (reservation !== null) {
        printRetainedReservation(
          print,
          reservation,
          "the terminal delivery raised an error and its outcome is ambiguous",
        );
      }
      throw error;
    }
    if (!sent.ok) {
      const ambiguous = sent.failure === "ambiguous-observable";
      const failureDetail = ambiguous
        ? "terminal paste verification found an ambiguous observable; Enter was not sent"
        : "terminal paste verification timed out without one exact observable; Enter was not sent";
      updateArtifactReceipt(artifact, {
        status: "failed",
        detail: sent.retried
          ? `${failureDetail} after the second observation window`
          : failureDetail,
      });
      print(
        `FAILED handoff ${artifact.id}: ${ambiguous ? "ambiguous terminal paste observable" : "terminal paste verification timeout"}; Enter was not sent`,
      );
      print(`receipt: ${artifact.receiptPath}`);
      if (reservation !== null) {
        printRetainedReservation(
          print,
          reservation,
          ambiguous
            ? "terminal paste verification was ambiguous, so delivery cannot be safely replayed"
            : "terminal paste verification timed out, so delivery cannot be safely replayed",
        );
      }
      return 1;
    }
    updateArtifactReceipt(artifact, {
      status: "delivered",
      targetSession: finalState.target.sessionId,
      detail: sent.retried
        ? `packet ${sent.observable ?? "terminal"} observable verified after a second observation window and submitted with one Enter`
        : `packet ${sent.observable ?? "terminal"} observable verified and submitted with one Enter`,
    });
    try {
      await opts.mux.focusPane(cfg.session, finalPanes.target.id);
    } catch (error) {
      print(
        `warning: handoff ${artifact.id} was delivered, but focusing pane ` +
          `${finalPanes.target.id} failed: ${cancellationDetail(error)}`,
      );
    }
    print(
      `delivered handoff ${artifact.id} to ${target.id} (${finalState.target.sessionId}) in pane ${finalPanes.target.id}`,
    );
    print(`receipt: ${artifact.receiptPath}`);
    const observedTurn = reservation === null
      ? null
      : await waitForReservedPacketTurnStart(
        cfg,
        target,
        reservation,
        opts.reservationObservationMs ?? 2_000,
      );
    if (reservation !== null && observedTurn !== null) {
      try {
        updateArtifactReceipt(artifact, {
          status: "delivered",
          targetTurnEventId: observedTurn.eventId,
          targetPromptId: observedTurn.promptId,
          targetTurnId: observedTurn.turnId,
          targetTurnObservedAt: observedTurn.observedAt,
        });
      } catch (error) {
        printRetainedReservation(
          print,
          reservation,
          `the exact packet turn was observed, but its durable receipt update failed: ${cancellationDetail(error)}`,
        );
        return 0;
      }
      if (releaseDeliveryReservation(reservation)) {
        reservation = null;
      } else {
        printRetainedReservation(
          print,
          reservation,
          "the exact packet turn was observed, but the reservation token no longer matched",
        );
      }
    } else if (reservation !== null) {
      printRetainedReservation(
        print,
        reservation,
        "no matching packet-bearing target turn.start was observed before the timeout",
      );
    }
    return 0;
  } catch (error) {
    if (reservation !== null && !terminalBoundaryTouched) {
      releaseDeliveryReservation(reservation);
      reservation = null;
    }
    if (error instanceof HandoffValidationError || error instanceof HandoffPreconditionError) {
      print(`handoff refused: ${error.message}`);
      if (artifact !== null) print(`packet retained: ${artifact.packetPath}`);
      return 1;
    }
    print(`handoff failed: ${cancellationDetail(error)}`);
    if (artifact !== null) print(`packet retained: ${artifact.packetPath}`);
    return 1;
  }
}
