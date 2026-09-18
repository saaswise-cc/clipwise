// A calendar match answer, written by the pipeline's "match" step (before
// transcribe) and applied here at ingest — the read/apply half of SAA-115's
// steps 1 & 3. Twin of ingest/identity.ts, but simpler: unlike an identity
// answer, a calendar match is computed synchronously, one pipeline step
// earlier in the same run, so there's no SAA-173-style race to close and no
// separate late-apply entry point is needed.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { titlePlaceholderFor } from "./clipwise.js";

export type CalendarMatchInvitee = {
  email: string;
  name: string | null;
  response_status: string | null;
};

export type CalendarMatch = {
  event_id: string;
  title: string | null;
  recurring_event_id: string | null;
  invitees: CalendarMatchInvitee[];
  offset_ms: number;
};

export function calendarMatchPathFor(dir: string, stem: string): string {
  return join(dir, `calendar-match-${stem}.json`);
}

// Same atomicity as recorder/app/identity-answer.js's writeAnswer: write to
// a .tmp sibling, then rename — a crash mid-write leaves either the old file
// or nothing new, never a half-written JSON.
export function writeCalendarMatch(dir: string, stem: string, match: CalendarMatch): string {
  const finalPath = calendarMatchPathFor(dir, stem);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(match, null, 2) + "\n");
  renameSync(tmpPath, finalPath);
  return finalPath;
}

// Never throws — same reasoning as readIdentityAnswer: an unreadable or
// missing match file leaves the recording unmatched, which is the ordinary
// "nothing to apply" case (no connection, no event in range, or this
// capture predates the feature), not a reason to fail ingest.
export function readCalendarMatch(dir: string, stem: string): CalendarMatch | null {
  const path = calendarMatchPathFor(dir, stem);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as CalendarMatch;
    if (!doc || typeof doc !== "object") return null;
    return doc;
  } catch (err) {
    process.stdout.write(
      `calendar-match: ${path} unreadable (${String(err)}) — recording left unmatched\n`,
    );
    return null;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CalendarMatchApplication = {
  invitees: { inserted: number; updated: number };
  recurringEventId: string | null;
  titleApplied: boolean;
  // Set whenever titleApplied is false, so the two very different reasons
  // for "left alone" are distinguishable in the log rather than reading as
  // the same, unremarkable outcome:
  //   - "custom_title": the recording's title is not placeholder-shaped at
  //     all — the expected, ordinary case once a hand-edit route exists.
  //   - "placeholder_mismatch": the title IS placeholder-shaped but for a
  //     different stem than the one just computed — this should not happen
  //     in the pipeline path (recorder captures always have a stem, so
  //     ingest/clipwise.ts's basename() fallback shouldn't fire here), and
  //     if it does it's a bug worth seeing, not a silently-correct skip.
  //   - "no_title_in_match": the calendar match itself carried no title.
  titleSkipReason: "custom_title" | "placeholder_mismatch" | "no_title_in_match" | null;
};

// stem is required (not derivable from recordingId) to reconstruct the
// ingest-time title placeholder — see the title rule below.
export async function applyCalendarMatch(
  executor: typeof db | Tx,
  accountId: string,
  recordingId: string,
  stem: string,
  match: CalendarMatch,
): Promise<CalendarMatchApplication> {
  let inserted = 0;
  let updated = 0;

  for (const invitee of match.invitees) {
    // People-row linking is a lookup only, never a create. An invitee who
    // declined or never responded must not become a resolvable identity in
    // the known-names picker (SAA-180), which already degrades with every
    // person added — that signal comes from actual attendance, not an
    // invite. personId stays null unless a person already exists for this
    // email via the attendees/identity-prompt path.
    const [person] = await executor
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(eq(schema.people.accountId, accountId), eq(schema.people.email, invitee.email)));

    const [existingInvitee] = await executor
      .select({ id: schema.invitees.id })
      .from(schema.invitees)
      .where(
        and(
          eq(schema.invitees.recordingId, recordingId),
          eq(schema.invitees.email, invitee.email),
        ),
      );

    await executor
      .insert(schema.invitees)
      .values({
        recordingId,
        personId: person?.id ?? null,
        email: invitee.email,
        name: invitee.name,
        responseStatus: invitee.response_status,
      })
      .onConflictDoUpdate({
        target: [schema.invitees.recordingId, schema.invitees.email],
        set: {
          name: invitee.name,
          responseStatus: invitee.response_status,
          personId: person?.id ?? null,
        },
      });

    if (existingInvitee) updated += 1;
    else inserted += 1;
  }

  if (match.recurring_event_id) {
    await executor
      .update(schema.recordings)
      .set({ recurringEventId: match.recurring_event_id })
      .where(eq(schema.recordings.id, recordingId));
  }

  // Title-overwrite rule: every recording's title is set at ingest to the
  // literal placeholder built by titlePlaceholderFor (ingest/clipwise.ts —
  // the single, shared builder, called from both places rather than two
  // hand-written copies of "Clipwise capture — " with an em dash that could
  // drift apart by a character with no visible symptom) and there is no
  // route today that lets a person hand-edit an existing recording's
  // title. So "overwrite only if it still equals that exact placeholder"
  // replaces the raw stem with the real event title (SAA-135) without
  // risking a hand-set title later.
  let titleApplied = false;
  let titleSkipReason: CalendarMatchApplication["titleSkipReason"] = null;
  if (match.title) {
    const placeholder = titlePlaceholderFor(stem);
    // "" is not a real stem, but titlePlaceholderFor("") yields exactly the
    // fixed prefix ("Clipwise capture — ") with nothing appended — used
    // here only to test "does this look placeholder-shaped at all", without
    // hand-writing the em dash a second time.
    const placeholderPrefix = titlePlaceholderFor("");
    const [recording] = await executor
      .select({ title: schema.recordings.title })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, recordingId));
    if (recording?.title === placeholder) {
      await executor
        .update(schema.recordings)
        .set({ title: match.title })
        .where(eq(schema.recordings.id, recordingId));
      titleApplied = true;
    } else if (recording?.title?.startsWith(placeholderPrefix)) {
      // Placeholder-shaped but for a different stem than the one just
      // computed. Shouldn't happen on the pipeline path — recorder
      // captures always carry a stem, so ingest/clipwise.ts's
      // basename(transcriptPath) fallback (used only when a transcript is
      // ingested with no stamp at all) shouldn't be in play here. If this
      // fires anyway, it's a real bug — a stem-resolution mismatch between
      // ingest time and calendar-match apply time — and it must announce
      // itself rather than look like an ordinary, correctly-skipped
      // hand-set title.
      titleSkipReason = "placeholder_mismatch";
      process.stdout.write(
        `calendar-match: WARNING title placeholder mismatch for recording=${recordingId} — ` +
          `expected ${JSON.stringify(placeholder)}, found ${JSON.stringify(recording.title)}. ` +
          "Not overwriting.\n",
      );
    } else {
      titleSkipReason = "custom_title";
    }
  } else {
    titleSkipReason = "no_title_in_match";
  }

  return {
    invitees: { inserted, updated },
    recurringEventId: match.recurring_event_id ?? null,
    titleApplied,
    titleSkipReason,
  };
}

export function describeCalendarMatchApplication(app: CalendarMatchApplication): string {
  const title = app.titleApplied ? "applied" : `skipped (reason=${app.titleSkipReason})`;
  return (
    `invitees inserted=${app.invitees.inserted} updated=${app.invitees.updated}, ` +
    `recurring_event_id=${app.recurringEventId ? "set" : "none"}, ` +
    `title_${title}`
  );
}
