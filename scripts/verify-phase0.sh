#!/usr/bin/env bash
# Phase 0 exit test for one Claude Code + one Codex native TUI.
# Bash 3.2 compatible; run on macOS and inside WSL2.
set -u
set -o pipefail

usage() {
  printf '%s\n' \
    "usage: scripts/verify-phase0.sh static" \
    "       scripts/verify-phase0.sh full [target-config-dir]" \
    "  static  source-only checks" \
    "  full    source + interactive live checks (default; requires a TTY)"
}

MODE="${1:-full}"
case "$MODE" in
  static|full) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; printf 'error: unknown mode %s\n' "$MODE" >&2; exit 2 ;;
esac
if { [ "$MODE" = "static" ] && [ "$#" -ne 1 ]; } || \
   { [ "$MODE" = "full" ] && [ "$#" -gt 2 ]; }; then
  usage >&2
  exit 2
fi

BRIDGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)" || exit 1
if [ "$MODE" = "full" ] && { [ ! -t 0 ] || [ ! -t 1 ]; }; then
  printf 'error: full verification requires interactive stdin and stdout TTYs\n' >&2
  exit 2
fi

PASS=0
FAIL=0
WARN=0
say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  \033[33mWARN\033[0m %s\n' "$*"; }

pause_enter() {
  printf '%s' "$1"
  if ! IFS= read -r _; then
    bad "interactive input ended; aborting"
    return 1
  fi
}

say ""
say "== preconditions"
TOOLS="tmux bun"
if [ "$MODE" = "full" ]; then TOOLS="$TOOLS jq curl ps"; fi
for tool in $TOOLS; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool present ($(command -v "$tool"))"
  else
    bad "$tool missing"
  fi
done
[ "$FAIL" -gt 0 ] && { say "fix the tools above first"; exit 1; }

TMUX_VERSION="$(tmux -V | awk '{print $2}')"
TMUX_MAJOR="${TMUX_VERSION%%.*}"
TMUX_REST="${TMUX_VERSION#*.}"
TMUX_MINOR="${TMUX_REST%%[!0-9]*}"
if [ -n "$TMUX_MAJOR" ] && [ -n "$TMUX_MINOR" ] && \
   { [ "$TMUX_MAJOR" -gt 3 ] || { [ "$TMUX_MAJOR" -eq 3 ] && [ "$TMUX_MINOR" -ge 2 ]; }; }; then
  ok "tmux >= 3.2 ($TMUX_VERSION)"
else
  bad "tmux >= 3.2 required (found $TMUX_VERSION)"
  exit 1
fi
ok "source checkout: $BRIDGE_ROOT"

say ""
say "== static checks"
if (cd "$BRIDGE_ROOT" && bun test >/dev/null 2>&1); then
  ok "bun test green"
else
  bad "bun test failing — run from $BRIDGE_ROOT"
fi
if (cd "$BRIDGE_ROOT" && bun run typecheck >/dev/null 2>&1); then
  ok "TypeScript typecheck green"
else
  bad "typecheck failing — run: bun run typecheck"
fi
SCRAPES="$(cd "$BRIDGE_ROOT" && grep -rlE --include='*.ts' 'capture-pane|capturePane' src 2>/dev/null | grep -v '^src/mux/' | grep -v '\.test\.ts$' || true)"
if [ -z "$SCRAPES" ]; then
  ok "no capture-pane use outside src/mux/"
else
  bad "capture-pane referenced outside the mux layer: $SCRAPES"
fi
if grep -q 'hostname: "127.0.0.1"' "$BRIDGE_ROOT/src/daemon/server.ts" 2>/dev/null; then
  ok "daemon binds 127.0.0.1"
else
  bad "daemon server does not pin hostname 127.0.0.1"
fi

if [ "$MODE" = "static" ]; then
  say ""
  say "== static summary: $PASS pass, $FAIL fail, $WARN warn"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

TARGET_INPUT="${2:-$PWD}"
if ! CONFIG_DIR="$(CDPATH= cd -- "$TARGET_INPUT" 2>/dev/null && pwd -P)"; then
  printf 'error: target config directory does not exist: %s\n' "$TARGET_INPUT" >&2
  exit 2
fi

if ! CONFIG_INFO="$(
  cd "$BRIDGE_ROOT" && BRIDGE_TARGET="$CONFIG_DIR" bun -e '
    const { loadConfig, configFingerprint, bridgeSessionMarker } = await import("./src/config.ts");
    const { daemonPidFile } = await import("./src/paths.ts");
    const cfg = loadConfig(process.env.BRIDGE_TARGET);
    console.log(JSON.stringify({
      port: cfg.daemonPort,
      session: cfg.session,
      configDir: cfg.configDir,
      sourceRoot: cfg.sourceRoot,
      sourceFingerprint: cfg.sourceFingerprint,
      fingerprint: configFingerprint(cfg),
      marker: bridgeSessionMarker(cfg),
      pidFile: daemonPidFile(cfg.daemonPort),
      legacyConfig: cfg.legacyAgentsConfig,
      roster: cfg.agents.map(({ id, kind, enabled }) => ({ id, kind, enabled })),
    }));
  '
)"; then
  bad "could not load bridge configuration from $CONFIG_DIR"
  exit 1
fi

PORT="$(printf '%s' "$CONFIG_INFO" | jq -er '.port')" || exit 1
SESSION="$(printf '%s' "$CONFIG_INFO" | jq -er '.session')" || exit 1
SOURCE_ROOT="$(printf '%s' "$CONFIG_INFO" | jq -er '.sourceRoot')" || exit 1
SOURCE_FINGERPRINT="$(printf '%s' "$CONFIG_INFO" | jq -er '.sourceFingerprint')" || exit 1
CONFIG_FINGERPRINT="$(printf '%s' "$CONFIG_INFO" | jq -er '.fingerprint')" || exit 1
SESSION_MARKER="$(printf '%s' "$CONFIG_INFO" | jq -er '.marker')" || exit 1
PID_FILE="$(printf '%s' "$CONFIG_INFO" | jq -er '.pidFile')" || exit 1
ROSTER_JSON="$(printf '%s' "$CONFIG_INFO" | jq -c '.roster')" || exit 1
CLAUDE_ID="$(printf '%s' "$CONFIG_INFO" | jq -r '.roster[] | select(.kind == "claude" and .enabled) | .id')"
CODEX_ID="$(printf '%s' "$CONFIG_INFO" | jq -r '.roster[] | select(.kind == "codex" and .enabled) | .id')"

say ""
say "== live configuration"
if [ "$SOURCE_ROOT" = "$BRIDGE_ROOT" ]; then
  ok "runtime source is this checkout: $SOURCE_ROOT"
else
  bad "loaded runtime source $SOURCE_ROOT does not match verifier checkout $BRIDGE_ROOT"
  exit 1
fi
if [ -z "$CLAUDE_ID" ] || [ -z "$CODEX_ID" ]; then
  bad "full Phase 0 verification requires one enabled Claude and one enabled Codex instance"
  exit 1
fi
if [ "$(printf '%s' "$CONFIG_INFO" | jq -r '.legacyConfig')" = "true" ]; then
  warn "legacy object-shaped agents config is being normalized; migrate it to the ordered array format"
fi
ok "target config: $CONFIG_DIR"
ok "daemon port/session: $PORT / $SESSION"
ok "agent ids: Claude=$CLAUDE_ID Codex=$CODEX_ID"

status_json() {
  curl -fsS -m 3 "http://127.0.0.1:$PORT/status"
}

status_matches_config() {
  printf '%s' "$1" | jq -e \
    --arg dir "$CONFIG_DIR" \
    --arg source "$SOURCE_ROOT" \
    --arg sourceFingerprint "$SOURCE_FINGERPRINT" \
    --arg fingerprint "$CONFIG_FINGERPRINT" \
    --argjson roster "$ROSTER_JSON" '
      .daemon.configDir == $dir and
      .daemon.sourceRoot == $source and
      .daemon.sourceFingerprint == $sourceFingerprint and
      .daemon.configFingerprint == $fingerprint and
      ([.agents[] | {id: .agent, kind, enabled}] == $roster)
    ' >/dev/null 2>&1
}

say ""
say "== live ownership and layout"
if ! STATUS="$(status_json)"; then
  bad "daemon unreachable — run bridge init, then bridge up, in $CONFIG_DIR"
  exit 1
fi
if status_matches_config "$STATUS"; then
  ok "daemon status matches this target configuration"
else
  bad "port $PORT belongs to another, stale, or legacy bridge configuration"
  exit 1
fi

if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  bad "tmux session $SESSION is not running"
  exit 1
fi
SESSION_ID="$(tmux display-message -p -t "=$SESSION:" '#{session_id}' 2>/dev/null)"
LIVE_MARKER="$(tmux show-options -v -t "$SESSION_ID" @agent-bridge-owner 2>/dev/null || true)"
if [ "$LIVE_MARKER" = "$SESSION_MARKER" ]; then
  ok "tmux session ownership marker matches this configuration"
else
  bad "tmux session marker is missing, stale, or belongs to another target"
  exit 1
fi

WINDOW_IDS="$(tmux list-windows -t "$SESSION_ID" -F '#{window_id}' 2>/dev/null || true)"
WINDOW_COUNT="$(printf '%s\n' "$WINDOW_IDS" | awk 'NF { count++ } END { print count + 0 }')"
if [ "$WINDOW_COUNT" != "1" ]; then
  bad "expected exactly one bridge-owned tmux window (found $WINDOW_COUNT)"
  exit 1
fi
WINDOW_ID="$(printf '%s\n' "$WINDOW_IDS" | awk 'NF { print; exit }')"
PANE_TARGET="$WINDOW_ID"
PANE_IDS_BEFORE="$(tmux list-panes -t "$PANE_TARGET" -F '#{pane_id}' | sort | tr '\n' ' ')"
PANE_COUNT="$(tmux list-panes -t "$PANE_TARGET" -F '#{pane_id}' | wc -l | tr -d ' ')"
PANE_COLUMNS="$(tmux list-panes -t "$PANE_TARGET" -F '#{pane_left}' | sort -u | wc -l | tr -d ' ')"
PANE_AGENT_IDS_JSON="$(tmux list-panes -t "$PANE_TARGET" -F '#{@agent-bridge-agent-id}' | jq -Rsc 'split("\n")[:-1]')"
EXPECTED_AGENT_IDS_JSON="$(printf '%s' "$ROSTER_JSON" | jq -c '[.[] | select(.enabled) | .id]')"
if [ "$PANE_COUNT" = "2" ] && [ "$PANE_COLUMNS" = "2" ]; then
  ok "tmux has exactly two side-by-side panes"
else
  bad "expected two side-by-side panes (found $PANE_COUNT panes across $PANE_COLUMNS columns)"
fi
if [ "$PANE_AGENT_IDS_JSON" = "$EXPECTED_AGENT_IDS_JSON" ]; then
  ok "durable pane identity markers match the configured agent order"
else
  bad "pane identity markers do not match the configured agent order"
fi
[ "$FAIL" -gt 0 ] && { say "fix ownership/layout failures before live prompts"; exit 1; }

session_intact() {
  local live_marker live_windows live_panes live_agent_ids
  tmux has-session -t "=$SESSION" 2>/dev/null || return 1
  live_marker="$(tmux show-options -v -t "$SESSION_ID" @agent-bridge-owner 2>/dev/null || true)"
  [ "$live_marker" = "$SESSION_MARKER" ] || return 1
  live_windows="$(tmux list-windows -t "$SESSION_ID" -F '#{window_id}' 2>/dev/null || true)"
  [ "$live_windows" = "$WINDOW_ID" ] || return 1
  live_panes="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | sort | tr '\n' ' ')"
  [ "$live_panes" = "$PANE_IDS_BEFORE" ] || return 1
  live_agent_ids="$(tmux list-panes -t "$WINDOW_ID" -F '#{@agent-bridge-agent-id}' 2>/dev/null | jq -Rsc 'split("\n")[:-1]')"
  [ "$live_agent_ids" = "$PANE_AGENT_IDS_JSON" ]
}

event_rows_since() {
  curl -fsS -m 3 "http://127.0.0.1:$PORT/events?agent=$1&limit=500" |
    jq --argjson since "$2" '[.[] | select(.id > $since)] | sort_by(.id)'
}

max_id() {
  curl -fsS -m 3 "http://127.0.0.1:$PORT/events?agent=$1&limit=1" |
    jq -r 'if length == 0 then 0 else .[0].id end'
}

agent_state() {
  status_json | jq -r --arg agent "$1" '.agents[] | select(.agent == $agent) | .state'
}

check_agent() {
  local agent="$1"
  local base rows state types
  say ""
  say "-- $agent working -> idle"
  base="$(max_id "$agent")"
  say "   Focus the $agent pane and submit a harmless prompt that will take several seconds."
  if ! pause_enter "   As soon as it starts working, switch back and press Enter... "; then exit 1; fi
  rows="$(event_rows_since "$agent" "$base")"
  if printf '%s' "$rows" | jq -e 'any(.[]; .type == "turn.start")' >/dev/null; then
    ok "$agent: turn.start observed"
  else
    bad "$agent: no turn.start event"
  fi
  state="$(agent_state "$agent")"
  if [ "$state" = "working" ]; then
    ok "$agent: live daemon state is working"
  else
    bad "$agent: expected working while the turn was active (state: ${state:-unavailable})"
  fi

  if ! pause_enter "   Wait for the turn to finish, then press Enter... "; then exit 1; fi
  rows="$(event_rows_since "$agent" "$base")"
  types="$(printf '%s' "$rows" | jq -r '.[].type' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$types" ]; then ok "$agent: events flowing ($types)"; else bad "$agent: no events reached the daemon"; fi
  if printf '%s' "$rows" | jq -e '
      ([.[] | select(.type == "turn.start") | .id] | min) as $start |
      ([.[] | select(.type == "turn.complete") | .id] | max) as $stop |
      ($start != null and $stop != null and $start < $stop)
    ' >/dev/null; then
    ok "$agent: ordered turn.start -> turn.complete observed"
  else
    bad "$agent: missing ordered turn completion"
  fi
  state="$(agent_state "$agent")"
  if [ "$state" = "idle" ]; then
    ok "$agent: final daemon state is idle"
  else
    bad "$agent: expected idle after completion (state: ${state:-unavailable})"
  fi
}

