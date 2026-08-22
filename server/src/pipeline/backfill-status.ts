// One-shot: give the recordings that predate SAA-134 the terminal status they
// earned.
//
// SAA-134 made the promotion statement write status/ended_at/duration_sec, but
// only going forward. Every recording processed before it shipped still reads
// `pending` with both other columns null, even though it completed and carries
// a promoted `current_extraction_run`. Marking those `ready` states something
// already true.
//
// This exists because SAA-136's recovery loop enumerates captures that never
// reached a terminal state. Left alone, the entire pre-SAA-134 history answers
// that description and the loop would re-extract all of it — the one thing
// SAA-136's second verification condition forbids, since a re-run replaces a
// healthy recording's visible set with a differently-worded, smaller one.
//
// The promoted-run condition is the whole safety property. A recording without
// `current_extraction_run` never finished a run and must keep reading pending,
// so the loop can pick it up. Today no such row exists, which makes the
// condition protective rather than load-bearing — but it is the difference
// between backfilling a fact and asserting one, so it stays.
//
// Idempotent: re-running matches nothing, because the rows it would match no
// longer read `pending`.
//
// Usage:
//   tsx src/pipeline/backfill-status.ts [--apply]
//
// Without --apply it reports what it would change and writes nothing.

import { and, isNotNull, ne, sql } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
import { CAPTURE_DURATION_SEC } from "../extract/extract.js";

const TERMINAL = "ready";

// The same pair of conditions in both the count and the update, so what gets
// reported and what gets written cannot drift.
const ELIGIBLE = and(
  ne(schema.recordings.status, TERMINAL),
  isNotNull(sql`${schema.recordings.metadata}->>'current_extraction_run'`),
);

async function census(): Promise<
  { status: string; n: number; promoted: number; withEnded: number; withDuration: number }[]
> {
  const rows = await db
    .select({
      status: schema.recordings.status,
      n: sql<number>`count(*)::int`,
      promoted: sql<number>`count(*) FILTER (WHERE ${schema.recordings.metadata}->>'current_extraction_run' IS NOT NULL)::int`,
      withEnded: sql<number>`count(*) FILTER (WHERE ${schema.recordings.endedAt} IS NOT NULL)::int`,
      withDuration: sql<number>`count(*) FILTER (WHERE ${schema.recordings.durationSec} IS NOT NULL)::int`,
    })
    .from(schema.recordings)
    .groupBy(schema.recordings.status)
    .orderBy(sql`count(*) DESC`);
  return rows;
}

function report(label: string, rows: Awaited<ReturnType<typeof census>>): void {
  console.log(`\n=== ${label} ===`);
  console.log("  status      count  promoted  ended_at  duration_sec");
  for (const r of rows) {
    console.log(
      `  ${r.status.padEnd(10)} ${String(r.n).padStart(5)} ${String(r.promoted).padStart(9)} ` +
        `${String(r.withEnded).padStart(9)} ${String(r.withDuration).padStart(13)}`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  report("before", await census());

  // Counted separately and loudly: a row with no promoted run is precisely
  // what this must not touch, and printing zero is how that is shown rather
  // than assumed.
  const [{ n: unpromoted }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recordings)
    .where(sql`${schema.recordings.metadata}->>'current_extraction_run' IS NULL`);

  const [{ n: eligible }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recordings)
    .where(ELIGIBLE);

  console.log(`\n  recordings with NO promoted run (must not be touched): ${unpromoted}`);
  console.log(`  recordings eligible for backfill:                      ${eligible}`);

  if (!apply) {
    console.log("\n  dry run — nothing written. Re-run with --apply.");
    return;
  }

  // Same expressions as the promotion in extract.ts, so a backfilled row and a
  // freshly promoted one are indistinguishable afterwards.
  const updated = await db
    .update(schema.recordings)
    .set({
      status: TERMINAL,
      durationSec: sql`coalesce(${CAPTURE_DURATION_SEC}, ${schema.recordings.durationSec})`,
      endedAt: sql`coalesce(
        ${schema.recordings.startedAt} + make_interval(secs => ${CAPTURE_DURATION_SEC}),
        ${schema.recordings.endedAt}
      )`,
    })
    .where(ELIGIBLE)
    .returning({ id: schema.recordings.id });

  console.log(`\n  UPDATE affected ${updated.length} row(s)`);

  report("after", await census());

  const [{ n: stillUnpromoted }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recordings)
    .where(sql`${schema.recordings.metadata}->>'current_extraction_run' IS NULL`);
  const [{ n: flippedWithoutRun }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recordings)
    .where(
      and(
        sql`${schema.recordings.metadata}->>'current_extraction_run' IS NULL`,
        sql`${schema.recordings.status} = ${TERMINAL}`,
      ),
    );
  console.log(`\n  recordings with NO promoted run, after:               ${stillUnpromoted}`);
  console.log(`  of those now marked ${TERMINAL} (must be 0):                 ${flippedWithoutRun}`);
  if (flippedWithoutRun !== 0) {
    throw new Error(
      `backfill marked ${flippedWithoutRun} recording(s) ${TERMINAL} without a promoted run`,
    );
  }
}

main()
  .catch((err) => {
    console.error(`backfill: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
