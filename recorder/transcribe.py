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

Environment:
    WHISPER_MODEL   Path to a whisper.cpp GGML model. Default:
                    ~/Library/Application Support/whisper.cpp/models/ggml-small.en.bin
    WHISPER_CLI     whisper-cli binary. Default: whisper-cli on PATH.
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

DEFAULT_MODEL = str(
    Path.home()
    / "Library/Application Support/whisper.cpp/models/ggml-small.en.bin"
)


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
    nonzero = sum(1 for s in samples if s != 0)
    peak = max((abs(s) for s in samples), default=0)
    sq = sum(s * s for s in samples)
    rms_i16 = (sq / n) ** 0.5 if n else 0.0
    rms_frac = rms_i16 / 32768.0
    peak_frac = peak / 32768.0

    return {
        "samples": n,
        "duration_s": n / rate if rate else 0.0,
        "nonzero_fraction": nonzero / n if n else 0.0,
        "rms": rms_frac,
        "peak": peak_frac,
    }


def run_whisper(wav_path: Path, model_path: Path, whisper_cli: str) -> list[dict]:
    """Invoke whisper-cli with -oj; parse the resulting JSON.

    Uses whisper.cpp's `offsets.to` verbatim as the segment end. In this
    build, `offsets.to` for segment i equals `offsets.from` for segment
    i+1 on every adjacent pair observed so far — meaning "real end" and
    "next start" are indistinguishable at the JSON level. Recorded in
    the verification output; not worked around here.
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

    print(f"tap  src: {tap_src}")
    print(f"mic  src: {mic_src}")
    print(f"model:    {model_path}")
    print(f"whisper:  {shutil.which(whisper_cli)}")

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
    tap_segs = run_whisper(tap_16k, model_path, whisper_cli)
    print(f"tap segments: {len(tap_segs)}")

    print("transcribing mic track ...")
    mic_segs = run_whisper(mic_16k, model_path, whisper_cli)
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

    if tap_segs:
        print("--- verbatim tap transcript (pink noise, expected: nothing) ---")
        for s in tap_segs:
            print(f"  [{s['start_ms']:>7} → {s['end_ms']:>7}] {s['text']!r}")
        print("--- end tap transcript ---")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "inputs": {"tap": str(tap_src), "mic": str(mic_src)},
        "downsampled": {"tap_16k": str(tap_16k), "mic_16k": str(mic_16k)},
        "model": str(model_path),
        "labels": labels,
        "segments": merged,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote merged transcript → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