check_permission() {
  local agent="$1"
  local hint="$2"
  local base rows state
  say ""
  say "-- $agent permission prompt"
  base="$(max_id "$agent")"
  say "   $hint"
  if ! pause_enter "   When the approval prompt is visible (do not answer yet), press Enter... "; then exit 1; fi
  rows="$(event_rows_since "$agent" "$base")"
  if printf '%s' "$rows" | jq -e 'any(.[]; .type == "permission.request")' >/dev/null; then
    ok "$agent: permission.request observed"
  else
    bad "$agent: no permission.request event"
  fi
  state="$(agent_state "$agent")"
  if [ "$state" = "needs_you" ]; then
    ok "$agent: daemon state is needs_you while approval is visible"
  else
    bad "$agent: expected needs_you (state: ${state:-unavailable})"
  fi
  if ! pause_enter "   Approve it, wait for the agent to continue or finish, then press Enter... "; then exit 1; fi
  state="$(agent_state "$agent")"
  case "$state" in
    working|idle) ok "$agent: approval state cleared ($state)" ;;
    *) bad "$agent: expected working or idle after approval (state: ${state:-unavailable})" ;;
  esac
}

say ""
say "Codex hooks require one-time /hooks trust approval."
say "A Codex card with no current-daemon events is expected to say launching / awaiting first observed turn."
say "Keep bridge top visible in another terminal during these checks."
check_agent "$CLAUDE_ID"
check_agent "$CODEX_ID"
check_permission "$CLAUDE_ID" "Use a Claude permission mode that asks before Bash, then request a harmless command not in its allowlist."
check_permission "$CODEX_ID" "Use on-request/untrusted approval policy, then request a harmless command not in its allowlist."
printf '   Did bridge top visibly show both working/idle and needs-you transitions? Type yes: '
if ! IFS= read -r board_seen; then
  bad "interactive input ended"
