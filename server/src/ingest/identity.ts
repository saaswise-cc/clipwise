// The answer to "who was on this call?" on its way to attendee rows (SAA-114).
//
// **Where the answer lives between the two.** A capture stops minutes before
// its recording row exists: the pipeline transcribes first, and ingest is what
// inserts the row. At the moment the question is answered there is nothing in
// the database to attach the answer to, and the recorder holds no connection
// to one. So the answer is written to identity-<stem>.json in the capture
// directory, beside the manifest and the audio — the same place and the same
// durability as the capture itself. The recorder keeps nothing in memory and
// hands nothing to a running process, which is what makes this survive the app
// quitting, the app crashing, or the machine rebooting between the answer and
// the ingest: the file is read when ingest gets there, whenever that is.
//
// **What goes in the columns, and what deliberately does not.** A typed name
// supplies a name. It does not supply an email, and `attendees.email` is
// therefore null — deriving one from a name is what produced the fabricated
// tyler@quorom.io / jon@quorom.io rows in the 2026-08-03 backfill (SAA-109,
// comment of 2026-08-19), and `people` dedupes on (account_id, email), so an
// invented address does not merely sit in a column: it becomes the identity
// key, and the real address later creates a second person instead of matching.
//
// `domain_kind` is null for the same reason one step removed. It is a claim
// about which side of the org someone sits on, and with no email there is no
// evidence for it. The backfill guessed `internal` for all four rows and was
// wrong about Tyler, who is external. Unknown is a value this column can hold;
// a guess is not.
//
// `person_id` is null, and that one is a constraint rather than a preference.
// Linking to `people` means creating a person, and `people_account_email_idx`
// is UNIQUE(account_id, email) — where NULLs are distinct in Postgres, so a
// name-only person row would be created afresh on every capture and the same
// human would fragment into a row per meeting. Name-only attendee rows are
// reachable regardless: SAA-127's filter matches attendees.name OR the linked
// people.name, and takes the first when there is no second.
//
// `is_host` is the one field the answer does not come from the typed names.
// The prompt asks who the call was *with*; the person answering it was on the
// call too, so their own row is written alongside, carrying is_host = true
// while the typed names carry false — the shape the four existing rows already
// use (Jon true, Tyler false).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export const IDENTITY_VERSION = 1;

// Written by the recorder's prompt at stop. `self` is the person who answered
// — name null when they have not told the recorder what they are called, which
// is a row that records attendance without claiming an identity.
export type IdentityAnswer = {
  identity_version?: number;
  recording_id?: string;
  stem?: string;
  answered_at?: string;
  self?: { name?: string | null; source?: string } | null;
  guests?: Array<{ name?: string | null }> | null;
};

export type AttendeeRow = { name: string | null; isHost: boolean };

export type IdentityApplication = {
  inserted: AttendeeRow[];
  // Names already on the recording when this ran. The prompt's answer can
  // reach ingest twice — once through the file ingest reads, once through the
  // apply step the recorder spawns when the answer arrives late — so writing
  // the same person twice is an ordinary case to absorb, not an error.
  skipped: AttendeeRow[];
};

export function identityPathFor(dir: string, stem: string): string {
  return join(dir, `identity-${stem}.json`);
}

// Never throws. An unreadable or malformed answer leaves the recording
// unidentified, which is the same outcome as a dismissed prompt and is
// explicitly survivable; failing ingest over it would let the prompt discard a
// capture, which is the one thing SAA-114 says it must never do.
export function readIdentityAnswer(
  dir: string,
  stem: string,
): IdentityAnswer | null {
  const path = identityPathFor(dir, stem);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as IdentityAnswer;
    if (!doc || typeof doc !== "object") return null;
    return doc;
  } catch (err) {
    process.stdout.write(
      `identity: ${path} unreadable (${String(err)}) — recording left unidentified\n`,
    );
    return null;
  }
}

