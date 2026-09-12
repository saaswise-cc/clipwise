// An identity answer written to disk, correctly deferred past ingest, and
// never applied (SAA-173). The log for the one known instance
// (2026-09-02T15-30-17Z) shows apply-identity finding no recording row yet
// and deferring correctly — "ingest will read the answer when it gets
// there" — and ingest then not reading it. Nothing malfunctioned at the
// point of failure; the defect is that the handoff has no completion path
// and nothing reports a miss. This is that report, modeled on
// check-name-duplicates.ts (SAA-169): a small script, run deliberately,
// comparing two sources — the identity-*.json files on disk against the
// attendees rows in the database — rather than requiring the cause to be
// known first.
//
// Usage:
//   tsx src/pipeline/check-identity-applied.ts <capture_dir>
//
// Exit code 0: every identity answer whose recording exists has attendee
// rows. Exit code 1: at least one does not — printed to stdout. This never
// applies anything itself; server/src/pipeline/apply-identity.ts is the
// existing tool for that, unaffected by this script.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import {
  attendeeRowsFrom,
  findRecordingForCapture,
  readIdentityAnswer,
  type IdentityAnswer,
} from "../ingest/identity.js";
import { db, pool, schema } from "../db/index.js";

export type UnappliedAnswer = {
  stem: string;
  recordingId: string;
  file: string;
  expectedRows: number;
};

export type PendingAnswer = {
  stem: string;
  file: string;
};

export type CheckResult = {
  filesScanned: number;
  pending: PendingAnswer[];
  unapplied: UnappliedAnswer[];
};

// Every identity-<stem>.json in `dir`, parsed. Malformed or unreadable
// files are skipped rather than failing the whole check — the same
// tolerance readIdentityAnswer already applies to a single file, extended
// to a directory scan.
function listIdentityFiles(dir: string): Array<{ stem: string; file: string; answer: IdentityAnswer }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ stem: string; file: string; answer: IdentityAnswer }> = [];
  for (const file of readdirSync(dir)) {
    const match = /^identity-(.+)\.json$/.exec(file);
    if (!match) continue;
    const stem = match[1];
    const answer = readIdentityAnswer(dir, stem);
    if (!answer) continue;
    out.push({ stem, file, answer });
  }
  return out;
}

export async function checkIdentityApplied(accountId: string, captureDir: string): Promise<CheckResult> {
  const files = listIdentityFiles(captureDir);
  const pending: PendingAnswer[] = [];
  const unapplied: UnappliedAnswer[] = [];

  for (const { stem, file, answer } of files) {
    const expected = attendeeRowsFrom(answer);
    // An answer with nothing to record (self skipped, no guests) has
    // nothing to check for — attendeeRowsFrom's own emptiness is the
    // correct outcome, not a miss.
    if (expected.length === 0) continue;

    if (!answer.recording_id) continue; // malformed, not this script's problem to fix

    const recordingId = await findRecordingForCapture(accountId, CLIPWISE_SOURCE, answer.recording_id);
    if (!recordingId) {
      // Ingest has not reached this capture yet. Deferral working as
      // designed, not (yet) the defect — reported separately so it is
      // visible without being mistaken for the same failure.
      pending.push({ stem, file });
      continue;
    }

    const rows = await db
      .select({ id: schema.attendees.id })
      .from(schema.attendees)
      .where(eq(schema.attendees.recordingId, recordingId));

    if (rows.length === 0) {
      unapplied.push({ stem, recordingId, file, expectedRows: expected.length });
    }
  }

  return { filesScanned: files.length, pending, unapplied };
}

async function main(): Promise<void> {
  const captureDir = process.argv[2];
  if (!captureDir) {
    process.stderr.write("usage: tsx src/pipeline/check-identity-applied.ts <capture_dir>\n");
    process.exitCode = 2;
    return;
  }

  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }

  const { filesScanned, pending, unapplied } = await checkIdentityApplied(accounts[0].id, captureDir);
  process.stdout.write(`check-identity-applied: ${filesScanned} identity file(s) scanned\n`);
  if (pending.length > 0) {
    process.stdout.write(
      `check-identity-applied: ${pending.length} pending (recording not yet ingested — not a defect): ` +
        `${pending.map((p) => p.stem).join(", ")}\n`,
    );
  }
  if (unapplied.length === 0) {
    process.stdout.write("check-identity-applied: no unapplied identity answers found\n");
    return;
  }
  process.stdout.write(`check-identity-applied: ${unapplied.length} unapplied answer(s) found:\n`);
  for (const u of unapplied) {
    process.stdout.write(
      `  stem=${u.stem} recording=${u.recordingId} file=${u.file} expected_rows=${u.expectedRows} actual_rows=0\n`,
    );
  }
  process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(
      `check-identity-applied: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
