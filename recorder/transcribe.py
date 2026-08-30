#!/usr/bin/env python3
"""Merge one two-track capture (tap + mic) into a single transcript.

Usage:
    transcribe.py <tap.f32le.pcm> <mic.wav> <output.json>

Tap track: headerless PCM, 48 kHz mono f32le — the format systemtap writes
per Architecture Decision #9. This is convention, not metadata; a wrong
assumption decodes to plausible garbage with no error, so it is asserted
here rather than inferred.

Mic track: WAV. The fmt chunk is parsed directly.

Speaker labels are `me` (mic) and `them` (tap), derived purely from which
file the audio came from. Two labels, no others (Decision #5 is deferred).

16 kHz s16 mono copies for Whisper are written alongside the source files
with a `.16k.wav` name; the native-rate originals are neither modified nor
moved. Both stay outside the repo per Decision #11's 2026-08-07 amendment.

Clamp to [-1.0, 1.0] on the float→s16 hop is provided by ffmpeg's
swresample: values above 1.0 map to +32767, below -1.0 map to -32768.
Verified on this ffmpeg build (+1.01/+1.5/+2.0 all → 32767; symmetric
for negatives). No compressor is inserted in the pipeline — a dynamics
filter would alter the RMS/peak numbers the sample-content check reports.

Voice activity detection gates the audio before Whisper sees it (SAA-91).
Without it Whisper emits words over silence — filler aligned to its 30-second
processing window, indistinguishable in the output from real backchannel, and
worst on whichever track carries the most silence. That is the far side of
every 1:1 measured. Gating removes the silence rather than filtering the text
afterwards, because the discriminator is the audio under a segment and not the
segment's wording.

Segment ends are measured from the audio, not taken from whisper (SAA-147).
Whisper reports a start it measured and often no real ending, in which case
`offsets.to` is the moment the next speech begins — 98.1% of consecutive pairs
on 2026-08-25T17-30-09Z, where a four-second sentence records as 598.83 s.
Gating made this worse rather than causing it: ungated, the error could not
exceed whisper's own 30-second window, and skipping silence removed that cap.
See measure_segment_ends.

Environment:
    WHISPER_MODEL       Path to a whisper.cpp GGML model. Default:
                        ~/Library/Application Support/whisper.cpp/models/ggml-small.en.bin
    WHISPER_CLI         whisper-cli binary. Default: whisper-cli on PATH.
    WHISPER_VAD_MODEL   Path to the Silero VAD model. Default alongside the
                        transcription model as ggml-silero-v5.1.2.bin.
    CLIPWISE_ALLOW_NO_VAD=1
                        Transcribe without gating when the VAD model is
                        missing. Off by default and deliberately awkward — see
                        the note on run_whisper.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
import sys
from array import array
from operator import mul
from pathlib import Path

TAP_RATE = 48000
TAP_CH = 1
TAP_SAMPLE_BYTES = 4  # f32le

TARGET_RATE = 16000

# Window for the per-track content series. One second is fine enough to place a
# gap and coarse enough that an hour is ~3600 values per track rather than a
# second transcript-sized payload.
WINDOW_S = 1.0

DEFAULT_MODEL = str(
    Path.home()
    / "Library/Application Support/whisper.cpp/models/ggml-small.en.bin"
)

DEFAULT_VAD_MODEL = str(
    Path.home()
    / "Library/Application Support/whisper.cpp/models/ggml-silero-v5.1.2.bin"
)

VAD_MODEL_URL = (
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
)

# whisper.cpp VAD defaults, named here so the transcript can record what
# produced it and so changing one is a visible edit rather than a flag buried
# in an argv list. Left at the shipped defaults: the 30 ms speech padding is
# what keeps a gated onset from clipping the first phoneme, and nothing in the
# corpus measurement suggested a different threshold.
VAD_THRESHOLD = "0.50"
VAD_MIN_SPEECH_MS = "250"
VAD_MIN_SILENCE_MS = "100"
VAD_SPEECH_PAD_MS = "30"

# Segment-end measurement (SAA-147). Whisper reports a start it measured and
# often no real ending; `offsets.to` is then the moment the NEXT speech begins.
# These values are the ones that survived a grid search against ground truth —
# see measure_segment_ends for how that truth was established and what each
# rejected value did.
SEGMENT_END_FRAME_MS = 20
# The end is where the level drops this far below the loudest speech in the
# segment. Relative, not absolute: the mic noise floor on this corpus runs as
# high as -33 dBFS against speech at -10, and a fixed threshold that separates
# them on one capture marks 93% of another as speech.
SEGMENT_END_DROP_DB = 25.0
# A silence shorter than this is a pause inside the utterance, not its end.
# Bounded from both sides by measurement, and centred between them:
#
#   above  the longest real intra-utterance pause seen, 1.60 s, in "So this is
#          what I, I just want to show you really quick." At 1500 ms that
#          segment ends at the pause and loses two thirds of its words — the
#          failure the dense-capture half of SAA-147's verification exists to
#          catch, since it passes the sparse half looking correct.
#   below  the shortest silence seen between a real ending and the next sound
#          on the track, 2.86 s, after "I got some funny stories...". At
#          3000 ms that segment runs on to far-side voice leaking into the mic
#          and reports 8.08 s instead of 1.80 s; at 4000 ms, 493.78 s.
#
# Erring high costs span accuracy, erring low costs words, and words are not
# recoverable — but the window either side of this value is under a second, so
# a capture with slower speech or a closer-following speaker could land outside
# it. The two numbers above are what to re-measure if that shows up.
SEGMENT_END_HANG_MS = 2200
# Trailing room for a final consonant the level test cuts fine.
SEGMENT_END_PAD_MS = 80
# The speech reference is seeded from the opening of the segment, where SAA-91
# established the start is a real measured onset, then raised as louder speech
# appears. Seeding from the whole window instead lets a later burst of
# cross-talk set the reference and silence the real speech under it.
SEGMENT_END_LEAD_MS = 500
# How far above the track's own noise floor the drop threshold is allowed to
# sink (SAA-149). `peak - SEGMENT_END_DROP_DB` is relative to the speech in the
# segment, and on a quiet onset it lands *under* the room tone: every frame
# then counts as speech, no silence run can begin, and the hang is never
# reached — 73.11 s recorded for a 0.39 s utterance. Clamping the threshold to
# `floor + this` puts a bound under the relative rule.
#
# Bounded from both sides by measurement over 2201 segments on two captures,
# scoring each end against the speech-stop measured independently at -35 dBFS,
# and centred between them:
#
#   below  18 dB. Ends still run past the speech-stop: eight of SAA-149's nine
#          long spans land, the ninth is +1.24 s out, and at 15 dB one segment
#          is cut 4.94 s short.
#   above  20 dB. The threshold reaches into speech: 11 segments end early,
#          worst 1.56 s, rising to 31 at 21 dB. Erring high costs span
#          accuracy, erring low costs words, and words are not recoverable.
#
# At 19 all nine land at exactly +0.08 s — one SEGMENT_END_PAD_MS past the
# measured speech-stop — and nothing on either capture is cut. The window
# either side is 1 dB, narrower than the hang's, so these are the two numbers
# to re-measure on a microphone whose room tone sits closer to its speech.
SEGMENT_END_FLOOR_MARGIN_DB = 19.0
# Frame level assigned to digital silence, so log(0) never arises.
SEGMENT_END_FLOOR_DB = -90.0


def die(msg: str) -> None:
    sys.stderr.write(f"transcribe: {msg}\n")
    sys.exit(1)


def sixteenk_path(src: Path) -> Path:
    """Return a sibling path named `<base>.16k.wav`.

    Strips a `.f32le.pcm` / `.pcm` / `.wav` suffix so the resulting name
    reads as a 16 kHz WAV, not e.g. `...f32le.16k.wav`.
    """
    name = src.name
    for suf in (".f32le.pcm", ".f32le.wav", ".pcm", ".wav"):
        if name.endswith(suf):
            base = name[: -len(suf)]
            break
    else:
        base = src.stem
    return src.with_name(f"{base}.16k.wav")


def parse_mic_wav_fmt(path: Path) -> dict:
    """Read the fmt chunk directly.

    Does not trust RIFF/data chunk sizes — ffmpeg's trailer is not written
    on SIGINT, which leaves both as 0xFFFFFFFF. Data length is derived
    from the on-disk file size instead.
    """
    with open(path, "rb") as f:
        riff = f.read(12)
        if riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            die(f"{path}: not a RIFF/WAVE file")

        fmt = None
        data_offset = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            tag = hdr[:4]
            size = struct.unpack("<I", hdr[4:8])[0]
            if tag == b"fmt ":
                fmt = f.read(size)
            elif tag == b"data":
                data_offset = f.tell()
                break
            else:
                f.seek(size, 1)
            if size % 2:
                f.seek(1, 1)

    if fmt is None or data_offset is None:
        die(f"{path}: missing fmt or data chunk")

    (fmt_tag, ch, rate, _byte_rate, block_align, bits) = struct.unpack(
        "<HHIIHH", fmt[:16]
    )
    file_size = path.stat().st_size
    data_bytes = file_size - data_offset
    frames = data_bytes // block_align if block_align else 0

    return {
        "format_tag": fmt_tag,
        "channels": ch,
        "rate": rate,
        "bits": bits,
        "block_align": block_align,
        "data_bytes": data_bytes,
        "frames": frames,
        "duration_s": frames / rate if rate else 0.0,
    }


def ffmpeg_downsample_pcm(src: Path, dst: Path) -> None:
    """Tap: raw f32le 48k mono → 16 kHz s16 mono WAV.

    Float samples outside [-1.0, 1.0] are clipped by swresample on the
    s16 conversion (documented, verified empirically on this build).
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "f32le", "-ar", str(TAP_RATE), "-ac", str(TAP_CH),
        "-i", str(src),
        "-ar", str(TARGET_RATE), "-ac", "1",
        "-sample_fmt", "s16", "-c:a", "pcm_s16le", "-f", "wav",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def ffmpeg_downsample_wav(src: Path, dst: Path) -> None:
    """Mic: WAV → 16 kHz s16 mono WAV. Same clip guarantee as above."""
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-ar", str(TARGET_RATE), "-ac", "1",
        "-sample_fmt", "s16", "-c:a", "pcm_s16le", "-f", "wav",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def read_s16_mono(wav_path: Path) -> tuple[array, int]:
    """Return (samples, rate) for a 16-bit mono WAV.

    Split out of sample_content_check so the sample pass is paid once: the
    content statistics and the segment-end frame levels (SAA-147) both read
    the same 16k copy, and on a 40-minute capture that file is ~70 MB.
    """
    with open(wav_path, "rb") as f:
        riff = f.read(12)
        if riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            die(f"{wav_path}: not RIFF/WAVE after conversion")
        block_align = None
        bits = None
        rate = None
        data = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            tag = hdr[:4]
            size = struct.unpack("<I", hdr[4:8])[0]
            if tag == b"fmt ":
                fmt = f.read(size)
                _tag, _ch, rate, _br, block_align, bits = struct.unpack(
                    "<HHIIHH", fmt[:16]
                )
            elif tag == b"data":
                data = f.read(size)
                break
            else:
                f.seek(size, 1)
            if size % 2:
                f.seek(1, 1)
    if data is None or bits != 16 or block_align != 2:
        die(f"{wav_path}: expected s16 mono, got bits={bits} block={block_align}")

    samples = array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, rate