elif [ "$board_seen" = "yes" ]; then
  ok "bridge top displayed the live transitions"
else
  bad "bridge top transition display was not confirmed"
fi

if [ "$FAIL" -gt 0 ]; then
  say ""
  say "Live event checks failed; daemon-independence shutdown is intentionally skipped."
  exit 1
fi

say ""
say "== daemon independence"
STATUS="$(status_json)" || { bad "daemon disappeared before independence test"; exit 1; }
status_matches_config "$STATUS" || { bad "daemon identity changed before independence test"; exit 1; }
DAEMON_PID="$(printf '%s' "$STATUS" | jq -r '.daemon.pid // ""')"
case "$DAEMON_PID" in
  ''|*[!0-9]*) bad "daemon status did not contain a numeric pid"; exit 1 ;;
esac
if [ "$DAEMON_PID" -le 1 ]; then bad "refusing invalid daemon pid $DAEMON_PID"; exit 1; fi
if [ ! -f "$PID_FILE" ]; then bad "daemon pidfile is missing: $PID_FILE"; exit 1; fi
FILE_PID="$(tr -d '[:space:]' < "$PID_FILE")"
if [ "$FILE_PID" != "$DAEMON_PID" ]; then
  bad "pidfile/status mismatch ($FILE_PID vs $DAEMON_PID); refusing to signal"
  exit 1
