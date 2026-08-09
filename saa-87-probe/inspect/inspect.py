#!/usr/bin/env python3
"""
Sample inspection for f32le captures. Numbers only, no thresholds, no verdicts.

Reports per fixed-length window and whole-file:
  - total_samples, duration_s
  - nonzero_count / nonzero_frac   (byte-equality vs 0x00000000)
  - min_abs_nonzero                (smallest nonzero magnitude, scientific,
                                    "none" if no sample has nonzero magnitude)
  - min, max                       (signed extremes, NaN excluded)
  - rms                            (NaN and inf excluded from the sum)
  - nan_count, inf_count
  - distinct_nonzero_patterns      (count of distinct raw 32-bit words != 0,
                                    capped at 256; prints ">256" when hit)

The fields that settle bitwise-zero vs a tiny signal are min_abs_nonzero
and distinct_nonzero_patterns. nonzero_count alone treats -0.0
(0x80000000; bytes 00 00 00 80 in f32le) as nonzero; distinct_nonzero_patterns
exposes whether "nonzero" is really -0.0 or denormals. The cap at 256 keeps
the tool from allocating millions of entries on a real signal.

sample_rate and channels are required. Pass them from the tap's own
`format sample_rate=... channels=...` stderr line for that run.

Usage:
  inspect.py <file.f32le> --sample-rate <hz> --channels <n> [--window-s <s>]
"""

import argparse
import math
import struct
import sys


DISTINCT_CAP = 256


def format_sci_or_none(x):
    if x is None:
        return "none"
    if x == 0.0:
        return "0"
    return f"{x:.6e}"


def format_fixed(x: float) -> str:
    if math.isnan(x):
        return "nan"
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    return f"{x:.9f}"


def analyse(samples_bytes: bytes) -> dict:
    n = len(samples_bytes) // 4
    if n == 0:
        return {
            "n": 0,
            "nonzero_count": 0,
            "min_abs_nonzero": None,
            "min": 0.0,
            "max": 0.0,
            "rms": 0.0,
            "nan_count": 0,
            "inf_count": 0,
            "distinct_nonzero_patterns": 0,
            "distinct_capped": False,
        }

    values = struct.unpack(f"<{n}f", samples_bytes)
    words = struct.unpack(f"<{n}I", samples_bytes)

    nonzero_count = 0
    distinct = set()
    distinct_capped = False
    min_abs_nonzero = math.inf
    smin = math.inf
    smax = -math.inf
    sum_sq = 0.0
    finite_count = 0
    nan_count = 0
    inf_count = 0

    for i in range(n):
        w = words[i]
        v = values[i]

        if w != 0:
            nonzero_count += 1
            if not distinct_capped:
                distinct.add(w)
                if len(distinct) > DISTINCT_CAP:
                    distinct_capped = True
                    distinct.clear()

        if math.isnan(v):
            nan_count += 1
            continue
        if math.isinf(v):
            inf_count += 1
            continue

        av = v if v >= 0.0 else -v
        if av > 0.0 and av < min_abs_nonzero:
            min_abs_nonzero = av
        if v < smin:
            smin = v
        if v > smax:
            smax = v
        sum_sq += v * v
        finite_count += 1

    rms = math.sqrt(sum_sq / finite_count) if finite_count > 0 else 0.0
    if finite_count == 0:
        smin = 0.0
        smax = 0.0

    return {
        "n": n,
        "nonzero_count": nonzero_count,
        "min_abs_nonzero": None if min_abs_nonzero is math.inf else min_abs_nonzero,
        "min": smin,
        "max": smax,
        "rms": rms,
        "nan_count": nan_count,
        "inf_count": inf_count,
        "distinct_nonzero_patterns": len(distinct),
        "distinct_capped": distinct_capped,
    }


def emit(label: str, extra_range: str, r: dict) -> None:
    nz_frac = (r["nonzero_count"] / r["n"]) if r["n"] else 0.0
    distinct_str = f">{DISTINCT_CAP}" if r["distinct_capped"] else str(r["distinct_nonzero_patterns"])
    print(f"{label}{extra_range}")
    print(f"  total_samples {r['n']}")
    print(f"  nonzero_count {r['nonzero_count']}   nonzero_frac {nz_frac:.6f}")
    print(f"  min_abs_nonzero {format_sci_or_none(r['min_abs_nonzero'])}")
    print(f"  min {format_fixed(r['min'])}   max {format_fixed(r['max'])}")
    print(f"  rms {format_fixed(r['rms'])}")
    print(f"  nan_count {r['nan_count']}   inf_count {r['inf_count']}")
    print(f"  distinct_nonzero_patterns {distinct_str}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Sample inspection for f32le captures.")
    ap.add_argument("path")
    ap.add_argument("--sample-rate", type=int, required=True,
                    help="Sample rate in Hz. Required. Take from the tap's format line.")
    ap.add_argument("--channels", type=int, required=True,
                    help="Channel count. Required. Take from the tap's format line.")
    ap.add_argument("--window-s", type=float, default=0.1,
                    help="Window length in seconds (default 0.1).")
    args = ap.parse_args()

    with open(args.path, "rb") as f:
        data = f.read()

    if len(data) % 4 != 0:
        print(f"error: file size {len(data)} is not a multiple of 4 (f32le)", file=sys.stderr)
        return 2

    total_samples = len(data) // 4
    total_frames = total_samples // args.channels if args.channels > 0 else 0
    duration_s = total_frames / args.sample_rate if args.sample_rate > 0 else 0.0

    print(f"file {args.path}")
    print(f"  sample_rate {args.sample_rate}   channels {args.channels}")
    print(f"  window_s {args.window_s}")
    print(f"  bytes {len(data)}   duration_s {duration_s:.6f}")
    print()

    whole = analyse(data)
    emit("whole_file", "", whole)
    print()

    frames_per_window = int(round(args.window_s * args.sample_rate))
    samples_per_window = frames_per_window * args.channels
    if samples_per_window <= 0:
        print("error: window resolves to zero samples", file=sys.stderr)
        return 2

    n_windows = (total_samples + samples_per_window - 1) // samples_per_window
    for w in range(n_windows):
        start = w * samples_per_window
        end = min(start + samples_per_window, total_samples)
        chunk = data[start * 4:end * 4]
        r = analyse(chunk)
        start_s = (start // args.channels) / args.sample_rate
        end_s = (end // args.channels) / args.sample_rate
        emit(f"window {w}", f" [{start_s:.3f} .. {end_s:.3f}]", r)

    return 0


if __name__ == "__main__":
    sys.exit(main())
