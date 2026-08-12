// Ingest one merged transcript from recorder/transcribe.py into Postgres.
//
// Library only. Exports `ingestTranscript(transcriptPath)`, which throws on
// any validation or fidelity failure and does not touch process state
// (no exit, no pool.end). The historical `tsx` entry point now lives in
// `ingest/cli.ts`.
//
// The transcript file is the payload written by recorder/transcribe.py:
//   { inputs, downsampled, model, labels, segments: [...] }
// Each segment has { track: "me"|"them", start_ms, end_ms, text }.
//
// Writes rows shaped to match Fathom-imported recordings (nulls where
// the existing rows leave nulls, so downstream queries see one convention
// rather than two). Speakers are `me` and `them`, derived purely from the
// segment's `track` field. Extraction is a separate step (server extract
// CLI) — this module does not run it.
//
// transcripts.text is written as NULL (schema.ts:110 declares the column
// nullable — no .notNull() — and information_schema confirms it in the
// live DB). The merged transcript's text is the concatenation of the
// per-segment texts and is derivable from the segments rows; the /transcript
// endpoint sends it when the caller has it, but not sending it is valid.
//
// end_sec is written from Whisper's offsets.to verbatim. It is
// indistinguishable from the next segment's start on 141/141 tap pairs
// and 87/88 mic pairs from the 08-07 rehearsal — same defect SAA-79
// records on the Fathom side. Do not synthesize, do not null.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { and, count, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { slugify } from "../lib/slug.js";

