/**
 * Mux abstraction (DESIGN.md §4). The multiplexer hosts the agent TUIs; this
 * adapter does only the jobs the daemon needs — spawn panes, capture
 * previews, inject input at the terminal boundary, focus panes — behind an
 * interface so a second backend (Zellij, parked per DESIGN.md §5) can slot in
 * without touching callers.
 */
import type { AgentKind } from "../types.ts";

/** One pane in a mux session, as reported by the backend. */
export interface PaneInfo {
  /** Backend-global pane id (tmux: "%3"). Stable for the pane's lifetime. */
  id: string;
  /** PID of the pane's long-lived login shell. */
  pid: number;
  /** Position within the window. */
  index: number;
  /** Durable bridge identity stored outside TUI-controlled display state. */
  agentId: string | null;
  /** Present only while bridge's managed native launch remains live. */
  managedProcess: string | null;
  /** Best-effort display title; native TUIs may overwrite it. */
  title: string;
  /** Command currently running in the pane (e.g. the user's shell). */
  command: string;
  width: number;
  height: number;
  active: boolean;
}

/** Outcome of an injection attempt (DESIGN.md §4 injection etiquette). */
export type PasteObservable =
  | "literal"
  | "claude-placeholder"
  | "codex-placeholder";

export type SendFailure =
  | "verification-timeout"
  | "ambiguous-observable";

export interface SendResult {
  /** Text was delivered and receipt-verified, unless verification was skipped. */
  ok: boolean;
  /** Verification ran and found exactly one expected pane observable. */
  verified: boolean;
  /** Pane observation was retried once; the text itself is never pasted twice. */
  retried: boolean;
  /** The exact observable which proved receipt, when verification succeeded. */
  observable: PasteObservable | null;
  /** Why verification failed; null for success or explicitly skipped verification. */
  failure: SendFailure | null;
}

/** Verification policy for one terminal-boundary paste. */
export type PasteVerification =
  | { mode: "literal" }
  | { mode: "native-tui"; agentKind: AgentKind };

export interface SendTextOptions {
  submit?: boolean;
  /** Compatibility switch for launch commands which deliberately skip checking. */
  verify?: boolean;
  /** Defaults to literal echo; handoff delivery must select native-tui. */
  verification?: PasteVerification;
  /** Final domain revalidation after paste proof and immediately before Enter. */
  beforeSubmit?: () => void | Promise<void>;
}

export interface ListPanesOptions {
  /** Deliberate migration-only inspection of a pre-pin session's current window. */
  legacyCurrentWindow?: boolean;
}

export interface MuxAdapter {
  hasSession(session: string): Promise<boolean>;
  /** Store/read a backend-native session marker used to prevent cross-repo reuse. */
  setSessionMarker(session: string, value: string): Promise<void>;
  getSessionMarker(session: string): Promise<string | null>;
  /**
   * Create a detached session whose first pane runs the user's default shell
   * (agents are launched later by typing into that shell — the pane must
   * outlive whatever runs inside it). Returns the first pane's id.
   */
  createSession(
    session: string,
    opts: { cwd: string; width?: number; height?: number },
  ): Promise<string>;
  /** Split a new pane into the bridge-managed window; returns its id. */
  splitPane(session: string, opts: { cwd: string }): Promise<string>;
  selectLayout(
    session: string,
    layout: "tiled" | "even-horizontal" | "even-vertical",
  ): Promise<void>;
  /** List only the bridge-managed window, even when a scratch window is current. */
  listPanes(session: string, opts?: ListPanesOptions): Promise<PaneInfo[]>;
  /** Visible pane text; opts.lines reaches that far back into scrollback. */
  capturePane(paneId: string, opts?: { lines?: number }): Promise<string>;
  /**
   * Injection etiquette, step 0: a freshly spawned pane's shell needs a beat
   * before it can receive input — text typed earlier is echoed by the tty but
   * never reaches a prompt line. Resolves true once the pane has drawn
   * something (its prompt), false on timeout.
   */
  waitForShellReady(paneId: string, timeoutMs?: number): Promise<boolean>;
  /**
   * Inject text as ONE paste (bracketed when the app requests it), verify one
   * exact pane observable unless opts.verify === false, retry observation once
   * without re-pasting, and — only after verification — send one trailing
   * Enter when opts.submit. Never per-line keystrokes.
   */
  sendText(
    paneId: string,
    text: string,
    opts?: SendTextOptions,
  ): Promise<SendResult>;
  focusPane(session: string, paneId: string): Promise<void>;
  /** Persist the configured AgentId in backend-native pane metadata. */
  setPaneAgentId(paneId: string, agentId: string): Promise<void>;
  /** Set the initial display title; native TUIs remain free to replace it. */
  setPaneTitle(paneId: string, title: string): Promise<void>;
  killSession(session: string): Promise<void>;
  /** argv for an interactive attach, e.g. ["tmux", "-L", sock, "attach", "-t", session]. */
  attachArgs(session: string): string[];
}
