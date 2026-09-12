// Apply an identity answer to a capture that has already been ingested.
//
// The ordinary path does not need this: the prompt is answered within seconds
// of the capture stopping, transcription takes minutes, and ingest reads
// identity-<stem>.json when it gets there. This is for the other ordering —
// the prompt left open through a whole transcription and answered afterwards,
// which SAA-114 expects ("a prompt after a call competes with the next
// meeting"). Without this, an answer typed after ingest would be a file on
// disk that nothing ever reads.
//
// The recorder spawns this on every answer rather than deciding which
// ordering it is in. That is deliberate: the recorder cannot know whether the
// detached pipeline has passed ingest, and guessing wrong in one direction
// loses the answer. Running it always is safe because it no-ops when the
// recording row does not exist yet, and inserts only names the recording does
// not already have.
//
// SAA-173: that "safe to always run" property is exactly why recover.ts also
// calls applyIdentityForCapture (below) unconditionally, for every manifest,
// on every recovery pass — not just from the recorder's one-shot spawn right
// after the answer is saved. The one-shot spawn covers the ordinary case
// (transcription still running when the prompt is answered) and the common
// race (ingest already finished by the time the spawn checks). It does not
// cover the tighter race where the recording row does not exist yet *at the
// moment this checks*, defers correctly, and then nothing else ever asks
// again — the exact gap SAA-173 found. Recovery asking again on every launch
// is what closes it, and it costs nothing extra on a recording that already
// has its attendees: applyIdentity/applySpeakerNames/applyScope are each
// idempotent no-ops in that case.
//
// Usage:
//   tsx src/pipeline/apply-identity.ts <capture_dir> --stem <stem>
//
// Exit code 0 means the answer is accounted for — applied, already present, or
// held for an ingest that has not happened yet. Non-zero means it is not.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { db, pool, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import {
  applyIdentity,
  applyScope,
  applySpeakerNames,
  describeMapping,
  describeRows,
  describeScope,
  findRecordingForCapture,
  readIdentityAnswer,
  type IdentityApplication,
  type ScopeApplication,
  type SpeakerMapping,
} from "../ingest/identity.js";

function usage(): never {
  process.stderr.write(
    "usage: tsx src/pipeline/apply-identity.ts <capture_dir> --stem <stem>\n",
  );
  process.exit(2);
}

function readManifestRecordingId(dir: string, stem: string): string {
  const path = join(dir, `manifest-${stem}.json`);
  if (!existsSync(path)) {
    throw new Error(`no manifest at ${path}`);
  }
  const doc = JSON.parse(readFileSync(path, "utf8")) as { recording_id?: string };
  if (!doc.recording_id) {
    throw new Error(`manifest ${path} has no recording_id`);
  }
  return doc.recording_id;
}

export type ApplyIdentityCaptureResult =
  | { status: "no_answer" }
  | { status: "pending"; sourceId: string }
  | {
      status: "applied";
      recordingId: string;
      identity: IdentityApplication;
      speakerMapping: SpeakerMapping;
      scope: ScopeApplication;
    };

// The single entry point for "make this capture's recording match its
// identity-<stem>.json," used by both this file's CLI and recover.ts's
// per-manifest sweep. Safe to call repeatedly and unconditionally — every
// write inside is already guarded against re-applying (applyIdentity's
// takenNames check, applySpeakerNames' already-named skip, applyScope's
// already-classified skip).
export async function applyIdentityForCapture(
  dir: string,
  stem: string,
): Promise<ApplyIdentityCaptureResult> {
  const answer = readIdentityAnswer(dir, stem);
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
    // The expected case when the answer arrives before ingest creates the
    // row. Correct to defer — but see the SAA-173 note above: this alone is
    // not enough, because ingest's own identity read can miss the file too,
    // in the same narrow window. Something has to ask again later; that is
    // what makes recover.ts's unconditional call to this function the fix
    // rather than a restatement of the same assumption.
    return { status: "pending", sourceId };
  }

  const identity = await applyIdentity(db, recordingId, answer);
  const speakerMapping = await applySpeakerNames(db, recordingId, answer);
  const scope = await applyScope(db, recordingId, answer);
  return { status: "applied", recordingId, identity, speakerMapping, scope };
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
      process.stderr.write(`apply-identity: unknown argument ${argv[i]}\n`);
      usage();
    }
  }
  if (!stem) usage();

  const dir = resolve(dirArg);
  const result = await applyIdentityForCapture(dir, stem);

  if (result.status === "no_answer") {
    process.stdout.write(
      `apply-identity: no identity-${stem}.json in ${dir} — nothing to apply\n`,
    );
    return;
  }
  if (result.status === "pending") {
    process.stdout.write(
      `apply-identity: no recording yet for source_id=${result.sourceId} — ` +
        `ingest will read the answer when it gets there\n`,
    );
    return;
  }

  process.stdout.write(
    `apply-identity: recording=${result.recordingId} inserted=${describeRows(result.identity.inserted)} ` +
      `already_present=${describeRows(result.identity.skipped)}\n`,
  );
  process.stdout.write(`apply-identity: speaker names ${describeMapping(result.speakerMapping)}\n`);
  process.stdout.write(`apply-identity: scope ${describeScope(result.scope)}\n`);
}

// Only when run as a CLI — recover.ts imports applyIdentityForCapture and
// must not trigger a second main() (with its own argv parsing and pool.end())
// as a side effect of that import. Same guard recover.ts uses on itself.
if (process.argv[1] && process.argv[1].endsWith("apply-identity.ts")) {
  main()
    .catch((err) => {
      process.stderr.write(
        `apply-identity: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
