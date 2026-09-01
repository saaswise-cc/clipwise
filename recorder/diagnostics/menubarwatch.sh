#!/bin/bash
# Menu bar observation harness for SAA-105. DIAGNOSTIC ONLY.
#
# ---------------------------------------------------------------------------
# THIS NEVER GOES INTO THE RECORDER.
#
# Clipwise sits in the "System Audio Recording Only" TCC bucket, and the whole
# positioning argument in Architecture Decision #9 rests on it not being in
# "Screen & System Audio Recording". Core Audio Taps were chosen over
# ScreenCaptureKit precisely so the app never has to ask for screen recording.
# This harness borrows the TERMINAL's screen-recording permission and lives
# outside the app. Do not move any of it into recorder/app, and do not add
# screen capture to Clipwise for any reason.
# ---------------------------------------------------------------------------
#
# WHY IT EXISTS. SAA-105 has produced three different readings of one call,
# because the decisive moment — was the Clipwise item in the bar or not — was
# watched by a person who was simultaneously on the call. This replaces that
# with a record that can be re-read afterwards by someone who was not there.
#
# WHAT IT CAPTURES. Only a menu bar strip: full width, the top MENUBAR_H points,
# via `screencapture -R`. Never the screen, never a window. It runs during real
# client calls, so the region is the narrowest thing that can answer the
# question. Alongside each frame it logs the frontmost application and whether
# a Clipwise capture is running — the frontmost app matters because status
# items get whatever the frontmost app's menus leave behind, and Chrome's menu
# is unusually long, which is an untested variable on SAA-105.
#
# WHERE OUTPUT GOES. Outside the repo, and not /tmp. Decision #11 keeps real
# meeting data out of the working tree, and its 2026-08-07 amendment records
# that the rule is about data rather than source — so this script is committed
# and the strips it produces are not. /tmp is excluded separately: it is cleared
# on reboot, and a diagnostic that evaporates is worse than none because it is
# trusted right up until it is needed.
#
# Usage:
#   menubarwatch.sh check          one frame, validated, nothing retained
#   menubarwatch.sh start          begin watching (backgrounded)
#   menubarwatch.sh stop           stop watching
#   menubarwatch.sh status         is it running, and what has it collected
#   menubarwatch.sh run            watch in the foreground (Ctrl-C to stop)
#
# MUST be launched from Terminal: the Screen Recording permission belongs to
# Terminal, not to this script.

set -uo pipefail

INTERVAL="${MENUBARWATCH_INTERVAL:-10}"
MENUBAR_H="${MENUBARWATCH_HEIGHT:-30}"

HERE="$(cd "$(dirname "$0")" && pwd)"
SCAN="$HERE/menubarscan"

# Durable, outside the repo, dated. Deliberately NOT
# ~/Library/Application Support/clipwise — that is the app's own directory and
# holds real recordings; harness output must not be mistaken for capture output.
ROOT="$HOME/Library/Application Support/clipwise-diagnostics/menubar"
RUN_DIR="$ROOT/$(date +%Y-%m-%d)"
PIDFILE="$ROOT/menubarwatch.pid"

# All four tray states, not one. These are main.js's DOT table verbatim, which
# is what dotIcon paints the tray dot from.
#
# Keying this to a single colour was a real defect while it lasted: the stopped
# grey is what the icon shows when nothing is happening, and a real meeting is
# spent almost entirely in `recording` (#FF453A). A harness matching only the
# grey would have reported ABSENT for the whole window it exists to observe —
# the opposite of the right answer, delivered confidently, which is precisely
# the failure mode this harness was built to end.
#
# The matched state is recorded per frame, so the index also shows what the
# recorder believed it was doing at the moment of each capture.
#
# If the SAA-130 marks ship, stopped and starting become monochrome templates
# that follow the menu bar and will NOT match a fixed colour; recording and
# stalled stay #F4620A bars with these dots and will still match. Revisit then.
CLIPWISE_STATES="${MENUBARWATCH_STATES:-stopped:8E8E93 starting:FF9F0A recording:FF453A stalled:FFD60A}"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

ensure_scanner() {
  if [ ! -x "$SCAN" ] || [ "$HERE/menubarscan.swift" -nt "$SCAN" ]; then
    err "menubarwatch: building menubarscan…"
    swiftc -O "$HERE/menubarscan.swift" -o "$SCAN" || {
      err "menubarwatch: could not build menubarscan"; exit 1; }
  fi
}

