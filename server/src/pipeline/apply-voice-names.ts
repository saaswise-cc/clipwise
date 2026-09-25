// Apply a voice-naming answer (SAA-195) to a capture diarize already split.
// Same shape as apply-identity.ts, one level later: that file applies "who
// was on the call" after ingest; this applies "who's speaking" after
// diarize, and re-runs moment generation afterward so the names actually
// reach a fresh set of moments (Stage 0's finding: moments store speakers
// as text written once, so renaming a voice alone never reaches an
// existing moment — re-extraction is the only path there).
//
// Usage:
//   tsx src/pipeline/apply-voice-names.ts <capture_dir> --stem <stem>

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

import { db, pool, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import { findRecordingForCapture } from "../ingest/identity.js";
import {
  applyVoiceNames,
  describeVoiceNaming,
  readVoiceNamesAnswer,
  storeVoiceNamesMetadata,
  voiceNamesAlreadyApplied,
  type VoiceNamesAnswer,
  type VoiceNamingApplication,
} from "../ingest/voice-names.js";
import { runExtraction } from "../extract/extract.js";

function usage(): never {
  process.stderr.write(
    "usage: tsx src/pipeline/apply-voice-names.ts <capture_dir> --stem <stem>\n",
  );
  process.exit(2);
}

// Does this answer, taken on its own, name or clear at least one voice?
// Read from the answer rather than from applyVoiceNames' applied/skipped
// result so it gives the same yes/no on a retry after a crash as it did on
// the attempt that crashed — an entry the DB already carries (from that
// earlier attempt) reports as "skipped" the second time, not "applied",
// but the answer's own content hasn't changed. "Not sure" only counts as
// clearing when answer.rename is set (an active clear of a previous name);
// an ordinary "not sure" on first naming leaves nothing to extract.
function answerNamesOrClearsAVoice(answer: VoiceNamesAnswer): boolean {
  const entries = answer.voices ?? [];
  if (entries.length === 0) return false;
  const isRename = answer.rename === true;
  return entries.some((e) => {
    const name = typeof e.name === "string" ? e.name.trim() : "";
    return name.length > 0 || isRename;
  });
}

function readManifestRecordingId(dir: string, stem: string): string {
  const path = join(dir, `manifest-${stem}.json`);
  if (!existsSync(path)) throw new Error(`no manifest at ${path}`);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { recording_id?: string };
  if (!doc.recording_id) throw new Error(`manifest ${path} has no recording_id`);
  return doc.recording_id;
}

export type ApplyVoiceNamesResult =
  | { status: "no_answer" }
  | { status: "pending"; sourceId: string }
  | { status: "already_applied"; recordingId: string }
  | {
      status: "applied";
      recordingId: string;
      naming: VoiceNamingApplication;
      extractionRunUuid: string | null;
    };

// Single entry point, used by this file's CLI and by recover.ts's sweep —
// same reason apply-identity.ts's applyIdentityForCapture is: the recorder
// spawns this once when the naming window saves, but cannot know whether
// that spawn actually lands (app quit, machine slept), so recovery calls it
// unconditionally on every pass too, and voiceNamesAlreadyApplied is what
// keeps a repeat call a cheap no-op rather than a re-extraction every time.
export async function applyVoiceNamesForCapture(
  dir: string,
  stem: string,
): Promise<ApplyVoiceNamesResult> {
  const answer = readVoiceNamesAnswer(dir, stem);
  if (!answer) return { status: "no_answer" };

  const sourceId = readManifestRecordingId(dir, stem);

  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }

  const recordingId = await findRecordingForCapture(accounts[0].id, CLIPWISE_SOURCE, sourceId);
  if (!recordingId) {
    return { status: "pending", sourceId };
  }

  const [row] = await db
    .select({ metadata: schema.recordings.metadata })
    .from(schema.recordings)
    .where(eq(schema.recordings.id, recordingId));
  if (voiceNamesAlreadyApplied(row?.metadata, answer)) {
    console.log(`apply-voice-names: already applied for stem=${stem} — skipping`);
    return { status: "already_applied", recordingId };
  }

  const naming = await applyVoiceNames(db, recordingId, answer);

  // Re-run moment generation so the names reach a real set of moments
  // (Stage 0: re-extraction adds a fresh, currently-visible batch rather
  // than deleting anything — the same machinery the pipeline itself uses,
  // applyCollapse defaulted true as it always is).
  //
  // Gated on the answer's own content (does it name or clear at least one
  // voice), not on naming.applied.length: a retry after runExtraction
  // throws below re-runs applyVoiceNames against speakers that already
  // carry the new name from the crashed attempt, so those entries land in
  // `skipped` rather than `applied` even though extraction still needs to
  // (re)run for them. Reading the answer directly instead of the result
  // of applying it covers that retry, and the "rename to Not sure" clear
  // the same way, with no special-casing.
  let extractionRunUuid: string | null = null;
  if (answerNamesOrClearsAVoice(answer)) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log(
        "apply-voice-names: names applied, but ANTHROPIC_API_KEY is not set — moments not re-extracted",
      );
      await storeVoiceNamesMetadata(db, recordingId, answer);
    } else {
      const extraction = await runExtraction(recordingId);
      extractionRunUuid = extraction.runUuid;
      // Recorded as applied only now that extraction has actually
      // succeeded — not right after writing the speakers rows. If
      // runExtraction throws above, this line is never reached, so
      // voiceNamesAlreadyApplied stays false and the next sweep
      // (recover.ts, unconditional on every pass) retries the whole
      // thing, extraction included (SAA-193's crash left exactly this
      // gap: names renamed, moments stale, never retried).
      await storeVoiceNamesMetadata(db, recordingId, answer);
    }
  } else {
    console.log("apply-voice-names: nothing newly named — moments not re-extracted");
    await storeVoiceNamesMetadata(db, recordingId, answer);
  }

  return { status: "applied", recordingId, naming, extractionRunUuid };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dirArg = argv[0];
  if (!dirArg || dirArg.startsWith("--")) usage();
  let stem: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--stem") {
      stem = argv[++i];
      if (!stem) usage();
    } else {
      process.stderr.write(`apply-voice-names: unknown argument ${argv[i]}\n`);
      usage();
    }
  }
  if (!stem) usage();

  const dir = resolve(dirArg);
  const result = await applyVoiceNamesForCapture(dir, stem);

  if (result.status === "no_answer") {
    process.stdout.write(`apply-voice-names: no voice-names-${stem}.json in ${dir} — nothing to apply\n`);
    return;
  }
  if (result.status === "pending") {
    process.stdout.write(
      `apply-voice-names: no recording yet for source_id=${result.sourceId} — nothing to apply to yet\n`,
    );
    return;
  }
  if (result.status === "already_applied") {
    process.stdout.write(`apply-voice-names: recording=${result.recordingId} already applied — skipping\n`);
    return;
  }

  process.stdout.write(
    `apply-voice-names: recording=${result.recordingId} ${describeVoiceNaming(result.naming)}\n`,
  );
  process.stdout.write(
    `apply-voice-names: extraction ${result.extractionRunUuid ? `run=${result.extractionRunUuid}` : "not run"}\n`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("apply-voice-names.ts")) {
  main()
    .catch((err) => {
      process.stderr.write(
        `apply-voice-names: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
