/**
 * Mux abstraction (DESIGN.md §4). The multiplexer hosts the agent TUIs; this
 * adapter does only the jobs the daemon needs — spawn panes, capture
 * previews, inject input at the terminal boundary, focus panes — behind an
 * interface so a second backend (Zellij, parked per DESIGN.md §5) can slot in
 * without touching callers.
 */

/** One pane in a mux session, as reported by the backend. */
export interface PaneInfo {
  /** Backend-global pane id (tmux: "%3"). Stable for the pane's lifetime. */
  id: string;
  /** Position within the window. */
  index: number;
  /** Pane title (settable via setPaneTitle). */
  title: string;
  /** Command currently running in the pane (e.g. the user's shell). */
  command: string;
  width: number;
  height: number;
  active: boolean;
}

/** Outcome of an injection attempt (DESIGN.md §4 injection etiquette). */
export interface SendResult {
  /** Text was delivered (and echo-verified, unless verification was skipped). */
  ok: boolean;
  /** Echo verification ran and found the text in the pane. */
  verified: boolean;
  /** The paste was retried once after a failed verification. */
  retried: boolean;
}

export interface MuxAdapter {
  hasSession(session: string): Promise<boolean>;
  /**
   * Create a detached session whose first pane runs the user's default shell
   * (agents are launched later by typing into that shell — the pane must
   * outlive whatever runs inside it). Returns the first pane's id.
   */
  createSession(
    session: string,
    opts: { cwd: string; width?: number; height?: number },
  ): Promise<string>;
  /** Split a new pane into the session's current window; returns its id. */
  splitPane(session: string, opts: { cwd: string }): Promise<string>;
  selectLayout(
    session: string,
    layout: "tiled" | "even-horizontal" | "even-vertical",
  ): Promise<void>;
  listPanes(session: string): Promise<PaneInfo[]>;
  /** Visible pane text; opts.lines reaches that far back into scrollback. */
  capturePane(paneId: string, opts?: { lines?: number }): Promise<string>;
  /**
   * Inject text as ONE paste (bracketed when the app requests it), echo-verify
   * unless opts.verify === false (retrying the paste once on failure), and —
   * only after the paste lands — send a single trailing Enter when
   * opts.submit. Never per-line keystrokes.
   */
  sendText(
    paneId: string,
    text: string,
    opts?: { submit?: boolean; verify?: boolean },
  ): Promise<SendResult>;
  focusPane(session: string, paneId: string): Promise<void>;
  setPaneTitle(paneId: string, title: string): Promise<void>;
  killSession(session: string): Promise<void>;
  /** argv for an interactive attach, e.g. ["tmux", "-L", sock, "attach", "-t", session]. */
  attachArgs(session: string): string[];
}
