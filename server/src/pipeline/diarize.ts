// Splits the call-audio (`them`) track into per-voice labels after a
// capture (SAA-194). Runs as its own pipeline step, after ingest and before
// extract — deliberately not folded into ingest/clipwise.ts. ingest creates
// the plain me/them rows exactly as it always has; this is a separate later
// pass that queries what ingest already wrote and updates it, the same
// shape apply-identity.ts already uses for identity answers that arrive
// after ingest (SAA-179). That keeps ingest's own transaction untouched and
// composes for free with recover.ts's existing per-step retry machinery via
// a named STEP_ORDER entry, rather than needing new logic bolted into the
// insert path.
//
// Naming, not yet: this only ever writes `speakers.label` ("Voice 1", "Voice
// 2", ...), never `displayName`. Naming voices is SAA-195/196. Leaving
// displayName null here is what keeps extract.ts's loadIdentityResolved (it
// treats ANY non-null displayName as "identity resolved for this recording")
// from being tripped by a voice split — a group call stays exactly as
// unresolved as it is today.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { generateVoiceNamingData, type ClipRange } from "./voice-clips.js";

// Not imported from ingest/identity.ts, which declares the same two
// strings: identity.ts imports isVoiceLabel from this file for its
// split-undo logic (see its own comment), so importing back from identity.ts
// here would make the two modules circular. Re-declaring one string
// constant is the cheaper side of that trade.
const GUEST_LABEL = "them";
const VOICE_LABEL_PATTERN = /^Voice (\d+)$/;

export function voiceLabel(n: number): string {
  return `Voice ${n}`;
}

export function isVoiceLabel(label: string | null | undefined): boolean {
  return typeof label === "string" && VOICE_LABEL_PATTERN.test(label);
}

// --- the tool's sidecar, as diarize (the Swift binary) writes it ----------

type DiarizeVoice = {
  voiceIndex: number;
  sourceLabel: string;
  totalSeconds: number;
  embedding: number[];
  clipRanges: ClipRange[];
};

// voiceIndex is null for a diarized segment that exists but was excluded
// (host echo, or under minimumVoiceSeconds — see main.swift). That's
// different from no entry at all for a time range (a true diarization gap)
// — assignVoice below treats the two differently.
type DiarizeSegment = {
  start: number;
  end: number;
  voiceIndex: number | null;
};

type DiarizeSidecar = {
  model: string;
  modelRevision: string;
  clusteringThreshold: number;
  hostEchoThreshold: number;
  processingTimeSeconds: number;
  voices: DiarizeVoice[];
  segments: DiarizeSegment[];
  hostEchoSourceLabel: string | null;
  hostEchoSimilarity: number | null;
  error: string | null;
};

export type DiarizationStepResult = {
  applied: boolean;
  reason: string;
  voicesFound: number;
  modelRevision: string | null;
  processingTimeSeconds: number | null;
  hostEcho: { similarity: number; threshold: number } | null;
};

function diarizePathFor(dir: string, stem: string): string {
  return join(dir, `diarize-${stem}.json`);
}

function skip(reason: string, extra: Partial<DiarizationStepResult> = {}): DiarizationStepResult {
  return {
    applied: false,
    reason,
    voicesFound: 0,
    modelRevision: null,
    processingTimeSeconds: null,
    hostEcho: null,
    ...extra,
  };
}

// Reassign a `them` segment to the diarized voice with the greatest time
// overlap — real or excluded. A null result means "leave this segment on
// `them`," which happens two ways:
//  - its best overlap is with an excluded voice's time range (host echo,
//    or under minimumVoiceSeconds): deliberate, not a fallback.
//  - no diarized segment overlaps it at all (a true gap under a whisper
//    segment — the mic and the tap don't share a VAD): falls back to the
//    nearest diarized segment by time distance, but only among REAL
//    (non-excluded) voices — snapping a gap onto an excluded voice's
//    position isn't a place to fall back to either.
function assignVoice(
  segStart: number,
  segEnd: number,
  diarized: DiarizeSegment[],
): number | null {
  let bestOverlap = 0;
  // A separate `found` flag, not `bestVoice`'s own type, tracks "no
  // overlapping segment yet": `d.voiceIndex` for an excluded segment is
  // `null` in the type but arrives as `undefined` at runtime (Swift's
  // JSONEncoder omits a nil Optional key rather than writing `null` —
  // confirmed empirically, same issue fixed for hostEchoSourceLabel above),
  // so `undefined` can't double as that sentinel without colliding with a
  // real excluded-voice result.
  let found = false;
  let bestVoice: number | null = null;
  for (const d of diarized) {
    const overlap = Math.min(segEnd, d.end) - Math.max(segStart, d.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestVoice = d.voiceIndex ?? null;
      found = true;
    }
  }
  if (found) return bestVoice;

  let bestDistance = Infinity;
  let nearestVoice: number | null = null;
  for (const d of diarized) {
    if (d.voiceIndex == null) continue; // catches both null and an omitted-key undefined
    const distance = segStart >= d.end ? segStart - d.end : segEnd <= d.start ? d.start - segEnd : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      nearestVoice = d.voiceIndex;
    }
  }
  return nearestVoice;
}