fi
DAEMON_COMMAND="$(ps -p "$DAEMON_PID" -o command= 2>/dev/null || true)"
case "$DAEMON_COMMAND" in
  *"$BRIDGE_ROOT/src/daemon/index.ts"*--dir*"$CONFIG_DIR"*)
    ok "daemon process command matches this source checkout and target config"
    ;;
  *) bad "daemon process command does not prove target ownership; refusing to signal"; exit 1 ;;
esac
if session_intact; then
  ok "original tmux session, window, and pane identities are still intact"
else
  bad "tmux identity changed before shutdown; refusing to signal"
  exit 1
fi

printf '   This will stop only daemon pid %s. Type "STOP %s" to continue: ' "$DAEMON_PID" "$DAEMON_PID"
if ! IFS= read -r stop_confirmation; then bad "interactive input ended"; exit 1; fi
if [ "$stop_confirmation" != "STOP $DAEMON_PID" ]; then
  bad "shutdown confirmation did not match; daemon left running"
  exit 1
fi

# The confirmation wait is unbounded. Re-prove every identity immediately
# before signalling so an exited daemon/recycled PID cannot inherit stale
# status, pidfile, process-command, or tmux evidence.
STATUS="$(status_json)" || { bad "daemon disappeared while awaiting confirmation"; exit 1; }
status_matches_config "$STATUS" || { bad "daemon identity changed while awaiting confirmation"; exit 1; }
CONFIRMED_PID="$(printf '%s' "$STATUS" | jq -r '.daemon.pid // ""')"
if [ "$CONFIRMED_PID" != "$DAEMON_PID" ]; then
  bad "daemon pid changed while awaiting confirmation; refusing to signal"
  exit 1