screen_width() {
  local wh
  wh="$("$SCAN" screen 2>/dev/null)" || { echo 1512; return; }
  echo "${wh%% *}"
}

frontmost() {
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' \
    2>/dev/null || echo "unknown"
}

capture_state() {
  if pgrep -x miccap >/dev/null 2>&1 || pgrep -x systemtap >/dev/null 2>&1; then
    echo "recording"
  else
    echo "idle"
  fi
}

# One frame plus its metadata. Returns non-zero if the frame is unusable, so a
# blank strip is never filed as evidence of an absent icon.
tick() {
  local dir="$1" stamp png w front state found
  stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  png="$dir/strip-$stamp.png"
  w="$(screen_width)"
  # Metadata read BEFORE the capture, so the log describes the frame rather
  # than the moment after it.
  front="$(frontmost)"
  state="$(capture_state)"
  if ! screencapture -x -R "0,0,${w},${MENUBAR_H}" "$png" 2>/dev/null || [ ! -s "$png" ]; then
    err "menubarwatch: $stamp screencapture FAILED — is Screen Recording granted to Terminal?"
    printf '%s\t%s\t%s\t%s\t%s\n' "$stamp" "CAPTURE_FAILED" "$front" "$state" "-" >> "$dir/index.tsv"
    return 1
  fi
  # shellcheck disable=SC2086 -- CLIPWISE_STATES is a deliberate word list
  found="$("$SCAN" states "$png" $CLIPWISE_STATES 2>/dev/null | head -1)"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$stamp" "$(basename "$png")" "$front" "$state" "$found" >> "$dir/index.tsv"
  # "PRESENT recording 300 2294..2313" -> verdict and state, for the console line
  printf '  %s  %-22s %-10s clipwise=%s %s\n' \
    "$stamp" "${front:0:22}" "$state" "$(echo "$found" | cut -d' ' -f1)" \
    "$(echo "$found" | cut -d' ' -f2)"
  return 0
}

new_index() {
  local dir="$1"
  [ -f "$dir/index.tsv" ] && return
  printf '# SAA-105 menu bar observation — started %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/index.tsv"
  printf '# interval=%ss  strip_height=%spt  clipwise_states=%s\n' "$INTERVAL" "$MENUBAR_H" "$CLIPWISE_STATES" >> "$dir/index.tsv"
  printf '# stamp\tfile\tfrontmost\tcapture_state\tclipwise\n' >> "$dir/index.tsv"
}

cmd_check() {
  ensure_scanner
  local tmp w png
  tmp="$(mktemp -d)"; png="$tmp/check.png"
  w="$(screen_width)"
  log "menubarwatch check"
  log "  screen width      ${w}pt, capturing top ${MENUBAR_H}pt"
  if ! screencapture -x -R "0,0,${w},${MENUBAR_H}" "$png" 2>&1 || [ ! -s "$png" ]; then
    err "  screencapture FAILED."
    err "  Grant Screen Recording to Terminal in System Settings > Privacy & Security,"
    err "  then QUIT AND REOPEN Terminal — a running Terminal does not pick up the"
    err "  new permission."
    rm -rf "$tmp"; exit 1
  fi
  log "  screencapture     OK"
  log ""
  "$SCAN" scan "$png" | sed 's/^/  /'
  local rc=$?
  log ""
  # shellcheck disable=SC2086
  log "  Clipwise: $("$SCAN" states "$png" $CLIPWISE_STATES)"
  log "  (states searched: $CLIPWISE_STATES)"
  log "  frontmost: $(frontmost)   capture: $(capture_state)"
  rm -rf "$tmp"
  return $rc
}

cmd_run() {
  ensure_scanner
  mkdir -p "$RUN_DIR"
  new_index "$RUN_DIR"
  log "menubarwatch: every ${INTERVAL}s -> $RUN_DIR"
  log "menubarwatch: Ctrl-C to stop"
  # A signal sets a flag rather than exiting. Exiting immediately killed the
  # process between screencapture writing a frame and the index line being
  # appended for it, leaving a PNG with no frontmost app and no capture state —
  # an observation with no metadata, in a harness whose entire purpose is a
  # record someone can trust later. The loop finishes the tick it is in.
  STOPPING=0
  trap 'STOPPING=1' INT TERM
  while true; do
    tick "$RUN_DIR"
    [ "$STOPPING" = 1 ] && break
    sleep "$INTERVAL"
    [ "$STOPPING" = 1 ] && break
  done
  log ""
  log "menubarwatch: stopped. $(ls -1 "$RUN_DIR"/strip-*.png 2>/dev/null | wc -l | tr -d ' ') frame(s) in $RUN_DIR"
  exit 0
}