def sample_content_check(samples: array, rate: int) -> dict:
    """Report nonzero fraction, RMS, peak of the samples read above.

    Reads samples directly; ffmpeg's clean exit does not prove the file
    survived the downsample.
    """
    n = len(samples)

    # Windowed as well as whole-file. A whole-file average cannot locate a
    # transient gap — a track that carried speech and then dropped to the noise
    # floor for thirty seconds still averages as live. The series is what makes
    # the gap a span rather than a suspicion. Whole-file figures are aggregated
    # from the windows rather than computed separately, so this stays one pass:
    # max of maxima is the maximum, sums of sums are the sum.
    win = int(rate * WINDOW_S) if rate else n
    if win < 1:
        win = n or 1
    nonzero = 0
    peak = 0
    sq = 0
    w_rms: list[float] = []
    w_peak: list[float] = []
    for i in range(0, n, win):
        chunk = samples[i : i + win]
        m = len(chunk)
        if m == 0:
            break
        c_nonzero = sum(1 for s in chunk if s != 0)
        c_peak = max((abs(s) for s in chunk), default=0)
        c_sq = sum(s * s for s in chunk)
        nonzero += c_nonzero
        if c_peak > peak:
            peak = c_peak
        sq += c_sq
        w_rms.append(round(((c_sq / m) ** 0.5) / 32768.0, 6))
        w_peak.append(round(c_peak / 32768.0, 6))

    rms_i16 = (sq / n) ** 0.5 if n else 0.0
    rms_frac = rms_i16 / 32768.0
    peak_frac = peak / 32768.0

    return {
        "samples": n,
        "duration_s": n / rate if rate else 0.0,
        "nonzero_fraction": nonzero / n if n else 0.0,
        "rms": rms_frac,
        "peak": peak_frac,
        "window_s": WINDOW_S,
        "windows_rms": w_rms,
        "windows_peak": w_peak,
    }


