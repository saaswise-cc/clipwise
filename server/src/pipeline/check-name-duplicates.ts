// Near-duplicate attendee names (SAA-169). The prompt's known-names picker
// stops *new* typos from being minted; it does nothing about the two that
// already existed ("Liillan Dwyer" next to "Lillian Dwyer", "Manual
// Casella" next to "Manuel Casella") and nothing about a future one that
// somehow still gets typed instead of selected. This is the check the issue
// asks for separately: run it periodically and a distinct-name count that
// grows by a one-or-two-character variant is the signal that would have
// caught "Liillan" on the day it happened rather than a week later.
//
// Usage:
//   tsx src/pipeline/check-name-duplicates.ts
//
// Exit code 0: no near-duplicate pair found. Exit code 1: at least one
// found, printed to stdout for a human to look at — this never merges or
// edits anything itself. Whether to merge a real duplicate is a separate
// decision (SAA-169's second open question), made by a person looking at
// the specific pair, not by this script picking a winner.

import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";

// Small counts (tens of names) make the O(n^2) pair check trivial; this
// does not need to scale further than an account's own roster.
function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

// "Differs by one or two characters" (the issue's own phrasing) — distance
// 1 or 2, not 0 (identical names are not a duplicate pair, they are the
// same string) and not larger (unrelated names should not be flagged).
const NEAR_DUPLICATE_MAX_DISTANCE = 2;

export type NearDuplicatePair = { a: string; b: string; distance: number };

export async function findNearDuplicateNames(accountId: string): Promise<{
  distinctCount: number;
  pairs: NearDuplicatePair[];
}> {
  const rows = await db
    .selectDistinct({ name: schema.attendees.name })
    .from(schema.attendees)
    .innerJoin(schema.recordings, eq(schema.recordings.id, schema.attendees.recordingId))
    .where(and(eq(schema.recordings.accountId, accountId), isNotNull(schema.attendees.name)));

  const names = rows.map((r) => r.name as string).sort();
  const pairs: NearDuplicatePair[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const distance = levenshtein(names[i].toLowerCase(), names[j].toLowerCase());
      if (distance > 0 && distance <= NEAR_DUPLICATE_MAX_DISTANCE) {
        pairs.push({ a: names[i], b: names[j], distance });
      }
    }
  }
  return { distinctCount: names.length, pairs };
}

async function main(): Promise<void> {
  const accounts = await db.select().from(schema.accounts);
  if (accounts.length !== 1) {
    throw new Error(
      `expected exactly one account; found ${accounts.length}. Set an explicit account when this stops being the case.`,
    );
  }
  const { distinctCount, pairs } = await findNearDuplicateNames(accounts[0].id);
  process.stdout.write(`check-name-duplicates: ${distinctCount} distinct attendee name(s)\n`);
  if (pairs.length === 0) {
    process.stdout.write("check-name-duplicates: no near-duplicate pairs found\n");
    return;
  }
  process.stdout.write(`check-name-duplicates: ${pairs.length} near-duplicate pair(s) found:\n`);
  for (const p of pairs) {
    process.stdout.write(`  distance ${p.distance}: ${JSON.stringify(p.a)} / ${JSON.stringify(p.b)}\n`);
  }
  process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(
      `check-name-duplicates: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
