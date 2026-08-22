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
import os
import shutil
import struct
import subprocess
import sys
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


def sample_content_check(wav_path: Path) -> dict:
    """Report nonzero fraction, RMS, peak of a 16-bit mono WAV.

    Reads samples directly; ffmpeg's clean exit does not prove the file
    survived the downsample.
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

    n = len(data) // 2
    samples = struct.unpack("<" + "h" * n, data)

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

    tap_stats = sample_content_check(tap_16k)
    mic_stats = sample_content_check(mic_16k)
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

    merged = []
    for s in tap_segs:
        merged.append({
            "track": "them",
            "start_ms": s["start_ms"],
            "end_ms": s["end_ms"],
            "text": s["text"],
        })
    for s in mic_segs:
        merged.append({
            "track": "me",
            "start_ms": s["start_ms"],
            "end_ms": s["end_ms"],
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

    def adjacency(segs: list[dict]):
        m = d = 0
        samples = []
        for i in range(len(segs) - 1):
            a = segs[i]["end_ms"]
            b = segs[i + 1]["start_ms"]
            if a == b:
                m += 1
            else:
                d += 1
                if len(samples) < 3:
                    samples.append((i, a, b))
        return m, d, samples

    tap_match, tap_diff, tap_samp = adjacency(tap_segs)
    mic_match, mic_diff, mic_samp = adjacency(mic_segs)
    print(f"tap adjacency: {tap_match} pairs match, {tap_diff} differ. sample diffs: {tap_samp}")
    print(f"mic adjacency: {mic_match} pairs match, {mic_diff} differ. sample diffs: {mic_samp}")

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