def frame_levels_db(samples: array, rate: int, frame_ms: int) -> list[float]:
    """Per-frame RMS in dBFS.

    Same measurement as `windows_rms` in the content block, at 20 ms instead
    of one second. The content series stays at one second — it is what SAA-89's
    classifier reads, and an hour at 20 ms is 180k values per track, which
    would be several times the size of the transcript it rides on. This series
    is derived, used, and dropped.
    """
    n = int(rate * frame_ms / 1000)
    out: list[float] = []
    for i in range(0, len(samples), n):
        chunk = samples[i : i + n]
        m = len(chunk)
        if m == 0:
            break
        rms = ((sum(map(mul, chunk, chunk)) / m) ** 0.5) / 32768.0
        out.append(
            SEGMENT_END_FLOOR_DB
            if rms <= 0
            else max(SEGMENT_END_FLOOR_DB, 20 * math.log10(rms))
        )
    return out


def track_noise_floor(levels: list[float]) -> float:
    """The modal 20 ms level of a track's room tone, in dBFS.

    A percentile cannot do this job. The fraction of a call spent speaking
    swings from 18% to 46% across the two captures SAA-149 was measured on,
    so any fixed quantile slides between room tone and speech with it — the
    same defect SAA-137 records in `floorRms`, where a threshold derived from
    the track's own content tracks how much the person talked. The level
    histogram is bimodal on every track measured here (room tone at -63 and
    -54 dBFS on the two microphones, -85 and -87 on the two taps), and the
    position of the quiet mode does not move with how often the loud one is
    occupied.

    The search is restricted to frames at or below the median so a track that
    is mostly speech cannot return the speech mode. Digital silence is
    excluded: it is the absence of a signal, not the level of one, and on a
    tap track it is 20% of frames and would drag the estimate to the sentinel.
    """
    room = [v for v in levels if v > SEGMENT_END_FLOOR_DB]
    if not room:
        return SEGMENT_END_FLOOR_DB
    ordered = sorted(room)
    mid = len(ordered) // 2
    median = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2
    hist: dict[int, int] = {}
    for v in room:
        if v <= median:
            b = int(round(v))
            hist[b] = hist.get(b, 0) + 1
    if not hist:
        return SEGMENT_END_FLOOR_DB
    # Ties to the quieter bin: a floor estimated low leaves the relative rule
    # in charge, which is the behaviour that shipped.
    return float(max(hist.items(), key=lambda kv: (kv[1], -kv[0]))[0])