// Trailing/leading whitespace and empty entries are the typing, not the
// answer. Order is preserved: host first, then the names as they were typed.
export function attendeeRowsFrom(answer: IdentityAnswer): AttendeeRow[] {
  const rows: AttendeeRow[] = [];
  const selfName = clean(answer.self?.name);
  // The host row is written even when the name is unknown. It is the one fact
  // the prompt does not have to ask for — whoever answered was on the call —
  // and dropping it would make a two-person call look like a one-person call.
  if (answer.self !== null && answer.self !== undefined) {
    rows.push({ name: selfName, isHost: true });
  }
  for (const guest of answer.guests ?? []) {
    const name = clean(guest?.name);
    if (!name) continue;
    rows.push({ name, isHost: false });
  }
  return rows;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Insert the answer's rows onto a recording, skipping what is already there.
//
// Idempotent by name (case-insensitive) and, for the host row, by the is_host
// flag: the same answer applied twice adds nothing the second time. There is
// no unique constraint backing this — adding one would be a schema change, and
// AD #10 says stop rather than push — so two writers racing inside the same
// few milliseconds could still both insert. Read-then-insert is honest about
// what it is: the two writers here are ingest and the late-answer apply step,
// and they are seconds to minutes apart in every ordering that actually
// happens.
export async function applyIdentity(
  executor: typeof db | Tx,
  recordingId: string,
  answer: IdentityAnswer,
): Promise<IdentityApplication> {
  const wanted = attendeeRowsFrom(answer);
  const application: IdentityApplication = { inserted: [], skipped: [] };
  if (wanted.length === 0) return application;

  const existing = await executor
    .select({
      name: schema.attendees.name,
      isHost: schema.attendees.isHost,
    })
    .from(schema.attendees)
    .where(eq(schema.attendees.recordingId, recordingId));

  const takenNames = new Set(
    existing
      .map((row) => (row.name ?? "").trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  let hostTaken = existing.some((row) => row.isHost);

  for (const row of wanted) {
    const key = (row.name ?? "").trim().toLowerCase();
    if (key && takenNames.has(key)) {
      application.skipped.push(row);
      continue;
    }
    if (row.isHost && hostTaken) {
      application.skipped.push(row);
      continue;
    }
    await executor.insert(schema.attendees).values({
      recordingId,
      name: row.name,
      // email, domainKind, personId and role are all left unset — see the
      // header. The columns are nullable and null is the honest value.
      isHost: row.isHost,
    });
    if (key) takenNames.add(key);
    if (row.isHost) hostTaken = true;
    application.inserted.push(row);
  }
  return application;
}

// The recording a capture was filed under, or null when ingest has not reached
// it yet. Keyed on (source, source_id) — the same pair ingest dedupes on, so
// this finds exactly the row ingest would adopt.
export async function findRecordingForCapture(
  accountId: string,
  source: string,
  sourceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.recordings.id })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.accountId, accountId),
        eq(schema.recordings.source, source),
        eq(schema.recordings.sourceId, sourceId),
      ),
    );
  return row?.id ?? null;
}

// --- track → name (SAA-129) -----------------------------------------------
//
// A Clipwise capture has two tracks and no diarization, so its speakers are
// `me` and `them` and every moment extracted from it reads "Me argues that…".
// The identity answer makes the mapping arithmetic rather than inference: in a
// 1:1 the host is `me` and the one guest is `them`.
//
// **Only with exactly one named guest.** Two or more and `them` is a mixed
// track — several people sharing one channel — and no assignment to it is
// correct. That is SAA-94's territory and it stays parked; this declines and
// says so rather than picking the first name. The decline covers `me` as well:
// half a mapping, where one track is named and the other is still `them`, is a
// worse artifact than an honest pair of labels.
//
// **display_name, not person_id.** `speakers.person_id` exists and stays null,
// because nothing here can produce a person to point it at safely. Creating
// one is what the SAA-114 note warns about: `people_account_email_idx` is
// UNIQUE(account_id, email) with no NULLS NOT DISTINCT, verified against the
// live index definition, so a name-only person row is unique every time and
// the same human forks into a row per meeting. Matching an existing person by
// name instead is not a safer version of that — `people` has no uniqueness on
// name, two people can share one, and the only rows in it came from the
// backfill whose fabricated emails SAA-109 records. A typed name is a label
// for one recording until something supplies a real key; a calendar address
// (SAA-115) is that key, and person_id can be filled from it later without
// redoing this.
export type SpeakerMapping = {
  applied: Array<{ label: string; displayName: string }>;
  // Named but not written, with the reason — an already-named speaker, or a
  // label the recording does not have.
  skipped: Array<{ label: string; reason: string }>;
  // Set when the whole mapping was refused. Null when it ran.
  declined: string | null;
};

