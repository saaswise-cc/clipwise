#!/usr/bin/env python3
"""Acceptance test for the microphone capture path (SAA-106).

Records one capture from the built-in microphone while the built-in speakers
play recorded speech and a human operator reads a phrase aloud, then asserts
three conditions:

  1. Samples written match elapsed wall time to within 0.1%.
  2. The two tracks do not carry the same words — no shared multi-word phrase
     appears in both at the same point in time.
  3. The microphone track contains the operator's voice: a phrase read aloud
     into the room appears on the mic track and not on the tap track.

Condition 1 fails today because the ffmpeg/avfoundation mic path delivers a
rate-independent ~42,000 samples/s ceiling, losing ~11% at 48 kHz. Condition 2
fails today because the call runs on built-in speakers with no echo
cancellation, so the remote side bleeds into the microphone.

Condition 3 exists because 1 and 2 are both satisfiable by a recorder that
writes silence, and because echo cancellation can satisfy 2 by suppressing the
microphone outright — the specific regression that adding it could introduce.
It requires a human at the machine; there is no way to synthesise a local voice
that is not also coming out of the speakers, which is precisely what condition
2 forbids. If condition 3 is skipped the test refuses to report a pass, the
same way preflight refuses on the wrong devices.

The test is deliberately hardware-real: no headphones, speakers actually
playing, microphone actually listening. A loopback or synthetic fixture would
pass while the shipping path fails.

Usage:
    mictest.py ffmpeg              [--seconds 60] [--outdir DIR]
    mictest.py /path/to/miccap     [--seconds 60] [--outdir DIR]

The first argument selects the microphone recorder under test. Everything else
about the capture — the tap, the transcription, the three assertions — is held
constant so results are comparable across recorders.

Exit code is 0 only if all three conditions pass.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import threading
import sys
import time
from pathlib import Path

REPO_RECORDER = Path(__file__).resolve().parent
SYSTEMTAP_BIN = REPO_RECORDER / "systemtap" / ".build" / "release" / "systemtap"
AUDIODEVS_BIN = REPO_RECORDER / "audiodevs"
TRANSCRIBE_PY = REPO_RECORDER / "transcribe.py"

TAP_RATE = 48000
TAP_CH = 1

# Condition 1 threshold. The measurement error has two parts: a constant, from
# bracketing the capture interval against the samples actually flushed at
# start and stop (~25 ms observed on the tap, which is a known-clean path), and
# a proportional part, which is the drift being tested for. A pure percentage
# therefore tightens as the capture shortens — at 25 s the tap reference
# measured +0.145% and would have "failed" a 0.1% rule on jitter alone. The
# tolerance is max(constant, percentage) so each term governs where it
# dominates.
DRIFT_TOLERANCE_PCT = 0.001   # 0.1%, governs long captures
DRIFT_TOLERANCE_FLOOR_S = 0.15  # governs short ones; ~6x the observed bracketing

# Below this, a PASS on condition 1 is not authoritative: the floor above is
# wide enough at short durations to swallow a real drift that a full-length run
# would catch. A FAIL is still meaningful — the ffmpeg deficit is ~3 s at 25 s,
# twenty times the floor — so short runs stay useful for iterating, they just
# cannot certify. Mirrors the condition 3 refusal rather than inventing a
# second mechanism.
MIN_AUTHORITATIVE_S = 45.0

# Condition 2: shortest phrase length that counts as "the same words". Three
# words is long enough that agreement is not coincidence between two
# independent transcriptions of a quiet room, and short enough to catch bleed
# that whisper only partially resolved.
NGRAM_N = 3

# How far apart two occurrences of the same phrase may be and still count as
# "the same point in time". Generous, because a path that loses samples also
# compresses its own timeline — on the 08-13 Tyler capture the mic ran up to
# 51 s ahead of the tap by the end. A tight window would let exactly the worst
# case through. Shared phrases outside the window are reported too, separately.
SAME_TIME_TOLERANCE_S = 90.0

# Read aloud by the operator, into the room, WHILE the speakers are playing.
# Double-talk is the case that matters: echo cancellation which simply gates the
# microphone whenever it detects far-end audio would sail through a
# read-it-in-a-silent-gap test and then delete the local speaker from every real
# call. Content words appear nowhere in SPEECH_SCRIPT, so the phrase stays
# unambiguous under overlap, and it cannot reach the tap because the operator's
# voice is not system output.
OPERATOR_PHRASE = "The violet lantern marks the seventh harbour gate."

# How much of the phrase must survive on the mic track to count. Whisper will
# not always return all five content words cleanly at conversational volume;
# requiring every one of them would make the test flaky in the direction of
# false failure, which is worse than useless here.
OPERATOR_MIN_WORDS = 3

# Seconds held open for the operator to read, over live playback.
OPERATOR_WINDOW_S = 12.0

# Seconds of playback before the read prompt, so the far end is unambiguously
# already talking when the operator starts.
OPERATOR_LEAD_IN_S = 5.0

# Spoken during the capture. Deliberately specific: rare word pairs make a
# shared n-gram strong evidence of bleed rather than of two transcribers
# independently emitting the same filler.
SPEECH_SCRIPT = (
    "The quarterly pipeline review begins with seventeen unresolved territory "
    "assignments. Marguerite reported that the Helsinki warehouse migration "
    "slipped by eleven days because the customs paperwork referenced an "
    "obsolete tariff schedule. Consequently the northern distribution corridor "
    "remains unstaffed through the harvest window. Our procurement lead "
    "proposes consolidating the Trondheim and Bergen contracts into a single "
    "renewable framework agreement. That would eliminate duplicate freight "
    "surcharges and simplify the reconciliation of quarterly rebates. "
    "Separately, the instrumentation team discovered that the calibration "
    "drift on the older spectrometers exceeds published tolerances by roughly "
    "four percent. Replacing the reference cells requires a scheduled shutdown "
    "of the analysis bench for two consecutive working days. Finance has asked "
    "whether the capital request can be deferred until the next budget cycle. "
    "The recommendation is to proceed immediately, because deferred "
    "recalibration invalidates every downstream measurement taken since "
    "February. Finally, the archivist requests that all legacy plate negatives "
    "be digitised before the humidity controls are decommissioned in the "
    "basement vault."
)


def die(msg: str) -> int:
    sys.stderr.write(f"mictest: {msg}\n")
    return 1


def log(msg: str) -> None:
    print(msg, flush=True)


# --- preflight -------------------------------------------------------------

def snapshot_devices() -> dict:
    """Parse one audiodevs snapshot line into a dict."""
    out = subprocess.run([str(AUDIODEVS_BIN)], capture_output=True, text=True, check=True)
    line = out.stdout.strip().splitlines()[0]
    return {k: (q or u) for k, q, u in re.findall(r'(\w+)=(?:"([^"]*)"|(\S+))', line)}


def preflight() -> tuple[bool, dict]:
    """The test is only meaningful on built-in mic + built-in speakers.

    Headphones of any kind break condition 2's premise: the remote audio never
    reaches the microphone, so a path with no echo cancellation at all would
    pass. Refuse rather than report a pass that means nothing.
    """
    d = snapshot_devices()
    log("--- preflight ---")
    for k in ("in_name", "in_uid", "in_rate", "out_name", "out_uid", "out_rate",
              "mic_perm", "tap_perm"):
        log(f"  {k:10s} {d.get(k)}")
    ok = True
    if d.get("in_uid") != "BuiltInMicrophoneDevice":
        log(f"  FAIL: default input is {d.get('in_name')!r}, need the built-in microphone")
        ok = False
    if d.get("out_uid") != "BuiltInSpeakerDevice":
        log(f"  FAIL: default output is {d.get('out_name')!r}, need the built-in speakers")
        ok = False
    if d.get("mic_perm") != "granted" or d.get("tap_perm") != "granted":
        log("  FAIL: microphone and system-audio permission must both be granted")
        ok = False
    log(f"  preflight: {'OK' if ok else 'REFUSED'}")
    return ok, d


# --- speech ----------------------------------------------------------------

def make_speech(path: Path) -> float:
    """Render the script to a file with `say`, return its duration."""
    # WAVE container: `say` refuses LEF32 into AIFF, which is big-endian.
    subprocess.run(["say", "-o", str(path), "--file-format=WAVE",
                    "--data-format=LEF32@48000", SPEECH_SCRIPT], check=True)
    info = subprocess.run(["afinfo", str(path)], capture_output=True, text=True, check=True)
    m = re.search(r"estimated duration: ([\d.]+) sec", info.stdout)
    return float(m.group(1)) if m else 0.0


# --- capture ---------------------------------------------------------------

def mic_command(recorder: str, out_wav: Path) -> list[str]:
    if recorder == "ffmpeg":
        # The recorder's exact invocation (recorder/app/main.js), minus -nostats
        # so the final progress line carries elapsed=.
        return ["ffmpeg", "-hide_banner", "-y",
                "-f", "avfoundation", "-i", ":MacBook Pro Microphone",
                "-c:a", "pcm_f32le", str(out_wav)]
    return [recorder, str(out_wav)]


def run_capture(recorder: str, seconds: int, outdir: Path, stem: str,
                operator: bool) -> dict:
    tap_path = outdir / f"system-{stem}.f32le.pcm"
    mic_path = outdir / f"mic-{stem}.wav"
    tap_log = outdir / f"systemtap-{stem}.log"
    mic_log = outdir / f"mic-{stem}.log"
    speech = outdir / f"speech-{stem}.wav"

    log("--- speech ---")
    dur = make_speech(speech)
    log(f"  rendered {speech.name}: {dur:.2f}s of speech")

    if operator:
        log("")
        log("  " + "=" * 66)
        log("  OPERATOR: you will be asked to read this aloud, ONCE, in a normal")
        log("  speaking voice, WHILE the speakers are talking over you:")
        log("")
        log(f"      {OPERATOR_PHRASE}")
        log("")
        log("  Wait for the READ NOW prompt. Do not read it before then.")
        log("  " + "=" * 66)
        for n in (5, 4, 3, 2, 1):
            log(f"  starting in {n}...")
            time.sleep(1.0)
    log("")

    log("--- capture ---")
    env = dict(os.environ, SYSTEMTAP_OUT=str(tap_path))
    plays = [0]
    stop_playback = threading.Event()

    def playback_loop() -> None:
        """Keep the far end talking continuously for the whole capture."""
        while not stop_playback.is_set():
            p = subprocess.Popen(["afplay", str(speech)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Counted on start, not on completion: the script is longer than a
            # short capture, so counting completions reports 0 for a run whose
            # speakers were audibly playing the whole time.
            plays[0] += 1
            while p.poll() is None:
                if stop_playback.wait(0.1):
                    p.terminate()
                    return

    with open(tap_log, "wb") as tl, open(mic_log, "wb") as ml:
        harness_start = time.time()
        tap_proc = subprocess.Popen([str(SYSTEMTAP_BIN)], env=env, stdout=tl, stderr=tl)
        mic_cmd = mic_command(recorder, mic_path)
        log(f"  mic command: {' '.join(mic_cmd)}")
        mic_proc = subprocess.Popen(mic_cmd, stdout=ml, stderr=ml, stdin=subprocess.DEVNULL)

        # Let both settle before any sound is played, so the speech lands well
        # inside the capture window rather than racing device startup.
        time.sleep(1.5)

        player = threading.Thread(target=playback_loop, daemon=True)
        player.start()

        if operator:
            time.sleep(OPERATOR_LEAD_IN_S)
            log("")
            log("  >>> READ NOW, out loud, over the speakers:")
            log(f"  >>>     {OPERATOR_PHRASE}")
            log("")
            end = time.time() + OPERATOR_WINDOW_S
            while time.time() < end:
                left = end - time.time()
                if left > 0:
                    log(f"  >>> {left:.0f}s left in the read window")
                time.sleep(3.0)
            log("  >>> read window closed")

        while time.time() - harness_start < seconds:
            time.sleep(0.1)

        stop_playback.set()
        player.join(timeout=5)

        mic_proc.send_signal(signal.SIGINT)
        tap_proc.send_signal(signal.SIGINT)
        mic_proc.wait(timeout=20)
        tap_proc.wait(timeout=20)
        harness_wall = time.time() - harness_start

    log(f"  started the script {plays[0]}x through the built-in speakers "
        f"(script is {dur:.0f}s long; the last pass is cut short by the capture ending)")
    log(f"  harness wall (spawn -> both stopped): {harness_wall:.3f}s")
    return {
        "tap_path": tap_path, "mic_path": mic_path,
        "tap_log": tap_log, "mic_log": mic_log,
        "harness_wall": harness_wall, "speech_plays": plays[0],
    }


# --- measurement -----------------------------------------------------------

def parse_wav(path: Path) -> dict:
    """fmt chunk read directly; data length from file size.

    Deliberately mirrors transcribe.py: a recorder killed by SIGINT may not
    have patched the RIFF/data sizes, and a test that trusted those headers
    would measure the header rather than the audio.
    """
    with open(path, "rb") as f:
        riff = f.read(12)
        if riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
            raise ValueError(f"{path}: not RIFF/WAVE")
        fmt = None
        data_offset = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            tag, size = hdr[:4], struct.unpack("<I", hdr[4:8])[0]
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
        raise ValueError(f"{path}: missing fmt or data chunk")
    fmt_tag, ch, rate, _br, block_align, bits = struct.unpack("<HHIIHH", fmt[:16])
    data_bytes = path.stat().st_size - data_offset
    frames = data_bytes // block_align if block_align else 0
    return {"format_tag": fmt_tag, "channels": ch, "rate": rate, "bits": bits,
            "block_align": block_align, "data_bytes": data_bytes, "frames": frames,
            "duration_s": frames / rate if rate else 0.0}


def recorder_wall(recorder: str, mic_log: Path) -> float | None:
    """Each recorder's own report of how long it was actually capturing.

    Preferred over the harness's spawn->signal interval, which includes process
    startup — at 60 s a 0.1% budget is 60 ms, and ffmpeg alone takes longer than
    that to open the device. Cross-checked against the harness wall below.
    """
    text = mic_log.read_text(errors="replace")
    if recorder == "ffmpeg":
        m = re.findall(r"elapsed=(\d+):(\d\d):(\d\d\.\d\d)", text)
        if not m:
            return None
        h, mi, s = m[-1]
        return int(h) * 3600 + int(mi) * 60 + float(s)
    start = re.search(r"mic_capture_started wall_ns=(\d+)", text)
    stop = re.search(r"mic_capture_stopped wall_ns=(\d+)", text)
    if not (start and stop):
        return None
    return (int(stop.group(1)) - int(start.group(1))) / 1e9


def tap_wall(tap_log: Path) -> float | None:
    text = tap_log.read_text(errors="replace")
    start = re.search(r"system_tap_started wall_ns=(\d+)", text)
    stop = re.search(r"system_tap_stopped wall_ns=(\d+)", text)
    if not (start and stop):
        return None
    return (int(stop.group(1)) - int(start.group(1))) / 1e9


# --- condition 2 -----------------------------------------------------------

_WORD = re.compile(r"[a-z0-9]+")


def ngrams(text: str, n: int) -> list[str]:
    w = _WORD.findall(text.lower())
    return [" ".join(w[i:i + n]) for i in range(len(w) - n + 1)]


def operator_hits(segments: list[dict], track: str) -> tuple[int, list[str]]:
    """How many of the phrase's content words appear on one track.

    Word-level rather than exact-phrase, because the operator is being talked
    over: whisper routinely returns the phrase with a word dropped or a filler
    inserted, and an exact match would fail runs where the local voice plainly
    did survive.
    """
    want = set(_WORD.findall(OPERATOR_PHRASE.lower())) - {"the"}
    said = set()
    for s in segments:
        if s["track"] != track:
            continue
        said |= set(_WORD.findall(s["text"].lower()))
    hit = sorted(want & said)
    return len(hit), hit


def shared_phrases(segments: list[dict], n: int) -> list[dict]:
    """Every n-gram appearing on both tracks, with each side's timestamp."""
    by_track: dict[str, dict[str, list[tuple[float, float]]]] = {"me": {}, "them": {}}
    for s in segments:
        span = (s["start_ms"] / 1000.0, s["end_ms"] / 1000.0)
        for g in ngrams(s["text"], n):
            by_track.setdefault(s["track"], {}).setdefault(g, []).append(span)
    out = []
    for g, mic_spans in by_track.get("me", {}).items():
        tap_spans = by_track.get("them", {}).get(g)
        if not tap_spans:
            continue
        best = min(
            ((abs(a[0] - b[0]), a, b) for a in mic_spans for b in tap_spans),
            key=lambda t: t[0],
        )
        out.append({"phrase": g, "delta_s": best[0], "mic_at": best[1][0], "tap_at": best[2][0]})
    return sorted(out, key=lambda d: d["delta_s"])