export async function runDiarizationForCapture(
  dir: string,
  stem: string,
  dbRecordingId: string,
): Promise<DiarizationStepResult> {
  // Cheapest check first, before anything else — including the DB round
  // trip below. No attempt to build or exec anything Intel-side is ever
  // made (SAA-194 §6).
  if (process.arch !== "arm64") {
    return skip(`Apple Silicon only — this Mac reports process.arch=${process.arch}`);
  }

  const them = await db
    .select({ id: schema.speakers.id, displayName: schema.speakers.displayName })
    .from(schema.speakers)
    .where(and(eq(schema.speakers.recordingId, dbRecordingId), eq(schema.speakers.label, GUEST_LABEL)));
  if (them.length === 0) {
    return skip("no `them` speaker row on this recording — nothing to split (e.g. a tap-only track with no audio)");
  }

  const existingLabels = await db
    .select({ label: schema.speakers.label })
    .from(schema.speakers)
    .where(eq(schema.speakers.recordingId, dbRecordingId));
  if (existingLabels.some((s) => isVoiceLabel(s.label))) {
    return skip("already split by a prior diarize pass — not idempotent to re-run");
  }

  // Three levels up lands at the repo root from either src/pipeline (tsx) or
  // dist/pipeline (built) — same resolution rule transcribeIfMissing uses.
  // Checkout-relative on purpose: the server pipeline always runs from a
  // full checkout (dev via tsx, or the packaged app's SERVER_DIR, which
  // main.js points at the building machine's own checkout — see
  // build-app.sh's build-info.json), never from inside Clipwise.app. The
  // app-bundle copy under Contents/Resources exists for the CC-BY-4.0
  // redistribution requirement and packaging parity with systemtap/miccap,
  // not because the pipeline reads it from there.
  const diarizeBin = resolve(__dirname, "..", "..", "..", "recorder", "diarize", ".build", "release", "diarize");
  const modelsParentDir = resolve(__dirname, "..", "..", "..", "recorder", "diarize", "models");
  if (!existsSync(diarizeBin)) {
    return skip(`recorder/diarize binary not found at ${diarizeBin} (run recorder/diarize/fetch-models.sh and swift build)`);
  }

  const tapWav = join(dir, `system-${stem}.16k.wav`);
  const micWav = join(dir, `mic-${stem}.16k.wav`);
  if (!existsSync(tapWav)) {
    return skip(`tap 16k wav not found at ${tapWav} — transcribe step may not have run`);
  }

  const sidecarPath = diarizePathFor(dir, stem);
  let sidecar: DiarizeSidecar;
  try {
    // Experiment C ran in single-digit seconds on 19-30 minute calls
    // (~400x real time) — 120s is a wide margin over that, not a tuned
    // budget, so a genuinely hung process still gets killed within one
    // capture's processing window rather than blocking recovery forever.
    // A timeout throws (Node sets err.killed/err.signal on it), which the
    // catch below treats the same as any other tool failure: a skip, never
    // a pipeline failure.
    execFileSync(diarizeBin, [tapWav, micWav, modelsParentDir, sidecarPath], {
      stdio: "inherit",
      timeout: 120_000,
    });
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as DiarizeSidecar;
  } catch (err) {
    const timedOut = Boolean(err && typeof err === "object" && "killed" in err && (err as { killed?: boolean }).killed);
    const message = err instanceof Error ? err.message : String(err);
    return skip(timedOut ? "diarize tool timed out after 120s" : `diarize tool failed: ${message}`);
  }
  if (sidecar.error) {
    return skip(`diarize tool reported an error: ${sidecar.error}`);
  }

  // Loose inequality is deliberate: Swift's JSONEncoder omits a nil Optional
  // key entirely rather than writing `null` (confirmed empirically — the
  // 09-14 sidecar, which has no host echo, has no hostEchoSourceLabel key at
  // all), so JSON.parse yields `undefined`, not `null`, for "no host echo
  // found." `!== null` alone would have read that as a host echo with an
  // undefined similarity.
  const hostEcho =
    sidecar.hostEchoSourceLabel != null && sidecar.hostEchoSimilarity != null
      ? { similarity: sidecar.hostEchoSimilarity, threshold: sidecar.hostEchoThreshold }
      : null;

  if (sidecar.voices.length <= 1) {
    // Two-party gating (SAA-194 §5): a real 1:1 call must behave exactly as
    // today. Nothing is written — the single `them` row stands.
    return skip(
      `${sidecar.voices.length} voice(s) survived the host-echo and minimum-size drops — treating as two-party, not splitting`,
      { voicesFound: sidecar.voices.length, modelRevision: sidecar.modelRevision, processingTimeSeconds: sidecar.processingTimeSeconds, hostEcho },
    );
  }

  if (them[0].displayName) {
    // Identity vs. diarization disagreement (SAA-194, addition 1), the
    // "identity resolved before diarize ran" half. ingest/clipwise.ts's
    // applySpeakerNames can name `them` inside the same ingest step that
    // runs just before this one — if it already did, that's a confirmed
    // exactly-one-guest answer, which outranks an unassisted voice count.
    // Splitting now would both contradict that answer and destroy the name
    // it just wrote. The other half — identity arriving AFTER a split has
    // already happened — is handled by applySpeakerNames itself in
    // ingest/identity.ts, which is the only place that sees a late answer.
    return skip(
      `identity already named \`them\`=${JSON.stringify(them[0].displayName)} (one guest); diarization found ` +
        `${sidecar.voices.length} voices — keeping the single \`them\` row, not splitting (disagreement logged, not resolved)`,
      { voicesFound: sidecar.voices.length, modelRevision: sidecar.modelRevision, processingTimeSeconds: sidecar.processingTimeSeconds, hostEcho },
    );
  }

  // Populated inside the transaction, read after it commits — by
  // generateVoiceNamingData, which needs each voice's real speakers.id and
  // must not run until the split it depends on has actually landed.
  let speakerIdByVoiceOut = new Map<number, string>();

  await db.transaction(async (tx) => {
    // Voice embeddings (sidecar.voices[*].embedding) stay on the Mac, in
    // diarize-<stem>.json, and go no further (SAA-194, addition 2). `db`
    // here is Neon-hosted Postgres, not local storage — only the label,
    // voice index and segment times below ever reach it. Nothing inserted
    // in this transaction references `voice.embedding`; `speakers` has no
    // column that could hold one even by mistake.
    const speakerIdByVoice = new Map<number, string>();
    for (const voice of sidecar.voices) {
      const [inserted] = await tx
        .insert(schema.speakers)
        .values({ recordingId: dbRecordingId, label: voiceLabel(voice.voiceIndex) })
        .returning({ id: schema.speakers.id });
      speakerIdByVoice.set(voice.voiceIndex, inserted.id);
    }

    const themSegments = await tx
      .select({ id: schema.segments.id, startSec: schema.segments.startSec, endSec: schema.segments.endSec })
      .from(schema.segments)
      .where(eq(schema.segments.speakerId, them[0].id));

    // A segment can legitimately stay on `them`: assignVoice returns null
    // both for a genuinely excluded voice's time range (host echo, or under
    // minimumVoiceSeconds — see main.swift's SegmentOut comment) and, if it
    // ever happened, no diarized coverage anywhere. Track whether that
    // happened at least once — it decides whether `them` is still needed
    // below.
    let anySegmentKeptOnThem = false;
    for (const seg of themSegments) {
      const voiceIndex = assignVoice(seg.startSec, seg.endSec, sidecar.segments);
      if (voiceIndex === null) {
        anySegmentKeptOnThem = true;
        continue;
      }
      const speakerId = speakerIdByVoice.get(voiceIndex);
      if (!speakerId) {
        anySegmentKeptOnThem = true;
        continue; // unreachable in practice: assignVoice only returns indices present in sidecar.voices
      }
      await tx.update(schema.segments).set({ speakerId }).where(eq(schema.segments.id, seg.id));
    }

    // Only delete the blanket `them` row when nothing was deliberately kept
    // on it (matches ingest's own stated invariant — "a `them` speaker with
    // no segments would assert a participant who contributed nothing",
    // clipwise.ts). Deleting it while a fragment/host-echo voice's segments
    // are still pointed at it would orphan them to a null speakerId via the
    // FK's ON DELETE SET NULL, not leave them on `them` as intended.
    if (!anySegmentKeptOnThem) {
      await tx.delete(schema.speakers).where(eq(schema.speakers.id, them[0].id));
    }

    speakerIdByVoiceOut = speakerIdByVoice;
  });

  // Best-effort, same posture as the diarize tool call above: a naming-data
  // failure (ffmpeg missing, disk full, whatever) must not undo the split
  // that already committed above, and must not fail the capture (SAA-195).
  try {
    await generateVoiceNamingData(
      dir, stem,
      sidecar.voices.map((v) => ({ voiceIndex: v.voiceIndex, clipRanges: v.clipRanges })),
      speakerIdByVoiceOut,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`diarize: naming data generation failed (split still applied): ${message}`);
  }

  return {
    applied: true,
    reason: `split \`them\` into ${sidecar.voices.length} voices`,
    voicesFound: sidecar.voices.length,
    modelRevision: sidecar.modelRevision,
    processingTimeSeconds: sidecar.processingTimeSeconds,
    hostEcho,
  };
}

export { diarizePathFor };