cmd_start() {
  ensure_scanner
  mkdir -p "$ROOT"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    err "menubarwatch: already running (pid $(cat "$PIDFILE"))"; exit 1
  fi
  mkdir -p "$RUN_DIR"
  new_index "$RUN_DIR"
  nohup "$0" run >> "$RUN_DIR/menubarwatch.log" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 2
  if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "menubarwatch: started (pid $(cat "$PIDFILE"))"
    log "  frames  -> $RUN_DIR"
    log "  index   -> $RUN_DIR/index.tsv"
    log "  stop with: $0 stop"
  else
    err "menubarwatch: failed to start — see $RUN_DIR/menubarwatch.log"
    rm -f "$PIDFILE"; exit 1
  fi
}

cmd_stop() {
  if [ ! -f "$PIDFILE" ]; then err "menubarwatch: not running"; exit 1; fi
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    # Only ever this harness's own pid, from its own pidfile. Nothing here
    # touches the recorder or a running capture.
    kill -TERM "$pid" 2>/dev/null
    # Long enough for an in-flight tick to finish and file its index row. A
    # tick is a screencapture plus one scan, well under two seconds.
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
      sleep 1; waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      err "menubarwatch: pid $pid did not stop in ${waited}s — killing; the last frame may lack an index row"
      kill -KILL "$pid" 2>/dev/null
    fi
    log "menubarwatch: stopped (pid $pid)"
  else
    log "menubarwatch: pid $pid was not running"
  fi
  rm -f "$PIDFILE"
  cmd_status
}

cmd_status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "menubarwatch: RUNNING (pid $(cat "$PIDFILE"))"
  else
    log "menubarwatch: not running"
  fi
  if [ -d "$RUN_DIR" ]; then
    log "  today: $(ls -1 "$RUN_DIR"/strip-*.png 2>/dev/null | wc -l | tr -d ' ') frame(s) in $RUN_DIR"
    if [ -f "$RUN_DIR/index.tsv" ]; then
      local present absent
      # grep -c already prints 0 when nothing matches; it only exits 1. The
      # `|| echo 0` this used to carry appended a SECOND zero to the output.
      present="$(grep -c $'\tPRESENT' "$RUN_DIR/index.tsv" 2>/dev/null || true)"
      absent="$(grep -c $'\tABSENT'  "$RUN_DIR/index.tsv" 2>/dev/null || true)"
      blank="$(grep -cE $'\t(BLANK|CAPTURE_FAILED)' "$RUN_DIR/index.tsv" 2>/dev/null || true)"
      log "  clipwise item: PRESENT in ${present:-0} frame(s), ABSENT in ${absent:-0}"
      log "  unusable frames (BLANK / CAPTURE_FAILED): ${blank:-0}"
    # A PNG with no index row has no frontmost app and no capture state beside
    # it. Reported rather than left as a silent disagreement between the file
    # count and the row count.
    local pngs rows
    pngs="$(ls -1 "$RUN_DIR"/strip-*.png 2>/dev/null | wc -l | tr -d ' ')"
    rows="$(grep -vc '^#' "$RUN_DIR/index.tsv" 2>/dev/null || true)"
    if [ "${pngs:-0}" -ne "${rows:-0}" ]; then
      log "  WARNING: $pngs frame(s) but ${rows:-0} index row(s) — $((pngs - ${rows:-0})) frame(s) have no metadata"
    fi
      log "  (an unusable frame counts as neither present nor absent — that is the point)"
    fi
  else
    log "  no frames today ($RUN_DIR does not exist)"
  fi
  log "  all runs: $ROOT"
}

case "${1:-status}" in
  check)  cmd_check ;;
  run)    cmd_run ;;
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) err "usage: $0 check | start | stop | status | run"; exit 1 ;;
esac