# --- main ------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("recorder", help='"ffmpeg" or a path to a mic recorder binary')
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--skip-preflight", action="store_true",
                    help="run anyway on the wrong devices (result will not mean what it says)")
    ap.add_argument("--no-operator", dest="operator", action="store_false",
                    help="skip condition 3; the test will then refuse to report a pass")
    args = ap.parse_args()

    for p in (SYSTEMTAP_BIN, AUDIODEVS_BIN, TRANSCRIBE_PY):
        if not Path(p).exists():
            return die(f"missing {p}")

    ok, _ = preflight()
    if not ok and not args.skip_preflight:
        return die("preflight refused — see above")

    outdir = Path(args.outdir) if args.outdir else Path(
        os.path.expanduser("~/Library/Application Support/clipwise/mictest"))
    outdir.mkdir(parents=True, exist_ok=True)
    stem = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    log(f"recorder under test: {args.recorder}")
    log(f"outdir: {outdir}")

    cap = run_capture(args.recorder, args.seconds, outdir, stem, args.operator)

    log("--- condition 1: samples written vs elapsed wall time ---")
    mic = parse_wav(cap["mic_path"])
    mic_wall = recorder_wall(args.recorder, cap["mic_log"])
    tap_bytes = cap["tap_path"].stat().st_size
    tap_dur = tap_bytes / 4 / TAP_CH / TAP_RATE
    tw = tap_wall(cap["tap_log"])

    log(f"  mic fmt          : tag=0x{mic['format_tag']:04x} {mic['rate']} Hz "
        f"{mic['channels']} ch {mic['bits']} bit")
    log(f"  mic frames       : {mic['frames']}  -> {mic['duration_s']:.3f}s of audio")
    log(f"  mic wall         : {mic_wall if mic_wall is None else f'{mic_wall:.3f}'}s (recorder self-reported)")
    log(f"  tap audio        : {tap_dur:.3f}s   tap wall: {tw if tw is None else f'{tw:.3f}'}s")
    log(f"  harness wall     : {cap['harness_wall']:.3f}s")

    cond1_provisional = False
    if mic_wall is None:
        log("  FAIL: recorder did not report its capture interval")
        cond1 = False
        mic_drift = None
    else:
        mic_deficit = mic_wall - mic["duration_s"]
        mic_drift = mic_deficit / mic_wall
        tap_drift = (tw - tap_dur) / tw if tw else float("nan")
        tol_s = max(DRIFT_TOLERANCE_FLOOR_S, mic_wall * DRIFT_TOLERANCE_PCT)
        log(f"  mic deficit      : {mic_deficit:+.3f}s  ({mic_drift * 100:+.3f}%)")
        log(f"  tap deficit      : {tw - tap_dur:+.3f}s  ({tap_drift * 100:+.3f}%)   [reference]")
        log(f"  tolerance        : +/-{tol_s * 1000:.0f}ms  "
            f"= max({DRIFT_TOLERANCE_FLOOR_S * 1000:.0f}ms floor, "
            f"{DRIFT_TOLERANCE_PCT * 100:.1f}% of {mic_wall:.1f}s = {mic_wall * DRIFT_TOLERANCE_PCT * 1000:.0f}ms)")
        cond1 = abs(mic_deficit) <= tol_s
        # A short run's floor is wide enough to hide a real drift, so a pass
        # here is not evidence. A fail is, and stays reported as one.
        if cond1 and mic_wall < MIN_AUTHORITATIVE_S:
            cond1_provisional = True
    if cond1_provisional:
        log(f"  CONDITION 1: PASS (PROVISIONAL — capture was {mic_wall:.1f}s, "
            f"under the {MIN_AUTHORITATIVE_S:.0f}s needed to certify)")
    else:
        log(f"  CONDITION 1: {'PASS' if cond1 else 'FAIL'}")

    log("--- transcribing both tracks ---")
    tj = outdir / f"transcript-{stem}.json"
    r = subprocess.run([sys.executable, str(TRANSCRIBE_PY), str(cap["tap_path"]),
                        str(cap["mic_path"]), str(tj)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        log(r.stdout[-3000:])
        log(r.stderr[-3000:])
        log("  FAIL: transcription rejected the capture")
        log("  CONDITION 2: FAIL (could not evaluate)")
        return 1
    segments = json.loads(tj.read_text())["segments"]
    n_mic = sum(1 for s in segments if s["track"] == "me")
    n_tap = sum(1 for s in segments if s["track"] == "them")
    log(f"  segments: mic={n_mic} tap={n_tap}")

    log(f"--- condition 2: shared {NGRAM_N}-word phrases across tracks ---")
    shared = shared_phrases(segments, NGRAM_N)
    near = [s for s in shared if s["delta_s"] <= SAME_TIME_TOLERANCE_S]
    log(f"  shared {NGRAM_N}-grams anywhere            : {len(shared)}")
    log(f"  shared within {SAME_TIME_TOLERANCE_S:.0f}s of each other : {len(near)}")
    for s in near[:15]:
        log(f"    {s['delta_s']:7.1f}s apart   mic@{s['mic_at']:7.1f}s  tap@{s['tap_at']:7.1f}s   {s['phrase']!r}")
    if len(near) > 15:
        log(f"    ... and {len(near) - 15} more")
    cond2 = len(near) == 0
    log(f"  CONDITION 2: {'PASS' if cond2 else 'FAIL'}")

    log("--- condition 3: operator's voice present on the mic track ---")
    if not args.operator:
        cond3 = None
        log("  SKIPPED (--no-operator)")
    else:
        n_mic_hit, mic_hit = operator_hits(segments, "me")
        n_tap_hit, tap_hit = operator_hits(segments, "them")
        want = sorted(set(_WORD.findall(OPERATOR_PHRASE.lower())) - {"the"})
        log(f"  phrase              : {OPERATOR_PHRASE!r}")
        log(f"  content words       : {want}")
        log(f"  found on mic track  : {n_mic_hit}/{len(want)}  {mic_hit}")
        log(f"  found on tap track  : {n_tap_hit}/{len(want)}  {tap_hit}")
        log(f"  threshold           : >={OPERATOR_MIN_WORDS} on mic, 0 on tap")
        on_mic = n_mic_hit >= OPERATOR_MIN_WORDS
        off_tap = n_tap_hit == 0
        if not on_mic:
            log("  the local voice did not survive on the mic track")
        if not off_tap:
            log("  the phrase reached the TAP track — the operator's voice is being "
                "picked up as system output, which invalidates this run")
        cond3 = on_mic and off_tap
        log(f"  CONDITION 3: {'PASS' if cond3 else 'FAIL'}")

    # Not an assertion — a guard against a vacuous pass. If the speakers never
    # reached the tap, there was nothing available to bleed and condition 2
    # would pass no matter how bad the capture path is.
    tap_words = len(_WORD.findall(" ".join(s["text"] for s in segments if s["track"] == "them")))
    log("--- test validity ---")
    log(f"  words on tap track: {tap_words}  (speech played {cap['speech_plays']}x)")
    if tap_words < 20:
        log("  WARNING: the tap barely captured the speech — condition 2 may pass vacuously")

    def verdict(c):
        return "SKIPPED" if c is None else ("PASS" if c else "FAIL")

    c1 = "PASS(PROVISIONAL)" if cond1_provisional else verdict(cond1)

    # Anything that cannot certify a pass exits 2, never 0. Exit code is the
    # only part of this output a script will read, so "we could not tell" must
    # not be indistinguishable from "it worked".
    refusals = []
    if cond3 is None:
        # Conditions 1 and 2 are both satisfied by a recorder that writes
        # silence; condition 3 is the only one requiring the mic to have worked.
        refusals.append(f"condition 3 was skipped")
    if cond1_provisional:
        refusals.append(
            f"condition 1 passed only provisionally (capture {mic_wall:.1f}s < "
            f"{MIN_AUTHORITATIVE_S:.0f}s)")

    log("")
    log(f"RESULT  condition1={c1}  condition2={verdict(cond2)}  "
        f"condition3={verdict(cond3)}"
        + (f"  -- REFUSED: {'; '.join(refusals)}" if refusals else ""))
    failed = (cond1 is False) or (cond2 is False) or (cond3 is False)
    if failed:
        return 1
    if refusals:
        log(f"REFUSED: {'; '.join(refusals)} — a pass cannot be reported.")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