def measure_segment_ends(segs: list[dict], levels: list[float]) -> int:
    """Replace each segment's end with the point where its speech stops.

    Whisper gives a real start and, often, no real ending — `offsets.to` is
    then the moment the next speech begins (SAA-147). Ungated that error was
    capped at whisper's own 30-second window; SAA-91's VAD gating removed the
    cap, because the next speech region can be arbitrarily far away. On
    2026-08-25T17-30-09Z a four-second sentence is recorded as 598.83 s.

    The end is measured from the audio rather than estimated from the text,
    and the search window is [start, reported_end]. That window is the whole
    reason this is tractable: whatever else it contains, it does not contain
    the next utterance, because the reported end is where that utterance
    begins. So the only thing to find inside it is where this speech stopped.

    Scan forward from the start, tracking the loudest speech seen. Speech has
    stopped at the last frame above (loudest - SEGMENT_END_DROP_DB) before
    either a silence of SEGMENT_END_HANG_MS or the end of the window. Ends
    only ever move earlier, never later: `offsets.to` is either the true end
    or the next start, and is never before the true end, so it is a ceiling.

    Two rejected alternatives, both measured on this corpus:

      * Last frame above the threshold anywhere in the window. Correct on
        every dense segment and catastrophic on the sparse ones — the 598 s
        segment carries far-side voice leaking into the mic at -22 dBFS, well
        above threshold, and the "end" lands 597 s late.
      * Duration of the segment in whisper's VAD-compressed timeline, taken
        from `-ojf` token offsets. Tighter on average (median +0.21 s) but
        wrong in the unsafe direction: a segment holding an internal pause has
        that pause removed from the compressed stream, so the end lands before
        the real one and words are cut. One of 22 sampled segments lost its
        last two words.

    Returns the number of segments whose end moved. Mutates `segs`, keeping
    the original value as `end_ms_reported` so the change stays auditable.
    """
    fm = SEGMENT_END_FRAME_MS
    hang = max(1, SEGMENT_END_HANG_MS // fm)
    lead = max(1, SEGMENT_END_LEAD_MS // fm)
    threshold_floor = track_noise_floor(levels) + SEGMENT_END_FLOOR_MARGIN_DB
    moved = 0
    for s in segs:
        start_ms, rep_end_ms = s["start_ms"], s["end_ms"]
        i0 = start_ms // fm
        i1 = min(len(levels), -(-rep_end_ms // fm))
        s["end_ms_reported"] = rep_end_ms
        if i1 <= i0:
            continue
        peak = max(levels[i0 : min(i0 + lead, i1)])
        run = 0
        last = i0
        started = False
        for i in range(i0, i1):
            if levels[i] > peak:
                peak = levels[i]
            if levels[i] >= max(peak - SEGMENT_END_DROP_DB, threshold_floor):
                started = True
                run = 0
                last = i
            elif started:
                # Silence only counts once speech has been found. Without this
                # the clamp is destructive on the case it was built to fix: a
                # segment that opens with more silence than the hang has its
                # run complete before `last` ever advances, and the whole
                # utterance collapses to start + one frame + the pad. Two
                # segments across the two captures open that way, by 11.72 s
                # and 2.84 s, and the first is the 13.83 s span that is the
                # longest on the capture SAA-149 records as already correct —
                # it would have been cut to 0.10 s. Seeding `peak` low masked
                # this, because a threshold under the room tone can never
                # accumulate silence — the same accident that produced the
                # 73-second span.
                run += 1
                if run >= hang:
                    break
        if not started:
            # Nothing in the window rose above the floor, so this segment has
            # no measurable speech to end. Keep whisper's value rather than
            # invent one: it is what the scan already returned here by running
            # to the window end, and a floor estimated too high must not be
            # able to erase an utterance.
            continue
        end_ms = min(rep_end_ms, (last + 1) * fm + SEGMENT_END_PAD_MS)
        if end_ms != rep_end_ms:
            s["end_ms"] = end_ms
            moved += 1
    return moved


def run_whisper(
    wav_path: Path,
    model_path: Path,
    whisper_cli: str,
    vad_model: Path | None,
) -> list[dict]:
    """Invoke whisper-cli with -oj; parse the resulting JSON.

    Uses whisper.cpp's `offsets.to` verbatim as the segment end. In this
    build, `offsets.to` for segment i equals `offsets.from` for segment
    i+1 on every adjacent pair observed so far — meaning "real end" and
    "next start" are indistinguishable at the JSON level. Recorded in
    the verification output; not worked around here.

    With `vad_model`, Silero gates the audio before Whisper decodes it. The
    offsets that come back are positions in the ORIGINAL audio, not in the
    silence-removed stream — measured 2026-08-22 on a 2468.9 s track that is
    80% silence, where the gated run's last segment ends at 2462.4 s. Had it
    been reporting compressed-stream positions the track would have ended near
    490 s. This is the property the two-track merge depends on: `me` and `them`
    are transcribed independently and interleaved on a shared timeline with no
    offset applied, so a compressed clock on one track would silently reorder
    the conversation.
    """
    # whisper-cli appends ".json" to the -of value verbatim. Build the
    # prefix by trimming the trailing ".wav" so the output is <name>.json,
    # not <name>.wav.json. Path.with_suffix treats a preceding ".16k" as
    # its own extension and would drop it — avoid that by string ops.
    prefix_str = str(wav_path)
    if prefix_str.endswith(".wav"):
        prefix_str = prefix_str[:-4]
    cmd = [
        whisper_cli,
        "-m", str(model_path),
        "-f", str(wav_path),
        "-oj",
        "-of", prefix_str,
    ]
    if vad_model is not None:
        cmd += [
            "--vad",
            "-vm", str(vad_model),
            "-vt", VAD_THRESHOLD,
            "-vspd", VAD_MIN_SPEECH_MS,
            "-vsd", VAD_MIN_SILENCE_MS,
            "-vp", VAD_SPEECH_PAD_MS,
        ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=sys.stderr)
    json_path = Path(prefix_str + ".json")
    if not json_path.exists():
        die(f"whisper: expected {json_path} not written")
    data = json.loads(json_path.read_text())
    segs = data.get("transcription", [])
    return [
        {
            "start_ms": int(s["offsets"]["from"]),
            "end_ms": int(s["offsets"]["to"]),
            "text": s["text"],
        }
        for s in segs
    ]


def main() -> int:
    if len(sys.argv) != 4:
        die("usage: transcribe.py <tap.f32le.pcm> <mic.wav> <output.json>")

    tap_src = Path(sys.argv[1]).resolve()
    mic_src = Path(sys.argv[2]).resolve()
    out_path = Path(sys.argv[3]).resolve()

    for p in (tap_src, mic_src):
        if not p.is_file():
            die(f"input not found: {p}")

    model_path = Path(os.environ.get("WHISPER_MODEL", DEFAULT_MODEL))
    if not model_path.is_file():
        die(
            f"whisper model not found at {model_path}. "
            "Set WHISPER_MODEL, or download with:\n"
            "  mkdir -p \"$HOME/Library/Application Support/whisper.cpp/models\"\n"
            "  curl -L --fail -o \"$HOME/Library/Application Support/whisper.cpp/models/ggml-small.en.bin\" \\\n"
            "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
        )
    whisper_cli = os.environ.get("WHISPER_CLI", "whisper-cli")
    if not shutil.which(whisper_cli):
        die(
            f"whisper-cli not found on PATH (WHISPER_CLI={whisper_cli}). "
            "Install: brew install whisper-cpp"
        )

    # Checked here, before any audio is touched, because `--vad` with an
    # unreadable model does not return an error: whisper.cpp attempts to load
    # from the empty path and dies on a Metal assertion during teardown,
    # SIGABRT / exit 134. Nothing downstream can catch that or report what
    # went wrong, and the recovery loop (SAA-136) would spend all three of a
    # capture's attempts on it and then abandon the recording.
    #
    # Refusing outright rather than quietly transcribing without gating, which
    # is the tempting fallback and the wrong one. A capture that fails here
    # keeps its audio and is re-transcribed the moment the model is present —
    # the recovery loop re-runs the transcribe stage, demonstrated 2026-08-22.
    # A capture that silently skips gating gets a transcript that is up to 40%
    # text over silence, is ingested, is extracted, and reaches the terminal
    # status — after which nothing revisits it, because the loop will not
    # re-run a recording that reads ready. The recoverable failure is the safer
    # one, so it is the default.
    vad_model_path = Path(os.environ.get("WHISPER_VAD_MODEL", DEFAULT_VAD_MODEL))
    allow_no_vad = os.environ.get("CLIPWISE_ALLOW_NO_VAD") == "1"
    vad_model = vad_model_path
    if not vad_model_path.is_file():
        if not allow_no_vad:
            die(
                f"VAD model not found at {vad_model_path}.\n"
                "  Whisper emits words over silence without it (SAA-91), so this refuses\n"
                "  rather than produce a transcript that looks fine and is partly invented.\n"
                "  The capture's audio is kept and re-transcribes cleanly once this exists.\n"
                "  Download with:\n"
                f'    curl -L --fail -o "{vad_model_path}" \\\n'
                f"      {VAD_MODEL_URL}\n"
                "  Or set WHISPER_VAD_MODEL, or CLIPWISE_ALLOW_NO_VAD=1 to accept ungated output."
            )
        sys.stderr.write(
            "transcribe: WARNING - CLIPWISE_ALLOW_NO_VAD=1 and no VAD model; "
            "transcribing ungated. Expect phantom speech over silence (SAA-91).\n"
        )
        vad_model = None

    print(f"tap  src: {tap_src}")
    print(f"mic  src: {mic_src}")
    print(f"model:    {model_path}")
    print(f"whisper:  {shutil.which(whisper_cli)}")
    print(f"vad:      {vad_model if vad_model else 'DISABLED (CLIPWISE_ALLOW_NO_VAD=1)'}")

    tap_bytes = tap_src.stat().st_size
    tap_frames = tap_bytes // (TAP_SAMPLE_BYTES * TAP_CH)
    tap_dur = tap_frames / TAP_RATE
    print(
        f"tap  format (asserted, per Decision #9): "
        f"f32le {TAP_RATE} Hz {TAP_CH} ch — {tap_bytes} bytes, "
        f"{tap_frames} frames, {tap_dur:.3f} s"
    )

    mic_fmt = parse_mic_wav_fmt(mic_src)
    print(
        f"mic  format (from fmt chunk): "
        f"tag=0x{mic_fmt['format_tag']:04x} "
        f"{mic_fmt['rate']} Hz {mic_fmt['channels']} ch "
        f"bits={mic_fmt['bits']} — {mic_fmt['data_bytes']} data bytes, "
        f"{mic_fmt['frames']} frames, {mic_fmt['duration_s']:.3f} s"
    )
    if mic_fmt["format_tag"] != 0x0003 or mic_fmt["bits"] != 32:
        die(
            f"mic: expected IEEE_FLOAT/32-bit; got "
            f"tag=0x{mic_fmt['format_tag']:04x}, bits={mic_fmt['bits']}"
        )

    tap_16k = sixteenk_path(tap_src)
    mic_16k = sixteenk_path(mic_src)
    print(f"downsampling tap → {tap_16k}")
    ffmpeg_downsample_pcm(tap_src, tap_16k)
    print(f"downsampling mic → {mic_16k}")
    ffmpeg_downsample_wav(mic_src, mic_16k)

    tap_samples, tap_rate = read_s16_mono(tap_16k)
    mic_samples, mic_rate = read_s16_mono(mic_16k)
    tap_stats = sample_content_check(tap_samples, tap_rate)
    mic_stats = sample_content_check(mic_samples, mic_rate)
    tap_levels = frame_levels_db(tap_samples, tap_rate, SEGMENT_END_FRAME_MS)
    mic_levels = frame_levels_db(mic_samples, mic_rate, SEGMENT_END_FRAME_MS)
    print(
        f"tap  16k content: samples={tap_stats['samples']} "
        f"duration={tap_stats['duration_s']:.3f}s "
        f"nonzero_fraction={tap_stats['nonzero_fraction']:.6f} "
        f"rms={tap_stats['rms']:.6f} peak={tap_stats['peak']:.6f}"
    )
    print(
        f"mic  16k content: samples={mic_stats['samples']} "
        f"duration={mic_stats['duration_s']:.3f}s "
        f"nonzero_fraction={mic_stats['nonzero_fraction']:.6f} "
        f"rms={mic_stats['rms']:.6f} peak={mic_stats['peak']:.6f}"
    )

    print("transcribing tap track ...")
    tap_segs = run_whisper(tap_16k, model_path, whisper_cli, vad_model)
    print(f"tap segments: {len(tap_segs)}")

    print("transcribing mic track ...")
    mic_segs = run_whisper(mic_16k, model_path, whisper_cli, vad_model)
    print(f"mic segments: {len(mic_segs)}")

    # Before the merge, so both tracks are on measured ends by the time they
    # share a timeline, and before anything is written, so the database and
    # the moments extracted from it inherit the corrected value rather than
    # needing a backfill (SAA-147).
    tap_moved = measure_segment_ends(tap_segs, tap_levels)
    mic_moved = measure_segment_ends(mic_segs, mic_levels)
    print(f"tap segment ends measured from audio: {tap_moved}/{len(tap_segs)} moved")
    print(f"mic segment ends measured from audio: {mic_moved}/{len(mic_segs)} moved")

    merged = []
    for s in tap_segs:
        merged.append({
            "track": "them",
            "start_ms": s["start_ms"],
            "end_ms": s["end_ms"],
            # Whisper's own value, kept so the correction is auditable and so
            # a consumer can tell a measured end from an unmeasured one.
            "end_ms_reported": s["end_ms_reported"],
            "text": s["text"],
        })
    for s in mic_segs:
        merged.append({
            "track": "me",
            "start_ms": s["start_ms"],
            "end_ms": s["end_ms"],
            "end_ms_reported": s["end_ms_reported"],
            "text": s["text"],
        })
    merged.sort(key=lambda x: (x["start_ms"], x["track"]))

    labels = sorted({m["track"] for m in merged})
    print(f"merged segments: {len(merged)}  distinct labels: {labels}")

    def first_last(segs: list[dict]):
        if not segs:
            return None, None
        return (
            (segs[0]["start_ms"], segs[0]["end_ms"]),
            (segs[-1]["start_ms"], segs[-1]["end_ms"]),
        )

    tap_first, tap_last = first_last(tap_segs)
    mic_first, mic_last = first_last(mic_segs)
    print(f"tap first: {tap_first}  tap last: {tap_last}")
    print(f"mic first: {mic_first}  mic last: {mic_last}")

    def adjacency(segs: list[dict], key: str):
        """Count pairs where one segment's end is the next one's start.

        Reported against both the measured end and whisper's raw value: the
        raw count is the defect SAA-147 records (98.1% on the worked example),
        and the measured count is what is left after it. It does not go to
        zero and should not — where one utterance runs into the next with no
        silence between them, the end IS the next start, and that is the
        correct value rather than the bug.
        """
        m = d = 0
        samples = []
        for i in range(len(segs) - 1):
            a = segs[i][key]
            b = segs[i + 1]["start_ms"]
            if a == b:
                m += 1
            else:
                d += 1
                if len(samples) < 3:
                    samples.append((i, a, b))
        return m, d, samples

    for name, segs in (("tap", tap_segs), ("mic", mic_segs)):
        raw_match, _, _ = adjacency(segs, "end_ms_reported")
        match, diff, samp = adjacency(segs, "end_ms")
        pairs = max(1, len(segs) - 1)
        print(
            f"{name} adjacency: {match} pairs match, {diff} differ "
            f"(whisper's raw ends: {raw_match}/{pairs}). sample diffs: {samp}"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "inputs": {"tap": str(tap_src), "mic": str(mic_src)},
        "downsampled": {"tap_16k": str(tap_16k), "mic_16k": str(mic_16k)},
        "model": str(model_path),
        # How the audio was gated, so a transcript carries the reason it looks
        # the way it does. A file written before SAA-91 has no `vad` key at
        # all, which is how an ungated one is told apart from a gated one.
        "vad": (
            {
                "model": str(vad_model),
                "threshold": float(VAD_THRESHOLD),
                "min_speech_ms": int(VAD_MIN_SPEECH_MS),
                "min_silence_ms": int(VAD_MIN_SILENCE_MS),
                "speech_pad_ms": int(VAD_SPEECH_PAD_MS),
            }
            if vad_model is not None
            else None
        ),
        # How segment ends were arrived at, on the same principle as `vad`
        # above: a file says how it was made. A transcript written before
        # SAA-147 has no `segment_end` key, and its `end_ms` values are
        # whisper's `offsets.to` verbatim — which is the next speaker's start
        # time wherever the utterance had no measured ending.
        "segment_end": {
            "method": "audio_level_decay",
            "frame_ms": SEGMENT_END_FRAME_MS,
            "drop_db": SEGMENT_END_DROP_DB,
            "hang_ms": SEGMENT_END_HANG_MS,
            "pad_ms": SEGMENT_END_PAD_MS,
            "lead_ms": SEGMENT_END_LEAD_MS,
            "floor_margin_db": SEGMENT_END_FLOOR_MARGIN_DB,
            "floor_db": {
                "tap": track_noise_floor(tap_levels),
                "mic": track_noise_floor(mic_levels),
            },
        },
        "labels": labels,
        # Per-track sample statistics, measured above on the 16k copies that
        # Whisper actually reads. Persisted rather than only printed because
        # consumers cannot recompute them once the downsampled files are gone,
        # and because silence classification (SAA-89) is going to be built on
        # exactly these numbers. Nothing here interprets them — peak == 0 on
        # the tap is the ordinary case when no system audio was playing.
        "content": {"tap": tap_stats, "mic": mic_stats},
        "segments": merged,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote merged transcript → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