type Segment = {
  track: "me" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

type TrackContent = {
  samples?: number;
  duration_s?: number;
  nonzero_fraction?: number;
  rms?: number;
  peak?: number;
};

type Transcript = {
  inputs?: { tap?: string; mic?: string };
  downsampled?: { tap_16k?: string; mic_16k?: string };
  model?: string;
  labels?: string[];
  content?: { tap?: TrackContent; mic?: TrackContent };
  segments: Segment[];
};

// The SAA-93 capture manifest, as much of it as ingest reads. The seam hands
// this in; it is not re-read from disk here.
export type CaptureIdentity = {
  recordingId: string;
  startedAt: string;
  stem: string;
  manifestFile: string;
  tracks?: unknown;
  permissions?: { tap?: string; mic?: string };
};

// Only what ingest needs from the classifier; the full shape lives in
// pipeline/classify-capture.ts, which ingest deliberately does not import so
// the two can be used independently.
export type IngestClassification = {
  verdict: string;
  concern: boolean;
  reason: string;
  excludedLabels: Array<"me" | "them">;
  tracks?: unknown;
  thresholds?: unknown;
};

export const CLIPWISE_SOURCE = "clipwise-recorder";

export type IngestResult = {
  recordingId: string;
  transcriptId: string;
  segmentCount: number;
  title: string;
  slug: string;
  accountId: string;
  accountSlug: string;
  declared: { turnCount: number; bodyChars: number };
  observed: { turnCount: number; bodyChars: number };
  // Segments deliberately left out because their track carried no audio.
  // Kept separate from declared/observed so a partial capture reconciles:
  // declared + excluded == everything the transcript contained.
  excluded: { turnCount: number; bodyChars: number };
  recording: Record<string, unknown>;
  // The external identity this recording was filed under: the manifest's
  // recording_id when a manifest was supplied, else the filename stamp.
  sourceId: string;
  // True when an existing row was adopted rather than a new one inserted.
  // The seam relies on this to make retry safe.
  reused: boolean;
};

// Convert the ISO stamp used in transcribe output filenames
// ("2026-08-07T12-23-54Z") into a real ISO-8601 timestamp
// ("2026-08-07T12:23:54Z"). Only the time portion has "-" swapped
// for ":" — the date already uses "-".
function stampToIso(stamp: string): string | null {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
}

export async function ingestTranscript(
  transcriptPath: string,
  capture?: CaptureIdentity,
  classification?: IngestClassification | null,
): Promise<IngestResult> {
  const raw = readFileSync(transcriptPath, "utf8");
  const doc = JSON.parse(raw) as Transcript;
  if (!Array.isArray(doc.segments) || doc.segments.length === 0) {
    throw new Error(`no segments in ${transcriptPath}`);
  }

  // A track the classifier found no audio on produces segments anyway —
  // Whisper writes text over silence (SAA-91). Those are excluded here, and
  // preserved verbatim on the recording rather than discarded: the "dead"
  // verdict rests on a threshold, and a wrong call must not silently delete
  // real speech. The transcript file on disk is never modified either, so the
  // full record survives in two independent places.
  const excludeLabels = new Set(classification?.excludedLabels ?? []);
  const kept = doc.segments.filter((s) => !excludeLabels.has(s.track));
  const dropped = doc.segments.filter((s) => excludeLabels.has(s.track));
  if (kept.length === 0) {
    throw new Error(
      `every segment in ${transcriptPath} belongs to a track with no audio ` +
        `(${[...excludeLabels].join(", ")}) — nothing to ingest`,
    );
  }

  // One label is legitimate now: a capture where only one side had audio is
  // half a real conversation, not a malformed transcript.
  const labelSet = new Set(kept.map((s) => s.track));
  const unknown = [...labelSet].filter((l) => l !== "me" && l !== "them");
  if (unknown.length) {
    throw new Error(
      `expected labels from {me, them}; got {${[...labelSet].sort().join(", ")}}`,
    );
  }

  const stampMatch = basename(transcriptPath).match(
    /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/,
  );
  const stamp = capture?.stem ?? (stampMatch ? stampMatch[1] : null);

  // Identity comes from the manifest when there is one. The stamp is a
  // fallback for transcripts that predate SAA-93 — it identifies nothing
  // durable (it collides, is clock-dependent, and dies with the filename),
  // which is why the manifest exists.
  const sourceId = capture?.recordingId ?? stamp ?? basename(transcriptPath);

  // The manifest's start time is the recorded instant, to the millisecond.
  // Reconstructing it from the filename stem loses sub-second precision and
  // assumes the stem was never renamed, so prefer the manifest.
  const startedAtIso = capture?.startedAt ?? (stamp ? stampToIso(stamp) : null);
  const startedAt = startedAtIso ? new Date(startedAtIso) : undefined;

  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }
  const account = accounts[0];

  const title = stamp
    ? `Clipwise capture — ${stamp}`
    : `Clipwise capture — ${basename(transcriptPath)}`;
  const slug = stamp
    ? `clipwise-capture-${slugify(stamp)}`
    : `clipwise-capture-${slugify(basename(transcriptPath))}`;

  // SAA-78-style fidelity numbers taken from the source (the JSON on
  // disk), before any DB write. Same counting rule the /transcript
  // endpoint applies (routes/transcript.ts:60): one segment = one turn,
  // sum of segment.text.length as bodyChars. Compared against the
  // post-insert DB counts below.
  // Counted over the segments actually being inserted. Counting the whole
  // transcript here would make every deliberate exclusion look like lossy
  // ingest and trip the fidelity check below on a legitimate partial capture.
  const declared = {
    turnCount: kept.length,
    bodyChars: kept.reduce((n, s) => n + s.text.length, 0),
  };
  const excluded = {
    turnCount: dropped.length,
    bodyChars: dropped.reduce((n, s) => n + s.text.length, 0),
  };

  process.stdout.write(
    `ingest: account=${account.id} (${account.slug}) title=${JSON.stringify(title)} slug=${slug}\n`,
  );
  process.stdout.write(
    `ingest: declared turnCount=${declared.turnCount} bodyChars=${declared.bodyChars} labels=${[...labelSet].sort().join(",")}\n`,
  );
  if (excluded.turnCount) {
    process.stdout.write(
      `ingest: excluded turnCount=${excluded.turnCount} bodyChars=${excluded.bodyChars} ` +
        `label(s)=${[...excludeLabels].sort().join(",")} (no audio on that track; preserved in metadata.capture_quality)\n`,
    );
  }

  // Idempotency on external identity. The seam retries by re-running from the
  // first incomplete step, so ingest must be safe to reach twice for the same
  // capture — inserting a second recording would fork the transcript and give
  // extraction two rows to argue over. Keyed on (source, source_id), the pair
  // the normalized transcript contract dedupes on, so this stays true for any
  // future producer that files under the same convention.
  const [existing] = await db
    .select()
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.accountId, account.id),
        eq(schema.recordings.source, CLIPWISE_SOURCE),
        eq(schema.recordings.sourceId, sourceId),
      ),
    );
  if (existing) {
    const [transcript] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.recordingId, existing.id));
    const [counts] = await db
      .select({
        turnCount: count(),
        bodyChars: sql<number>`coalesce(sum(char_length(${schema.segments.text})), 0)::bigint`,
      })
      .from(schema.segments)
      .where(eq(schema.segments.recordingId, existing.id));
    process.stdout.write(
      `ingest: recording already exists for source_id=${sourceId} → reusing ${existing.id} (no insert)\n`,
    );
    return {
      recordingId: existing.id,
      transcriptId: transcript?.id ?? "",
      segmentCount: Number(counts.turnCount),
      title: existing.title ?? title,
      slug: existing.slug ?? slug,
      accountId: account.id,
      accountSlug: account.slug,
      declared,
      observed: {
        turnCount: Number(counts.turnCount),
        bodyChars: Number(counts.bodyChars),
      },
      // Nothing was excluded on this path because nothing was inserted; the
      // original ingest's exclusions are already recorded on the existing row.
      excluded: { turnCount: 0, bodyChars: 0 },
      recording: existing as unknown as Record<string, unknown>,
      sourceId,
      reused: true,
    };
  }

  const result = await db.transaction(async (tx) => {
    const [recording] = await tx
      .insert(schema.recordings)
      .values({
        accountId: account.id,
        slug,
        title,
        source: CLIPWISE_SOURCE,
        sourceId,
        mediaUrl: null,
        durationSec: null,
        startedAt,
        endedAt: undefined,
        // status intentionally omitted — the column default ("pending")
        // matches Fathom-imported rows.
        meetingKind: null,
        metadata: {
          transcript_source_path: transcriptPath,
          inputs: doc.inputs ?? null,
          downsampled: doc.downsampled ?? null,
          whisper_model: doc.model ?? null,
          content: doc.content ?? null,
          // What the classifier decided and what it cost. A partial capture
          // has to explain itself later without anyone re-deriving it, and the
          // excluded segments live here verbatim so a wrong "dead" call is
          // recoverable from the row alone.
          capture_quality: classification
            ? {
                verdict: classification.verdict,
                concern: classification.concern,
                reason: classification.reason,
                excluded_labels: classification.excludedLabels,
                excluded_counts: excluded,
                tracks: classification.tracks ?? null,
                thresholds: classification.thresholds ?? null,
                dropped_segments: dropped,
              }
            : null,
          // The capture manifest, denormalised onto the recording: which
          // device fed each track and at what rate. Recoverable from the
          // manifest file, but that file lives outside the server and
          // outlives nothing in particular.
          capture: capture
            ? {
                manifest_file: capture.manifestFile,
                stem: capture.stem,
                started_at: capture.startedAt,
                tracks: capture.tracks ?? null,
              }
            : null,
        },
      })
      .returning();

    const [transcript] = await tx
      .insert(schema.transcripts)
      .values({
        recordingId: recording.id,
        provider: "whisper.cpp",
        language: "en",
        // text is nullable (schema.ts:110); merged text is derivable
        // from the segments rows.
        text: null,
        status: "ready",
      })
      .returning();

    // Only for labels actually present. A `them` speaker with no segments
    // would assert a participant who contributed nothing to the recording.
    const speakerByLabel = new Map<string, string>();
    for (const label of ["me", "them"] as const) {
      if (!labelSet.has(label)) continue;
      const [inserted] = await tx
        .insert(schema.speakers)
        .values({ recordingId: recording.id, label })
        .returning();
      speakerByLabel.set(label, inserted.id);
    }

    const segmentRows = kept.map((s, idx) => ({
      accountId: account.id,
      recordingId: recording.id,
      transcriptId: transcript.id,
      speakerId: speakerByLabel.get(s.track),
      startSec: s.start_ms / 1000,
      endSec: s.end_ms / 1000,
      text: s.text,
      orderIndex: idx,
    }));

    const inserted = await tx
      .insert(schema.segments)
      .values(segmentRows)
      .returning({ id: schema.segments.id });

    return {
      recording,
      transcript,
      segmentCount: inserted.length,
      speakerIds: Object.fromEntries(speakerByLabel),
    };
  });

  // Verification against the live DB, not the ORM's report.
  const [dbRecording] = await db
    .select()
    .from(schema.recordings)
    .where(eq(schema.recordings.id, result.recording.id));

  const [dbCounts] = await db
    .select({
      turnCount: count(),
      bodyChars: sql<number>`coalesce(sum(char_length(${schema.segments.text})), 0)::bigint`,
    })
    .from(schema.segments)
    .where(eq(schema.segments.recordingId, result.recording.id));

  process.stdout.write("\n=== recording row (post-insert readback) ===\n");
  for (const [k, v] of Object.entries(dbRecording)) {
    process.stdout.write(`  ${k} = ${JSON.stringify(v)}\n`);
  }

  const observedTurns = Number(dbCounts.turnCount);
  const observedChars = Number(dbCounts.bodyChars);
  process.stdout.write(
    `\ndb readback: turnCount=${observedTurns} bodyChars=${observedChars}\n`,
  );
  process.stdout.write(
    `fidelity vs source: turnDelta=${observedTurns - declared.turnCount} charDelta=${observedChars - declared.bodyChars}\n`,
  );
  if (
    observedTurns !== declared.turnCount ||
    observedChars !== declared.bodyChars
  ) {
    throw new Error(
      `fidelity mismatch — declared ${declared.turnCount}/${declared.bodyChars}, observed ${observedTurns}/${observedChars}`,
    );
  }

  return {
    recordingId: result.recording.id,
    transcriptId: result.transcript.id,
    segmentCount: result.segmentCount,
    title,
    slug,
    accountId: account.id,
    accountSlug: account.slug,
    declared,
    observed: { turnCount: observedTurns, bodyChars: observedChars },
    excluded,
    recording: dbRecording as unknown as Record<string, unknown>,
    sourceId,
    reused: false,
  };
}
