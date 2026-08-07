#!/bin/bash
# Two-track capture: systemtap (Clipwise's own Core Audio tap) + mic (ffmpeg avfoundation).
# Ctrl-C stops both cleanly. A background poller records default input/output devices
# every 1s so a mid-call switch is visible after the fact.

set -uo pipefail

OUTDIR="${OUTDIR:-$HOME/Library/Application Support/clipwise/recordings}"
mkdir -p "$OUTDIR"

STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
WALL_NS_START=$(python3 -c 'import time; print(int(time.time()*1e9))')

DEVICES_LOG="$OUTDIR/devices-$STAMP.txt"
POLLER_LOG="$OUTDIR/poller-$STAMP.log"
TAP_PCM="$OUTDIR/system-$STAMP.f32le.pcm"
TAP_LOG="$OUTDIR/systemtap-$STAMP.log"
MIC_WAV="$OUTDIR/mic-$STAMP.wav"
MIC_LOG="$OUTDIR/mic-$STAMP.log"
CLEANUP_LOG="$OUTDIR/cleanup-$STAMP.log"

RECORDER_DIR="$(dirname "$0")"
SYSTEMTAP_BIN="$RECORDER_DIR/systemtap/.build/release/systemtap"
AUDIODEVS="$RECORDER_DIR/audiodevs"
if [ ! -x "$AUDIODEVS" ]; then
    echo "ERROR: audiodevs binary missing at $AUDIODEVS — run: swiftc -O $RECORDER_DIR/audiodevs.swift -o $AUDIODEVS" >&2
    exit 1
fi

echo "wall_ns_start=$WALL_NS_START stamp=$STAMP" | tee "$DEVICES_LOG"

# --- Preamble: current device snapshot ------------------------------------
echo "--- avfoundation device listing at start ---" >> "$DEVICES_LOG"
FF_DEVLIST=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1)
echo "$FF_DEVLIST" | grep -E "(video devices|audio devices|\\[[0-9]+\\])" >> "$DEVICES_LOG" || true
echo "--- Core Audio default devices at start ---" >> "$DEVICES_LOG"
SNAPSHOT=$("$AUDIODEVS" --once)
echo "$SNAPSHOT" >> "$DEVICES_LOG"

# --- Resolve mic by name (not by hardcoded index) --------------------------
# Pull default input name from the Core Audio snapshot.
MIC_NAME=$(echo "$SNAPSHOT" | sed -n 's/.*in_name="\([^"]*\)".*/\1/p')
MIC_UID=$(echo "$SNAPSHOT" | sed -n 's/.*in_uid="\([^"]*\)".*/\1/p')
if [ -z "$MIC_NAME" ]; then
    echo "ERROR: could not resolve default input device name" >> "$DEVICES_LOG"
    exit 1
fi

# Find the ffmpeg avfoundation index that maps to MIC_NAME right now.
MIC_INDEX=$(echo "$FF_DEVLIST" | awk -v target="$MIC_NAME" '
    /AVFoundation audio devices:/ { in_audio=1; next }
    /AVFoundation video devices:/ { in_audio=0; next }
    in_audio && /\[[0-9]+\]/ {
        match($0, /\[[0-9]+\]/);
        idx = substr($0, RSTART+1, RLENGTH-2);
        line = $0;
        sub(/.*\][ \t]*/, "", line);
        if (line == target) { print idx; exit }
    }
')
if [ -z "$MIC_INDEX" ]; then
    echo "ERROR: mic name \"$MIC_NAME\" not found in ffmpeg audio device list" >> "$DEVICES_LOG"
    exit 1
fi
echo "resolved_mic name=\"$MIC_NAME\" uid=\"$MIC_UID\" ffmpeg_index=$MIC_INDEX" >> "$DEVICES_LOG"
echo "resolved_mic name=\"$MIC_NAME\" uid=\"$MIC_UID\" ffmpeg_index=$MIC_INDEX"

# --- Start the 1Hz device poller ------------------------------------------
echo "starting device poller → $POLLER_LOG"
"$AUDIODEVS" --poll > "$POLLER_LOG" 2>&1 &
POLL_PID=$!

