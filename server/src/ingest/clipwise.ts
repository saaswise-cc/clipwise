// Ingest one merged transcript from recorder/transcribe.py into Postgres.
//
// Usage:
//   tsx src/ingest/clipwise.ts <transcript.json>
//
// The transcript file is the payload written by recorder/transcribe.py:
//   { inputs, downsampled, model, labels, segments: [...] }
// Each segment has { track: "me"|"them", start_ms, end_ms, text }.
//
// Writes rows shaped to match Fathom-imported recordings (nulls where
// the existing rows leave nulls, so downstream queries see one convention
// rather than two). Speakers are `me` and `them`, derived purely from the
// segment's `track` field. Extraction is a separate step (server extract
// CLI) — this script does not run it.
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
import { count, eq, sql } from "drizzle-orm";
import { db, schema, pool } from "../db/index.js";
import { slugify } from "../lib/slug.js";

type Segment = {
  track: "me" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

type Transcript = {
  inputs?: { tap?: string; mic?: string };
  downsampled?: { tap_16k?: string; mic_16k?: string };
  model?: string;
  labels?: string[];
  segments: Segment[];
};

function die(msg: string): never {
  process.stderr.write(`ingest: ${msg}\n`);
  process.exit(1);
}

// Convert the ISO stamp used in transcribe output filenames
// ("2026-08-07T12-23-54Z") into a real ISO-8601 timestamp
// ("2026-08-07T12:23:54Z"). Only the time portion has "-" swapped
// for ":" — the date already uses "-".
function stampToIso(stamp: string): string | null {
  const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
}

async function main(): Promise<void> {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) die("usage: tsx src/ingest/clipwise.ts <transcript.json>");

  const raw = readFileSync(transcriptPath, "utf8");
  const doc = JSON.parse(raw) as Transcript;
  if (!Array.isArray(doc.segments) || doc.segments.length === 0) {
    die(`no segments in ${transcriptPath}`);
  }

  const labelSet = new Set(doc.segments.map((s) => s.track));
  if (labelSet.size !== 2 || !labelSet.has("me") || !labelSet.has("them")) {
    die(
      `expected labels {me, them}; got {${[...labelSet].sort().join(", ")}}`,
    );
  }

  const stampMatch = basename(transcriptPath).match(
    /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)/,
  );
  const stamp = stampMatch ? stampMatch[1] : null;
  const startedAtIso = stamp ? stampToIso(stamp) : null;
  const startedAt = startedAtIso ? new Date(startedAtIso) : undefined;

  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    die(
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
  const declared = {
    turnCount: doc.segments.length,
    bodyChars: doc.segments.reduce((n, s) => n + s.text.length, 0),
  };

  process.stdout.write(
    `ingest: account=${account.id} (${account.slug}) title=${JSON.stringify(title)} slug=${slug}\n`,
  );
  process.stdout.write(
    `ingest: declared turnCount=${declared.turnCount} bodyChars=${declared.bodyChars} labels=${[...labelSet].sort().join(",")}\n`,
  );

  const result = await db.transaction(async (tx) => {
    const [recording] = await tx
      .insert(schema.recordings)
      .values({
        accountId: account.id,
        slug,
        title,
        source: "clipwise-recorder",
        sourceId: stamp ?? basename(transcriptPath),
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

    const speakerByLabel = new Map<string, string>();
    for (const label of ["me", "them"] as const) {
      const [inserted] = await tx
        .insert(schema.speakers)
        .values({ recordingId: recording.id, label })
        .returning();
      speakerByLabel.set(label, inserted.id);
    }

    const segmentRows = doc.segments.map((s, idx) => ({
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
    die(
      `fidelity mismatch — declared ${declared.turnCount}/${declared.bodyChars}, observed ${observedTurns}/${observedChars}`,
    );
  }

  process.stdout.write(`\nrecording_id: ${result.recording.id}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