const HOST_LABEL = "me";
const GUEST_LABEL = "them";

export async function applySpeakerNames(
  executor: typeof db | Tx,
  recordingId: string,
  answer: IdentityAnswer,
): Promise<SpeakerMapping> {
  const mapping: SpeakerMapping = { applied: [], skipped: [], declined: null };
  const rows = attendeeRowsFrom(answer);
  const guests = rows.filter((r) => !r.isHost && r.name);
  const host = rows.find((r) => r.isHost && r.name) ?? null;

  if (guests.length !== 1) {
    mapping.declined =
      guests.length === 0
        ? "the answer names no guest — nothing to map `them` to"
        : `the answer names ${guests.length} guests — \`them\` is a mixed track and no assignment to it is correct (SAA-94). Labels left as ${HOST_LABEL}/${GUEST_LABEL}.`;
    return mapping;
  }

  const wanted = new Map<string, string | null>([
    [HOST_LABEL, host?.name ?? null],
    [GUEST_LABEL, guests[0].name],
  ]);

  const speakers = await executor
    .select({
      id: schema.speakers.id,
      label: schema.speakers.label,
      displayName: schema.speakers.displayName,
    })
    .from(schema.speakers)
    .where(eq(schema.speakers.recordingId, recordingId));

  for (const [label, name] of wanted) {
    const speaker = speakers.find((s) => s.label === label);
    if (!speaker) {
      // A capture where one track carried no audio has no speaker row for it
      // — see the label filter in ingest. Not an error.
      mapping.skipped.push({ label, reason: "the recording has no such speaker row" });
      continue;
    }
    if (!name) {
      mapping.skipped.push({ label, reason: "the answer supplies no name for this track" });
      continue;
    }
    if (speaker.displayName) {
      // Something already named this speaker — a hand correction through the
      // PATCH route, or an earlier run. Not overwritten: a later answer is not
      // automatically a better one, and clobbering a correction silently is
      // the failure this is meant to prevent.
      mapping.skipped.push({
        label,
        reason: `already named ${JSON.stringify(speaker.displayName)}`,
      });
      continue;
    }
    await executor
      .update(schema.speakers)
      .set({ displayName: name })
      .where(eq(schema.speakers.id, speaker.id));
    mapping.applied.push({ label, displayName: name });
  }
  return mapping;
}

export function describeMapping(mapping: SpeakerMapping): string {
  if (mapping.declined) return `declined — ${mapping.declined}`;
  const applied = mapping.applied.length
    ? mapping.applied.map((a) => `${a.label}→${a.displayName}`).join(", ")
    : "none";
  const skipped = mapping.skipped.length
    ? ` skipped=${mapping.skipped.map((s) => `${s.label} (${s.reason})`).join(", ")}`
    : "";
  return `applied=${applied}${skipped}`;
}

export function describeRows(rows: AttendeeRow[]): string {
  if (rows.length === 0) return "none";
  return rows
    .map((r) => `${r.name ?? "(unnamed)"}${r.isHost ? " [host]" : ""}`)
    .join(", ");
}