fi
if [ ! -f "$PID_FILE" ] || [ "$(tr -d '[:space:]' < "$PID_FILE")" != "$DAEMON_PID" ]; then
  bad "pidfile changed while awaiting confirmation; refusing to signal"
  exit 1
fi
DAEMON_COMMAND="$(ps -p "$DAEMON_PID" -o command= 2>/dev/null || true)"
case "$DAEMON_COMMAND" in
  *"$BRIDGE_ROOT/src/daemon/index.ts"*--dir*"$CONFIG_DIR"*) ;;
  *) bad "daemon process command changed while awaiting confirmation; refusing to signal"; exit 1 ;;
esac
if ! session_intact; then
  bad "tmux identity changed while awaiting confirmation; refusing to signal"
  exit 1
fi
ok "daemon and tmux ownership revalidated immediately before shutdown"

RESTART_NEEDED=0
STOPPED_PID="$DAEMON_PID"
CLEANING=0

restart_daemon() {
  local attempts status
  # `bridge up` creates a missing session. Never call it from cleanup unless
  # the exact original session, window, and pane ids are still present.
  session_intact || return 1
  attempts=0
  while [ "$attempts" -lt 10 ] && kill -0 "$STOPPED_PID" 2>/dev/null; do
    attempts=$((attempts + 1))
    sleep 1
  done
  session_intact || return 1
  (cd "$CONFIG_DIR" && bun "$BRIDGE_ROOT/bin/bridge" up --existing-session-only >/dev/null 2>&1) || return 1
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    status="$(status_json 2>/dev/null || true)"
    if [ -n "$status" ] && status_matches_config "$status"; then return 0; fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

cleanup() {
  if [ "$CLEANING" = "1" ]; then return; fi
  CLEANING=1
  if [ "$RESTART_NEEDED" = "1" ]; then
    say ""
    say "cleanup: restoring the verified bridge daemon..."
    if ! session_intact; then
      say "cleanup: original tmux identity changed; refusing automatic bridge up" >&2
      say "cleanup: inspect the session, then run bridge up manually in $CONFIG_DIR" >&2
    elif restart_daemon; then
      RESTART_NEEDED=0
      say "cleanup: daemon restored"
    else
      say "cleanup: daemon restart failed; run bridge up manually in $CONFIG_DIR" >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

RESTART_NEEDED=1
if ! kill -TERM "$DAEMON_PID" 2>/dev/null; then
  RESTART_NEEDED=0
  bad "could not signal verified daemon pid $DAEMON_PID"
  exit 1
fi
attempts=0
while [ "$attempts" -lt 10 ] && kill -0 "$DAEMON_PID" 2>/dev/null; do
  attempts=$((attempts + 1))
  sleep 1
done
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  bad "daemon remained alive after SIGTERM"
  exit 1
else
  ok "daemon stopped"
fi

if session_intact; then
  ok "exact tmux session, window, and pane ids survived daemon shutdown"
else
  bad "tmux identity changed when daemon stopped; automatic restart is disabled"
  exit 1
fi

say "   With the daemon offline, prompt both TUIs with: reply with just still-alive"
printf '   Did both native TUIs reply normally? Type yes: '
if ! IFS= read -r survived; then
  bad "interactive input ended"
elif [ "$survived" = "yes" ]; then
  ok "both agents remained interactive without the daemon"
else
  bad "daemon independence was not confirmed"
fi

say "   Restarting through the existing-session recovery path..."
if restart_daemon; then
  RESTART_NEEDED=0
  ok "daemon restarted with the exact target configuration"
else
  bad "daemon did not restart; the EXIT trap will retry"
fi
if session_intact; then
  ok "daemon recovery left the original tmux identities untouched"
else
  bad "tmux identity changed during daemon recovery"
fi

say ""
say "== summary: $PASS pass, $FAIL fail, $WARN warn"
if [ "$FAIL" -eq 0 ]; then
  say "Phase 0 live test passed on this machine; repeat on the other target platform."
  exit 0
fi
say "Phase 0 live test failed — see FAIL lines above."
exit 1
