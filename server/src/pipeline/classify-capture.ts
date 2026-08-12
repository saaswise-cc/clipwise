// Silence classification for one capture (SAA-89).
//
// A pure function over two files' worth of already-computed facts: the
// per-track content statistics transcribe.py persists, and the permission
// state audiodevs read at capture start and the manifest recorded. No I/O
// beyond reading those, no DB, no audio decoding — so it is testable against
// fixtures on disk.
//
// The premise this is built on, and the one to re-check after a macOS update:
// SAA-87 established that a DENIED system-audio grant and a GRANTED grant with
// nothing playing are bitwise identical — both are exactly zero, across every
// sample. Sample content therefore cannot tell them apart, and no threshold
// however clever will. Only the permission state can, which is why it is read
// at capture start and carried in the manifest. Two real captures on disk
// demonstrate the collision:
//
//   2026-08-12T00-32-01Z  tap nonzero=0  tap_perm=granted  → nothing played
//   2026-08-12T00-39-45Z  tap nonzero=0  tap_perm=denied   → denied
//
// The microphone is the opposite case and the one place content is decisive: a
// live mic always carries a noise floor (0.018 and 0.022 rms measured in a
// quiet room on this machine), so a mic at exactly zero is denied or broken,
// never merely quiet.

export type Band = "zero" | "floor" | "live";

export type TrackVerdict =
  | "live"
  | "gap"
  | "dead_denied"
  | "dead_unexplained"
  | "no_signal"
  | "indeterminate";

export type Span = { start_s: number; end_s: number; duration_s: number };

export type TrackReport = {
  track: "tap" | "mic";
  label: "them" | "me";
  band: Band;
  verdict: TrackVerdict;
  permission: string;
  rms: number;
  peak: number;
  nonzero_fraction: number;
  duration_s: number;
  gaps: Span[];
  note: string;
};

export type CaptureClassification = {
  verdict: "ok" | "partial" | "unusable";
  // Whether the verdict reflects something wrong. A solo recording with
  // nothing playing is "partial" and entirely normal; a denied grant is
  // "partial" and is not.
  concern: boolean;
  reason: string;
  tracks: { tap: TrackReport; mic: TrackReport };
  // Speaker labels whose audio carried no real signal. Their transcript
  // segments are Whisper hallucinating over silence (SAA-91) and are excluded
  // from ingest — preserved, never deleted.
  excludedLabels: Array<"me" | "them">;
  thresholds: { floorRms: number; gapMinSeconds: number; windowSeconds: number };
};

// Above SAA-87's transient-gap noise floor (~0.00005) and below every real
// microphone capture measured here. That spread is wider than first assumed:
// quiet rooms on this machine have come in at 0.022, 0.0057 and 0.0012 rms,
// the last one a capture with no speech at all. An earlier 1e-3 boundary was
// set from the loudest of those and cleared the quietest by only 1.22x, which
// is not a margin. 1e-4 sits ~12x under the quietest real capture and ~2x over
// the only measured noise floor.
//
// Microphone gain varies by device, distance and room, so no absolute constant
// is safe forever. This one only has to separate "a microphone is producing
// something" from "a microphone is producing nothing" — a coarser question
// than it looks, and the reason gap detection below does not use it.
const FLOOR_RMS = 1e-4;

// A dropout shorter than this is not worth annotating — natural pauses in
// speech reach the floor for a second or two.
const GAP_MIN_SECONDS = 5;

// A dropout is relative, not absolute. A window is part of a gap when it falls
// to a tenth of what the track carries when it is carrying anything. An
// absolute threshold cannot express this: it read a uniformly quiet room as a
// twelve-second dropout, because "quiet" and "dropped out" are the same number
// and different facts. The reference level is taken over windows above the
// absolute floor, so a gap covering most of the capture still has live windows
// to be measured against — a plain median would sink into the gap itself once
// the gap ran past half the recording.
const GAP_RELATIVE_FACTOR = 0.1;

type TrackContent = {
  samples?: number;
  duration_s?: number;
  nonzero_fraction?: number;
  rms?: number;
  peak?: number;
  window_s?: number;
  windows_rms?: number[];
  windows_peak?: number[];
};

export type TranscriptContent = { tap?: TrackContent; mic?: TrackContent };