# --- Start systemtap ------------------------------------------------------
echo "starting systemtap → $TAP_PCM"
SYSTEMTAP_OUT="$TAP_PCM" "$SYSTEMTAP_BIN" 2> "$TAP_LOG" &
TAP_PID=$!

# --- Start mic capture at resolved name/index -----------------------------
echo "starting mic (ffmpeg avfoundation :$MIC_INDEX = \"$MIC_NAME\") → $MIC_WAV"
ffmpeg -hide_banner -nostats -y -f avfoundation -i ":$MIC_INDEX" -c:a pcm_f32le "$MIC_WAV" 2> "$MIC_LOG" &
MIC_PID=$!

# --- Cleanup / verify -----------------------------------------------------
CLEANED=0
cleanup() {
    if [ "$CLEANED" -eq 1 ]; then return; fi
    CLEANED=1
    trap - EXIT INT TERM
    echo ""
    echo "cleanup running (trap: ${1:-EXIT})"
    kill -INT "$TAP_PID" "$MIC_PID" "$POLL_PID" 2>/dev/null || true
    wait "$TAP_PID" 2>/dev/null || true
    wait "$MIC_PID" 2>/dev/null || true
    kill -TERM "$POLL_PID" 2>/dev/null || true
    wait "$POLL_PID" 2>/dev/null || true
    WALL_NS_END=$(python3 -c 'import time; print(int(time.time()*1e9))')

    {
        echo "wall_ns_end=$WALL_NS_END"
        echo ""
        echo "--- artifacts ---"
        ls -la "$TAP_PCM" "$MIC_WAV" 2>&1
        echo ""
        echo "--- tap log ---"
        cat "$TAP_LOG"
        echo ""

        # Parse tap format for the raw-PCM ffprobe invocation.
        TAP_RATE=$(sed -n 's/.*sample_rate=\([0-9]*\).*/\1/p' "$TAP_LOG" | head -1)
        TAP_CH=$(sed -n 's/.*channels=\([0-9]*\).*/\1/p' "$TAP_LOG" | head -1)
        TAP_RATE=${TAP_RATE:-48000}
        TAP_CH=${TAP_CH:-1}
        case "$TAP_CH" in
            1) TAP_LAYOUT=mono ;;
            2) TAP_LAYOUT=stereo ;;
            *) TAP_LAYOUT="${TAP_CH}c" ;;
        esac

        echo "--- ffprobe on tap ($TAP_RATE Hz / $TAP_CH ch f32le raw) ---"
        ffprobe -hide_banner -v error \
            -f f32le -ar "$TAP_RATE" -ch_layout "$TAP_LAYOUT" \
            -show_entries stream=codec_name,sample_rate,channels,bits_per_sample,duration \
            -show_entries format=duration,size,bit_rate \
            -of default=noprint_wrappers=0 \
            -i "$TAP_PCM"
        TAP_PROBE_STATUS=$?
        echo "ffprobe_tap_exit=$TAP_PROBE_STATUS"
        echo ""

        echo "--- ffprobe on mic (WAV, self-describing) ---"
        ffprobe -hide_banner -v error \
            -show_entries stream=codec_name,sample_rate,channels,bits_per_sample,duration \
            -show_entries format=duration,size,bit_rate \
            -of default=noprint_wrappers=0 \
            -i "$MIC_WAV"
        MIC_PROBE_STATUS=$?
        echo "ffprobe_mic_exit=$MIC_PROBE_STATUS"
        echo ""

        # Negotiated format ffmpeg opened the mic at (from its input header).
        echo "--- ffmpeg mic negotiated format ---"
        grep -E "(Stream #0|Input #|Guessed Channel|Duration:)" "$MIC_LOG" | head -20
        echo ""

        echo "--- mic log warnings/errors ---"
        grep -iE "(error|warn|deprecated|renegot|resample)" "$MIC_LOG" | head -20 || true
        echo ""

        echo "--- poller: first, last, and any CHANGE lines ---"
        head -1 "$POLLER_LOG"
        grep CHANGE "$POLLER_LOG" || echo "(no device changes observed)"
        tail -1 "$POLLER_LOG"
    } | tee "$CLEANUP_LOG"
}
trap 'cleanup EXIT' EXIT
trap 'cleanup INT; exit 130' INT
trap 'cleanup TERM; exit 143' TERM

wait
