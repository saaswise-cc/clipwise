#!/usr/bin/env bash
set -euo pipefail

STATE="${1:-}"
case "$STATE" in
  pending|granted|denied) ;;
  *) echo "usage: $0 <pending|granted|denied>"; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_NAME="Clipwise-TCC-Probe"
APP_PATH="$SCRIPT_DIR/out/$PRODUCT_NAME-darwin-arm64/$PRODUCT_NAME.app"
test -d "$APP_PATH" || { echo "!! app not built. Run ./build.sh first."; exit 1; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUTDIR="$HOME/Library/Application Support/clipwise/saa-87-probe/${STATE}-${TS}"
mkdir -p "$OUTDIR"

echo "==> State: $STATE"
echo "==> Output: $OUTDIR"
echo "==> Launching $APP_PATH (60s hard cap)"

# Launch via LaunchServices so TCC attributes the grant to the .app, not this shell.
# `open -W` waits for the app to exit; a polling loop enforces the hard 60s cap.
open -W -a "$APP_PATH" --args --outdir "$OUTDIR" &
OPEN_PID=$!
TIMED_OUT=false
for _ in $(seq 1 60); do
  kill -0 "$OPEN_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$OPEN_PID" 2>/dev/null; then
  TIMED_OUT=true
  echo "!! hard 60s timeout — killing app and open"
  pkill -f "$APP_PATH/Contents/MacOS/" 2>/dev/null || true
  kill -TERM "$OPEN_PID" 2>/dev/null || true
  sleep 2
  kill -KILL "$OPEN_PID" 2>/dev/null || true
fi
EXIT_OPEN=0
wait "$OPEN_PID" 2>/dev/null || EXIT_OPEN=$?

cat > "$OUTDIR/run-metadata.json" <<EOF
{
  "state": "$STATE",
  "timestamp_utc": "$TS",
  "hard_timeout_hit": $TIMED_OUT,
  "open_exit_code": $EXIT_OPEN,
  "bundle_id": "io.quorom.clipwise.saa87-tccprobe-20260809",
  "app_path": "$APP_PATH"
}
EOF

echo ""
echo "==================== REPORT ===================="
echo "STATE:        $STATE"
echo "OUTPUT DIR:   $OUTDIR"
echo "HARD TIMEOUT: $TIMED_OUT"
echo ""

echo "--- run-metadata.json ---"
cat "$OUTDIR/run-metadata.json"
echo ""

echo "--- status.json (from main.js on tap exit) ---"
if [ -f "$OUTDIR/status.json" ]; then
  cat "$OUTDIR/status.json"
else
  echo "(missing — main.js did not reach its exit handler; likely killed or timed out)"
fi
echo ""

echo "--- stderr.log (tap) ---"
if [ -f "$OUTDIR/stderr.log" ]; then
  cat "$OUTDIR/stderr.log"
else
  echo "(missing — tap did not run or produced no stderr)"
fi
echo ""

echo "--- bytes vs expected ---"
PCM="$OUTDIR/system.f32le.pcm"
if [ ! -f "$PCM" ]; then
  echo "  (no PCM file)"
elif [ ! -s "$PCM" ]; then
  echo "  actual: 0 bytes (file empty)"
elif [ ! -f "$OUTDIR/stderr.log" ]; then
  ACTUAL=$(wc -c < "$PCM" | tr -d ' ')
  echo "  actual: $ACTUAL bytes"
  echo "  (no stderr.log — cannot derive format or duration)"
else
  ACTUAL=$(wc -c < "$PCM" | tr -d ' ')
  RATE=$(grep -oE 'sample_rate=[0-9]+' "$OUTDIR/stderr.log" | head -1 | cut -d= -f2)
  CH=$(grep -oE 'channels=[0-9]+' "$OUTDIR/stderr.log" | head -1 | cut -d= -f2)
  BITS=$(grep -oE 'bits=[0-9]+' "$OUTDIR/stderr.log" | head -1 | cut -d= -f2)
  DUR_S=$(grep -oE 'duration_s=[0-9.]+' "$OUTDIR/stderr.log" | head -1 | cut -d= -f2)
  if [ -n "$RATE" ] && [ -n "$CH" ] && [ -n "$BITS" ] && [ -n "$DUR_S" ]; then
    EXPECTED=$(python3 -c "print(int($RATE * ($BITS/8) * $CH * $DUR_S))")
    PCT=$(python3 -c "e=$EXPECTED; print(f'{100.0 * $ACTUAL / e:.2f}' if e else 'n/a')")
    echo "  format:   rate=$RATE ch=$CH bits=$BITS"
    echo "  duration: ${DUR_S}s (tap's own duration_s from teardown)"
    echo "  actual:   $ACTUAL bytes"
    echo "  expected: $EXPECTED bytes"
    echo "  ratio:    $PCT%"
  else
    echo "  actual: $ACTUAL bytes"
    echo "  (missing format=[rate=$RATE ch=$CH bits=$BITS] or duration=$DUR_S — tap teardown incomplete)"
  fi
fi
echo ""

echo "--- RMS (over f32le) ---"
if [ -f "$PCM" ] && [ -s "$PCM" ]; then
  python3 - "$PCM" <<'PY'
import struct, sys
p = sys.argv[1]
with open(p, 'rb') as f:
    data = f.read()
n = len(data) // 4
if n == 0:
    print('  (zero samples)'); sys.exit(0)
floats = struct.unpack(f'<{n}f', data[:n*4])
ss = 0.0
for x in floats: ss += x * x
rms = (ss / n) ** 0.5
print(f'  samples: {n}')
print(f'  rms:     {rms:.6f}')
PY
else
  echo "  (no PCM file or zero-length)"
fi
echo "=================================================="