// "Exactly zero" is a count of nonzero samples, never an RMS below an epsilon.
// An RMS test cannot distinguish a file of zeros from a file at 1e-8, and that
// conflation is the specific error SAA-87's correction removed.
function bandOf(c: TrackContent): Band {
  const nz = c.nonzero_fraction;
  if (typeof nz === "number" && nz === 0) return "zero";
  const rms = typeof c.rms === "number" ? c.rms : 0;
  if (rms < FLOOR_RMS) return "floor";
  return "live";
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Runs of consecutive windows far below what this track normally carries,
// inside a track that is live overall. Only meaningful for a track that had
// signal to lose — see GAP_RELATIVE_FACTOR for why the test is relative.
function findGaps(c: TrackContent): Span[] {
  const series = c.windows_rms;
  const w = c.window_s;
  if (!Array.isArray(series) || typeof w !== "number" || w <= 0) return [];
  const carrying = series.filter((v) => v >= FLOOR_RMS);
  if (carrying.length === 0) return [];
  const threshold = median(carrying) * GAP_RELATIVE_FACTOR;
  if (!(threshold > 0)) return [];
  const minWindows = Math.ceil(GAP_MIN_SECONDS / w);
  const spans: Span[] = [];
  let run = 0;
  for (let i = 0; i <= series.length; i++) {
    const quiet = i < series.length && series[i] < threshold;
    if (quiet) {
      run++;
      continue;
    }
    if (run >= minWindows) {
      const start = (i - run) * w;
      const end = i * w;
      spans.push({
        start_s: Number(start.toFixed(3)),
        end_s: Number(end.toFixed(3)),
        duration_s: Number((end - start).toFixed(3)),
      });
    }
    run = 0;
  }
  return spans;
}

function classifyTap(c: TrackContent, perm: string): TrackReport {
  const band = bandOf(c);
  let verdict: TrackVerdict;
  let note: string;
  if (band === "live") {
    const gaps = findGaps(c);
    verdict = gaps.length ? "gap" : "live";
    note = gaps.length
      ? `system audio present, with ${gaps.length} dropout(s) at or below the noise floor`
      : "system audio present";
    return { ...base(c, "tap", "them", band, perm, gaps), verdict, note };
  }
  // No meaningful system audio. Content cannot say why — this is the collision.
  if (perm === "denied") {
    verdict = "dead_denied";
    note = "system audio permission was denied at capture start — the remote side was never captured";
  } else if (perm === "granted") {
    verdict = "no_signal";
    note = "permission granted and no system audio played — a one-sided recording, not a fault";
  } else {
    verdict = "indeterminate";
    note = `no system audio, and permission state was "${perm}" — denied and nothing-playing are indistinguishable in the audio itself`;
  }
  return { ...base(c, "tap", "them", band, perm, []), verdict, note };
}

function classifyMic(c: TrackContent, perm: string): TrackReport {
  const band = bandOf(c);
  let verdict: TrackVerdict;
  let note: string;
  if (band === "live") {
    const gaps = findGaps(c);
    verdict = gaps.length ? "gap" : "live";
    note = gaps.length
      ? `microphone present, with ${gaps.length} dropout(s) at or below the noise floor`
      : "microphone present";
    return { ...base(c, "mic", "me", band, perm, gaps), verdict, note };
  }
  // A live microphone always carries a floor, so this is never "a quiet room".
  if (perm === "denied") {
    verdict = "dead_denied";
    note = "microphone permission was denied at capture start — the local side was never captured";
  } else {
    verdict = "dead_unexplained";
    note =
      band === "zero"
        ? `microphone produced bitwise silence with permission "${perm}" — muted or broken hardware, not a quiet room`
        : `microphone never rose above the noise floor with permission "${perm}"`;
  }
  return { ...base(c, "mic", "me", band, perm, []), verdict, note };
}

function base(
  c: TrackContent,
  track: "tap" | "mic",
  label: "them" | "me",
  band: Band,
  permission: string,
  gaps: Span[],
): Omit<TrackReport, "verdict" | "note"> {
  return {
    track,
    label,
    band,
    permission,
    rms: c.rms ?? 0,
    peak: c.peak ?? 0,
    nonzero_fraction: c.nonzero_fraction ?? 0,
    duration_s: c.duration_s ?? 0,
    gaps,
  };
}

export type ClassifyInput = {
  content: TranscriptContent | undefined;
  permissions: { tap?: string; mic?: string } | undefined;
};

export function classifyCapture(input: ClassifyInput): CaptureClassification | null {
  const tapC = input.content?.tap;
  const micC = input.content?.mic;
  // Transcripts written before the content stats existed cannot be classified.
  // Saying so is the honest outcome; guessing from segment text is not.
  if (!tapC || !micC || typeof tapC.peak !== "number" || typeof micC.peak !== "number") {
    return null;
  }
  const tapPerm = input.permissions?.tap ?? "unknown";
  const micPerm = input.permissions?.mic ?? "unknown";

  const tap = classifyTap(tapC, tapPerm);
  const mic = classifyMic(micC, micPerm);

  // A track with no real signal still produces transcript segments, because
  // Whisper hallucinates over silence (SAA-91) — "[BLANK_AUDIO]" and worse.
  // Excluding keys on whether there was audio, not on why there wasn't: the
  // text is invented either way.
  const excludedLabels: Array<"me" | "them"> = [];
  if (tap.band !== "live") excludedLabels.push("them");
  if (mic.band !== "live") excludedLabels.push("me");

  let verdict: CaptureClassification["verdict"];
  let concern: boolean;
  let reason: string;
  if (excludedLabels.length === 2) {
    // Neither side carried audio. This is the case the pipeline refuses, and
    // it preserves the behaviour of the both-bitwise-zero check it replaces.
    verdict = "unusable";
    concern = true;
    reason = `neither track carried audio — ${tap.note}; ${mic.note}`;
  } else if (excludedLabels.length === 1) {
    verdict = "partial";
    // A one-sided recording is only a problem when something was supposed to
    // be there. Nothing playing is an ordinary Tuesday.
    concern = !(tap.verdict === "no_signal" && mic.band === "live");
    reason = tap.band !== "live" ? tap.note : mic.note;
  } else {
    verdict = "ok";
    concern = tap.verdict === "gap" || mic.verdict === "gap";
    reason =
      tap.gaps.length || mic.gaps.length
        ? `both tracks present, with dropouts annotated (tap ${tap.gaps.length}, mic ${mic.gaps.length})`
        : "both tracks present";
  }

  return {
    verdict,
    concern,
    reason,
    tracks: { tap, mic },
    excludedLabels,
    thresholds: {
      floorRms: FLOOR_RMS,
      gapMinSeconds: GAP_MIN_SECONDS,
      windowSeconds: tapC.window_s ?? micC.window_s ?? 0,
    },
  };
}
