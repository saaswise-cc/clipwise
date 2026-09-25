// The answer to "who's speaking?" (SAA-195) on its way to a diarized
// recording's Voice N speakers rows. Mirrors ingest/identity.ts's shape for
// the identity answer — a file written by the recorder, an idempotency
// guard stored on the recording, an apply function that writes speakers —
// because it is the same problem one level down: SAA-194 already produced
// the rows (label = "Voice N", displayName null); this is what names them.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { voiceLabel } from "../pipeline/diarize.js";

export const VOICE_NAMES_VERSION = 1;

export type VoiceNameEntry = {
  voiceIndex: number;
  // null/absent means "Not sure" — SAA-165's correct-or-absent rule again:
  // an unnamed voice is a gap, never a guessed name of any kind.
  name?: string | null;
};

export type VoiceNamesAnswer = {
  voice_names_version?: number;
  recording_id?: string;
  stem?: string;
  answered_at?: string;
  voices?: VoiceNameEntry[] | null;
  // Set only by the "Rename voices…" reopen (SAA-195, most-recent-named-
  // call only). Ordinary first-time naming never sets this, and
  // applyVoiceNames' already-named skip stays exactly as before for it —
  // see the function's own comment for what changes when this is true.
  rename?: boolean;
};

export type VoiceNamingApplication = {
  // displayName is null for a rename-to-"Not sure": an intentional clear,
  // not a skip — the entry did change, just to no name.
  applied: Array<{ voiceIndex: number; displayName: string | null; personId: string | null }>;
  skipped: Array<{ voiceIndex: number; reason: string }>;
};

export function voiceNamesPathFor(dir: string, stem: string): string {
  return join(dir, `voice-names-${stem}.json`);
}

// Never throws — same reasoning as readIdentityAnswer: an unreadable or
// missing answer leaves the voices unnamed, which is survivable and must
// never fail whatever called this.
export function readVoiceNamesAnswer(dir: string, stem: string): VoiceNamesAnswer | null {
  const path = voiceNamesPathFor(dir, stem);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as VoiceNamesAnswer;
    if (!doc || typeof doc !== "object") return null;
    return doc;
  } catch (err) {
    process.stdout.write(`voice-names: ${path} unreadable (${String(err)}) — voices left unnamed\n`);
    return null;
  }
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// Same shape as identity.ts's identityAlreadyApplied: raw string comparison
// of answered_at, stored alongside the identity answer's own metadata key
// rather than a new column (AD #10 — stop rather than a schema change for
// this).
export function voiceNamesAlreadyApplied(metadata: unknown, answer: VoiceNamesAnswer): boolean {
  const stored = (metadata as { voice_names?: VoiceNamesAnswer } | null | undefined)?.voice_names;
  const storedAt = stored?.answered_at;
  const fileAt = answer.answered_at;
  return Boolean(storedAt && fileAt && storedAt === fileAt);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function storeVoiceNamesMetadata(
  executor: typeof db | Tx,
  recordingId: string,
  answer: VoiceNamesAnswer,
): Promise<void> {
  await executor
    .update(schema.recordings)
    .set({
      metadata: sql`coalesce(${schema.recordings.metadata}, '{}'::jsonb) || jsonb_build_object('voice_names', ${JSON.stringify(answer)}::jsonb)`,
    })
    .where(eq(schema.recordings.id, recordingId));
}

// Writes displayName (and, where safe, personId) onto each named voice's
// `speakers` row. "Not sure" and an absent entry both leave a voice
// unnamed — no fallback name of any kind (SAA-165).
//
// personId, consistent with the attendee rows (SAA-191, SAA-128 — read
// first): a chosen name is one of the exact strings the naming window
// offered, which are themselves this recording's own `attendees.name`
// values (SAA-195's step 1 roster) — not a fuzzy match, an exact one
// against data already scoped to this call. Only when that lookup finds a
// row with a non-null person_id is personId copied; a "Someone else…"
// typed name that matches no attendee gets displayName only, exactly the
// same no-invented-person rule applySpeakerNames already uses. Never
// overwrites an existing displayName — a hand correction or an earlier
// pass wins, the same reasoning applySpeakerNames uses for `them` — UNLESS
// answer.rename is set (SAA-195's "Rename voices..." item, the most recent
// named call only). Checked before making this change: yes, this function
// unconditionally skipped any voice whose speakers.displayName was already
// set, for every caller -- there was no path that could ever overwrite a
// name. rename changes that only here: an existing name is overwritten
// with a new one, and a voice renamed to "Not sure" is actively cleared
// (displayName and person_id both set back to null) rather than left as
// whatever it was -- nothing is kept from the old name either way.
export async function applyVoiceNames(
  executor: typeof db | Tx,
  recordingId: string,
  answer: VoiceNamesAnswer,
): Promise<VoiceNamingApplication> {
  const application: VoiceNamingApplication = { applied: [], skipped: [] };
  const entries = answer.voices ?? [];
  if (entries.length === 0) return application;

  const speakers = await executor
    .select({ id: schema.speakers.id, label: schema.speakers.label, displayName: schema.speakers.displayName })
    .from(schema.speakers)
    .where(eq(schema.speakers.recordingId, recordingId));

  const attendees = await executor
    .select({ name: schema.attendees.name, personId: schema.attendees.personId })
    .from(schema.attendees)
    .where(eq(schema.attendees.recordingId, recordingId));
  const attendeeByName = new Map<string, string | null>();
  for (const a of attendees) {
    const key = clean(a.name)?.toLowerCase();
    if (key) attendeeByName.set(key, a.personId);
  }

  const isRename = answer.rename === true;

  for (const entry of entries) {
    const label = voiceLabel(entry.voiceIndex);
    const speaker = speakers.find((s) => s.label === label);
    if (!speaker) {
      application.skipped.push({ voiceIndex: entry.voiceIndex, reason: "the recording has no such speaker row" });
      continue;
    }
    const name = clean(entry.name);
    if (!name) {
      if (isRename && speaker.displayName) {
        // Renamed to "Not sure": an active clear, not the ordinary "leave
        // it unnamed" skip below — the old name and its person_id are both
        // dropped, nothing carried forward.
        await executor
          .update(schema.speakers)
          .set({ displayName: null, personId: null })
          .where(eq(schema.speakers.id, speaker.id));
        application.applied.push({ voiceIndex: entry.voiceIndex, displayName: null, personId: null });
        continue;
      }
      application.skipped.push({ voiceIndex: entry.voiceIndex, reason: "marked not sure — left unnamed" });
      continue;
    }
    if (speaker.displayName && !isRename) {
      application.skipped.push({
        voiceIndex: entry.voiceIndex,
        reason: `already named ${JSON.stringify(speaker.displayName)}`,
      });
      continue;
    }
    const personId = attendeeByName.get(name.toLowerCase()) ?? null;
    await executor
      .update(schema.speakers)
      .set({ displayName: name, personId })
      .where(eq(schema.speakers.id, speaker.id));
    application.applied.push({ voiceIndex: entry.voiceIndex, displayName: name, personId });
  }
  return application;
}

export function describeVoiceNaming(application: VoiceNamingApplication): string {
  const applied = application.applied.length
    ? application.applied.map((a) => `Voice${a.voiceIndex}→${a.displayName ?? "(cleared)"}`).join(", ")
    : "none";
  const skipped = application.skipped.length
    ? ` skipped=${application.skipped.map((s) => `Voice${s.voiceIndex} (${s.reason})`).join(", ")}`
    : "";
  return `applied=${applied}${skipped}`;
}
