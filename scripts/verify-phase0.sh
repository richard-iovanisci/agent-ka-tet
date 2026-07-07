#!/usr/bin/env bash
# Phase 0 exit test (DESIGN.md §6): all four agents' turn-completions and
# permission prompts appear in the daemon with zero scraping (agy may be
# partial). Interactive: walks you through prompting each agent for real.
#
# Usage:
#   scripts/verify-phase0.sh          # full interactive verification
#   scripts/verify-phase0.sh static   # static checks only (no agents needed)
#
# Works on macOS (bash 3.2) and WSL2. Run from the repo root.
set -u

MODE="${1:-full}"
PASS=0
FAIL=0
WARN=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  \033[33mWARN\033[0m %s\n' "$*"; }

# ---------- preconditions ----------------------------------------------------
say ""
say "== preconditions"
for tool in tmux bun jq curl; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool present ($(command -v "$tool"))"
  else
    bad "$tool missing"
  fi
done
[ "$FAIL" -gt 0 ] && { say "fix the tools above first"; exit 1; }

PORT="$(bun -e 'const {loadConfig}=await import("./src/config.ts");console.log(loadConfig().daemonPort)' 2>/dev/null)"
if [ -z "$PORT" ]; then
  bad "could not read daemonPort from bridge config"
  exit 1
fi
ok "daemon port: $PORT"

# ---------- static checks ----------------------------------------------------
say ""
say "== static checks"

if bun test >/dev/null 2>&1; then
  ok "bun test green"
else
  bad "bun test failing — run: bun test"
fi

# Zero-scraping rule: capture-pane may appear only in the mux layer (previews,
# echo-verify) — never as a state source (CLAUDE.md constraint 2).
SCRAPES="$(grep -rln "capture-pane\|capturePane" src --include='*.ts' 2>/dev/null | grep -v '^src/mux/' || true)"
if [ -z "$SCRAPES" ]; then
  ok "no capture-pane use outside src/mux/"
else
  bad "capture-pane referenced outside the mux layer: $SCRAPES"
fi

# Localhost-only rule: the daemon must bind 127.0.0.1.
if grep -q 'hostname: "127.0.0.1"' src/daemon/server.ts 2>/dev/null; then
  ok "daemon binds 127.0.0.1"
else
  bad "src/daemon/server.ts does not pin hostname 127.0.0.1"
fi

if [ "$MODE" = "static" ]; then
  say ""
  say "== static summary: $PASS pass, $FAIL fail, $WARN warn"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

# ---------- live daemon ------------------------------------------------------
say ""
say "== live daemon"
if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  ok "daemon healthy on 127.0.0.1:$PORT"
else
  bad "daemon unreachable — run \`bridge up\` (and \`bridge init\` once) first"
  exit 1
fi

events_since() { # agent, since_id -> newline-separated normalized types
  curl -fsS -m 3 "http://127.0.0.1:$PORT/events?agent=$1&limit=500" |
    jq -r --argjson since "$2" '.[] | select(.id > $since) | .type'
}

max_id() { # agent -> highest stored event id (0 if none)
  curl -fsS -m 3 "http://127.0.0.1:$PORT/events?agent=$1&limit=1" |
    jq -r 'if length == 0 then 0 else .[0].id end'
}

check_agent() { # agent, required(0/1)
  agent="$1"; required="$2"
  say ""
  say "-- $agent"
  base="$(max_id "$agent")"

  printf '   Focus the %s pane, give it a trivial prompt (e.g. "reply with just hi"),\n' "$agent"
  printf '   wait for the turn to END, then press Enter here... '
  read -r _

  types="$(events_since "$agent" "$base")"
  if [ -z "$types" ]; then
    if [ "$required" = "1" ]; then bad "$agent: no events reached the daemon"; else warn "$agent: no events (mux-observed fallback state)"; fi
    return
  fi
  ok "$agent: events flowing ($(printf '%s\n' "$types" | sort -u | tr '\n' ' ' | sed 's/ $//'))"

  if printf '%s\n' "$types" | grep -q '^turn.complete$'; then
    ok "$agent: turn-complete observed"
  else
    if [ "$required" = "1" ]; then bad "$agent: no turn-complete event"; else warn "$agent: no turn-complete (partial coverage is allowed for agy)"; fi
  fi

  if printf '%s\n' "$types" | grep -q '^session.start$\|^turn.start$'; then
    ok "$agent: session/turn start observed"
  else
    warn "$agent: no session.start/turn.start seen (was the session already running? acceptable)"
  fi
}

check_permission() { # agent, hint, required(0/1)
  agent="$1"; hint="$2"; required="$3"
  say ""
  say "-- $agent permission prompt"
  base="$(max_id "$agent")"
  printf '   In the %s pane: %s\n' "$agent" "$hint"
  printf '   When the approval prompt is VISIBLE (do not answer it yet), press Enter here... '
  read -r _
  types="$(events_since "$agent" "$base")"
  if printf '%s\n' "$types" | grep -q '^permission.request$'; then
    ok "$agent: permission.request observed (needs-you badge should be showing in bridge top)"
  else
    if [ "$required" = "1" ]; then bad "$agent: no permission.request event"; else warn "$agent: no permission.request (known gap — no hook event for it)"; fi
  fi
  printf '   Now answer/deny the prompt in the pane, then press Enter here... '
  read -r _
}

say ""
say "Reminder: codex hooks need a one-time /hooks trust approval inside codex,"
say "and agy's statusline forwarder needs the manual settings step (bridge init prints it)."
say "Have bridge top open in another terminal to watch states flip as you go."

check_agent claude 1
check_agent codex 1
check_agent opencode 1
check_agent agy 0

check_permission claude "ask it to run a shell command that is NOT pre-approved (e.g. \"run: touch /tmp/bridge-verify\")" 1
check_permission codex "in on-request approval mode, ask it to run a shell command" 1
check_permission opencode "ask it to run a shell command so it asks for permission" 1
check_permission agy "ask it to run a shell command (permission events have no agy hook — expect WARN)" 0

# ---------- summary ----------------------------------------------------------
say ""
say "== summary: $PASS pass, $FAIL fail, $WARN warn"
if [ "$FAIL" -eq 0 ]; then
  say "Phase 0 exit test PASSED on this machine (run it on the other platform too)."
  exit 0
else
  say "Phase 0 exit test FAILED — see FAIL lines above."
  exit 1
fi
