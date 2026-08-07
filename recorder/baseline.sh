#!/bin/bash
# Sequential AudioTee-parity baseline. Same synthetic source captured twice —
# first by audiotee, then by our tap. Two taps on the same output at once would
# be a confound. Format parity + comparable peak/RMS is the bar; byte-identical
# is not, since two playbacks of `say` are two independent audio streams.

set -uo pipefail

OUTDIR="${OUTDIR:-/tmp/clipwise-phase2/out}"
mkdir -p "$OUTDIR"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)

AT_BIN=/tmp/clipwise-phase2/audiotee/.build/release/audiotee
US_BIN=/tmp/clipwise-phase2/systemtap/.build/release/systemtap

AT_PCM="$OUTDIR/baseline-audiotee-$STAMP.f32le.pcm"
US_PCM="$OUTDIR/baseline-systemtap-$STAMP.f32le.pcm"
AT_LOG="$OUTDIR/baseline-audiotee-$STAMP.log"
US_LOG="$OUTDIR/baseline-systemtap-$STAMP.log"
REPORT="$OUTDIR/baseline-report-$STAMP.txt"

SENTENCE='Baseline comparison test. One two three four five six seven eight nine ten.'
VOICE='Samantha'

# --- Capture 1: AudioTee ---
echo "capture 1: audiotee → $AT_PCM"
"$AT_BIN" > "$AT_PCM" 2> "$AT_LOG" &
AT_PID=$!
sleep 0.5
AT_START_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')
say -v "$VOICE" "$SENTENCE"
AT_SAY_END_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')
sleep 0.3
kill -INT "$AT_PID" 2>/dev/null
wait "$AT_PID" 2>/dev/null
AT_STOP_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')

sleep 0.5  # give Core Audio a moment between the two aggregate devices

# --- Capture 2: our tap ---
echo "capture 2: systemtap → $US_PCM"
SYSTEMTAP_OUT="$US_PCM" "$US_BIN" 2> "$US_LOG" &
US_PID=$!
sleep 0.5
US_START_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')
say -v "$VOICE" "$SENTENCE"
US_SAY_END_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')
sleep 0.3
kill -INT "$US_PID" 2>/dev/null
wait "$US_PID" 2>/dev/null
US_STOP_NS=$(python3 -c 'import time;print(int(time.time()*1e9))')

# --- Report ---
{
    echo "=== AudioTee-parity baseline, sequential ==="
    echo "sentence: $SENTENCE"
    echo "voice: $VOICE"
    echo ""
    echo "--- files ---"
    ls -la "$AT_PCM" "$US_PCM"
    echo ""
    echo "--- wall-clock (ns) ---"
    echo "audiotee: say_start=$AT_START_NS say_end=$AT_SAY_END_NS tap_stop=$AT_STOP_NS say_duration_ms=$(( (AT_SAY_END_NS - AT_START_NS) / 1000000 ))"
    echo "systemtap: say_start=$US_START_NS say_end=$US_SAY_END_NS tap_stop=$US_STOP_NS say_duration_ms=$(( (US_SAY_END_NS - US_START_NS) / 1000000 ))"
    echo ""

    echo "--- audiotee stderr metadata line ---"
    grep '"message_type":"metadata"' "$AT_LOG" | head -1 || echo "(no metadata line found)"
    echo ""
    echo "--- our tap stderr ---"
    cat "$US_LOG"
    echo ""

    for pair in "audiotee:$AT_PCM" "systemtap:$US_PCM"; do
        label="${pair%%:*}"
        file="${pair#*:}"
        echo "--- $label: ffprobe (as f32le 48000 mono) ---"
        ffprobe -hide_banner -v error \
            -f f32le -ar 48000 -ac 1 \
            -show_entries stream=codec_name,sample_rate,channels,bits_per_sample,duration \
            -show_entries format=duration,size,bit_rate \
            -of default=noprint_wrappers=0 \
            -i "$file"
        echo "--- $label: ffmpeg astats (peak, RMS) ---"
        ffmpeg -hide_banner -nostats -loglevel info \
            -f f32le -ar 48000 -ac 1 -i "$file" \
            -af astats=metadata=1:reset=0 -f null - 2>&1 \
            | grep -E "(Overall|Peak level dB|RMS level dB|Max level|Min level|Peak count|Bit depth)" \
            | head -12
        echo ""
    done

    echo "--- comparison summary ---"
    AT_SIZE=$(stat -f %z "$AT_PCM")
    US_SIZE=$(stat -f %z "$US_PCM")
    AT_DUR=$(python3 -c "print($AT_SIZE / 48000 / 4)")
    US_DUR=$(python3 -c "print($US_SIZE / 48000 / 4)")
    echo "audiotee : bytes=$AT_SIZE duration_s=$AT_DUR"
    echo "systemtap: bytes=$US_SIZE duration_s=$US_DUR"
    echo "delta_bytes=$((US_SIZE - AT_SIZE))"
} | tee "$REPORT"
