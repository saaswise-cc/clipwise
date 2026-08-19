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
  describeRows,
  findRecordingForCapture,
  readIdentityAnswer,
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
  const answer = readIdentityAnswer(dir, stem);
  if (!answer) {
    process.stdout.write(
      `apply-identity: no identity-${stem}.json in ${dir} — nothing to apply\n`,
    );
    return;
  }

  const sourceId = readManifestRecordingId(dir, stem);

  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }

  const recordingId = await findRecordingForCapture(
    accounts[0].id,
    CLIPWISE_SOURCE,
    sourceId,
  );
  if (!recordingId) {
    // The expected case when the answer arrives before the pipeline finishes.
    // Ingest reads the same file itself, so there is nothing to do and nothing
    // wrong.
    process.stdout.write(
      `apply-identity: no recording yet for source_id=${sourceId} — ` +
        `ingest will read the answer when it gets there\n`,
    );
    return;
  }

  const applied = await applyIdentity(db, recordingId, answer);
  process.stdout.write(
    `apply-identity: recording=${recordingId} inserted=${describeRows(applied.inserted)} ` +
      `already_present=${describeRows(applied.skipped)}\n`,
  );
}

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
