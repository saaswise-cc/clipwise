import { Router, type Response } from "express";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions/vector";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody, parseQuery } from "../lib/http.js";
import { embed } from "../lib/voyage.js";

const createMomentSchema = z.object({
  recordingId: z.string().uuid(),
  kind: z.string().min(1).max(64),
  title: z.string().max(512).optional(),
  summary: z.string().optional(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  score: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const searchMomentsQuerySchema = z.object({
  q: z.string().optional(),
  // Semantic query text. Mutually exclusive with `q` — see AD #13:
  // "lexical and semantic exposed as separate paths. No fusion, no
  // blended ranking, no mode heuristic." Passing both is a caller bug,
  // not something we silently pick between.
  semantic_q: z.string().max(2048).optional(),
  recordingId: z.string().uuid().optional(),
  kind: z.string().max(64).optional(),
  // Attendee name (SAA-127). Keyed on the name rather than person_id or
  // email because the caller is the capture prompt, which supplies a
  // free-typed name and nothing else — an id-keyed filter has no way to
  // be fed from that side.
  attendee: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // Personal-vs-work classification filter (SAA-153). Defaults to "work"
  // when omitted — see the default-scope handling below for why, and for
  // why the response always echoes which scope actually applied rather
  // than narrowing silently.
  scope: z.enum(["work", "personal", "all"]).optional(),
  // Recording-level enumeration (SAA-85), as a mode of this same tool
  // rather than a separate list_recordings endpoint — settled 2026-09-10.
  // Mutually exclusive with q/semantic_q: this counts and lists recordings,
  // it does not search moment text.
  index: z.coerce.boolean().optional(),
  // Bounds recordings.started_at. Both optional and independent — either
  // alone is a valid half-open range.
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const momentsRouter = Router({ mergeParams: true });

async function ensureAccount(accountId: string): Promise<void> {
  const [account] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!account) throw new HttpError(404, "account_not_found");
}

momentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const body = parseBody(createMomentSchema, req);
    const [recording] = await db
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(
        and(
          eq(schema.recordings.accountId, accountId),
          eq(schema.recordings.id, body.recordingId),
        ),
      );
    if (!recording) throw new HttpError(404, "recording_not_found");

    const [moment] = await db
      .insert(schema.moments)
      .values({
        accountId,
        recordingId: body.recordingId,
        kind: body.kind,
        title: body.title,
        summary: body.summary,
        startSec: body.startSec,
        endSec: body.endSec,
        score: body.score,
        metadata: body.metadata,
      })
      .returning();
    res.status(201).json({ moment });
  }),
);

// Recording-level enumeration (SAA-85). Settled 2026-09-10: a filter within
// search_moments rather than a separate list_recordings tool, returning
// date, attendees, duration and moment counts by kind, with a date-range
// filter. Explicitly the index only — the content view for a bounded
// window is a separate, later step that waits on SAA-153 (personal/work
// separation), per that same discussion. This function only counts and
// lists recordings; it never reads moment title/summary text.
//
// Answers "no enumeration" (the original gap: a 1:1 whose moments never
// matched a substring search was invisible) by listing recordings directly,
// independent of whether any moment inside them matches anything. A
// recording with zero in-scope moments still appears, honestly, rather than
// silently dropping out.
async function runRecordingIndex(
  res: Response,
  accountId: string,
  query: z.infer<typeof searchMomentsQuerySchema>,
): Promise<void> {
  const conditions = [eq(schema.recordings.accountId, accountId)];
  if (query.recordingId) {
    conditions.push(eq(schema.recordings.id, query.recordingId));
  }
  if (query.dateFrom) {
    conditions.push(gte(schema.recordings.startedAt, new Date(query.dateFrom)));
  }
  if (query.dateTo) {
    conditions.push(lte(schema.recordings.startedAt, new Date(query.dateTo)));
  }

  // Same scope filter and default as the moment-search path, and the same
  // reasoning (SAA-153): work by default, disclosed rather than silent,
  // unclassified counts as work. SAA-153's remaining classification work
  // does not gate this — the filter already exists and the index simply
  // respects it, the same way every other recording-scoped query does.
  const resolvedScope = query.scope ?? "work";
  const scopeDefaulted = query.scope === undefined;
  if (resolvedScope === "work") {
    conditions.push(or(isNull(schema.recordings.scope), eq(schema.recordings.scope, "work"))!);
  } else if (resolvedScope === "personal") {
    conditions.push(eq(schema.recordings.scope, "personal"));
  }

  // Attendee filter (SAA-127), same shape as the moment-search path but
  // correlated on recordings.id directly rather than moments.recording_id
  // — this query's base table is recordings, not moments.
  if (query.attendee) {
    const attendeeLike = `%${query.attendee}%`;
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(schema.attendees)
          .leftJoin(schema.people, eq(schema.people.id, schema.attendees.personId))
          .where(
            and(
              eq(schema.attendees.recordingId, schema.recordings.id),
              or(
                ilike(schema.attendees.name, attendeeLike),
                ilike(schema.people.name, attendeeLike),
              ),
            ),
          ),
      ),
    );
  }

  // True match count (SAA-131, SAA-108's pattern, carried over): computed
  // before `limit` cuts the list down, so a caller can tell a complete
  // enumeration from a partial one rather than trusting a list that looks
  // whole.
  const [{ count: totalMatches }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.recordings)
    .where(and(...conditions));

  const limit = query.limit ?? 50;
  const recordingRows = await db
    .select({
      id: schema.recordings.id,
      title: schema.recordings.title,
      startedAt: schema.recordings.startedAt,
      durationSec: schema.recordings.durationSec,
    })
    .from(schema.recordings)
    .where(and(...conditions))
    // Chronological, not round-robin/recency: this is enumeration, not a
    // relevance search, so every row is equally "relevant" and the natural
    // order for a bounded window is the order the meetings happened in.
    .orderBy(asc(schema.recordings.startedAt))
    .limit(limit);

  const recordingIds = recordingRows.map((r) => r.id);
  const attendeesByRecording = new Map<string, string[]>();
  const momentsByRecording = new Map<string, { counts: Record<string, number>; total: number }>();

  if (recordingIds.length > 0) {
    // Host excluded — this lists who the call was *with*, matching the
    // shape the identity prompt already asks for and the shape rendered in
    // the design discussion (never "Jon Dwyer" alongside the guests).
    const attendeeRows = await db
      .select({ recordingId: schema.attendees.recordingId, name: schema.attendees.name })
      .from(schema.attendees)
      .where(
        and(
          inArray(schema.attendees.recordingId, recordingIds),
          eq(schema.attendees.isHost, false),
        ),
      );
    for (const row of attendeeRows) {
      if (!row.name) continue;
      const list = attendeesByRecording.get(row.recordingId) ?? [];
      list.push(row.name);
      attendeesByRecording.set(row.recordingId, list);
    }

    // Same visibility rules search_moments itself applies (SAA-80 soft-
    // delete, SAA-78 current-run gate) — a count that included a collapsed
    // duplicate or a superseded extraction run would overstate what a
    // moment query against these recordings can actually reach, breaking
    // the reason this index exists.
    const kindRows = await db
      .select({
        recordingId: schema.moments.recordingId,
        kind: schema.moments.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.moments)
      .innerJoin(schema.recordings, eq(schema.moments.recordingId, schema.recordings.id))
      .where(
        and(
          inArray(schema.moments.recordingId, recordingIds),
          sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
          sql`((${schema.moments.metadata}->>'source') = 'hand_curated' OR (${schema.moments.metadata}->>'extraction_run') = (${schema.recordings.metadata}->>'current_extraction_run'))`,
        ),
      )
      .groupBy(schema.moments.recordingId, schema.moments.kind);
    for (const row of kindRows) {
      const entry = momentsByRecording.get(row.recordingId) ?? { counts: {}, total: 0 };
      entry.counts[row.kind] = row.count;
      entry.total += row.count;
      momentsByRecording.set(row.recordingId, entry);
    }
  }

  const recordings = recordingRows.map((r) => ({
    id: r.id,
    title: r.title,
    startedAt: r.startedAt,
    durationSec: r.durationSec,
    attendees: attendeesByRecording.get(r.id) ?? [],
    momentCounts: momentsByRecording.get(r.id)?.counts ?? {},
    totalMoments: momentsByRecording.get(r.id)?.total ?? 0,
  }));

  res.json({
    recordings,
    totalMatches,
    truncated: totalMatches > recordings.length,
    scope: resolvedScope,
    scopeDefaulted,
  });
}

momentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const query = parseQuery(searchMomentsQuerySchema, req);

    if (query.q && query.semantic_q) {
      // Explicit rather than picking one silently — AD #13 keeps the two
      // paths separate so evaluation can attribute reachability to the
      // right retrieval mechanism. Blending them behind a caller's back
      // is exactly the fusion this decision defers.
      throw new HttpError(400, "q_and_semantic_q_are_mutually_exclusive");
    }
    if (query.index && (query.q || query.semantic_q)) {
      // Index mode enumerates recordings; it does not search moment text.
      // Combining the two would mean guessing which behaviour the caller
      // wanted, the same reasoning q_and_semantic_q_are_mutually_exclusive
      // already applies one line up.
      throw new HttpError(400, "index_and_query_are_mutually_exclusive");
    }

    if (query.index) {
      await runRecordingIndex(res, accountId, query);
      return;
    }

    // Soft-delete filter (SAA-80): moments merged away by the collapse
    // step carry metadata.collapsed_into = <rep_id> and are hidden from
    // search. They stay in the DB for inspection / rollback via the
    // metadata.merged_from list on the representative.
    //
    // Current-run filter (SAA-78): only surface moments whose
    // metadata.extraction_run matches the joined recording's
    // metadata.current_extraction_run, OR moments carrying
    // metadata.source='hand_curated' (which have no extraction_run).
    // Without this, a recording with multiple extraction runs (e.g.
    // 90b293c7 with 5) returns every historical run's moments stacked
    // together, dominating results by 8x — a corpus-reading problem
    // the marker exists to solve. The whole OR is parenthesized so
    // AND-binding precedence doesn't leak moments past the account
    // scope when this is joined with the other conditions.
    const conditions = [
      eq(schema.moments.accountId, accountId),
      sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
      sql`((${schema.moments.metadata}->>'source') = 'hand_curated' OR (${schema.moments.metadata}->>'extraction_run') = (${schema.recordings.metadata}->>'current_extraction_run'))`,
    ];
    if (query.recordingId) {
      conditions.push(eq(schema.moments.recordingId, query.recordingId));
    }
    if (query.kind) {
      conditions.push(eq(schema.moments.kind, query.kind));
    }
    // Personal-vs-work filter (SAA-153). Defaults to "work" when the
    // caller names no scope: it's the overwhelming majority of use, and
    // the failure mode of leaking a personal call into a work answer is
    // worse than the reverse (a work query missing personal content is
    // one re-query away via scope=all). The response states which scope
    // actually ran (see res.json below) so this default is never silent.
    //
    // A recording with scope IS NULL — every recording predating this
    // column — counts as "work" under the work filter rather than being
    // excluded. Almost the entire existing corpus is unclassified today;
    // treating unclassified as invisible would regress the common case
    // the moment this ships. Only a recording explicitly marked
    // 'personal' is excluded from "work".
    const resolvedScope = query.scope ?? "work";
    const scopeDefaulted = query.scope === undefined;
    if (resolvedScope === "work") {
      conditions.push(
        or(isNull(schema.recordings.scope), eq(schema.recordings.scope, "work"))!,
      );
    } else if (resolvedScope === "personal") {
      conditions.push(eq(schema.recordings.scope, "personal"));
    }
    // resolvedScope === "all" adds no condition.

    // Attendee filter (SAA-127) — the person→call hop. Correlated EXISTS
    // on the moment's recording rather than a join, so a recording with
    // several matching attendee rows still yields each moment once and
    // the row count is unchanged by the filter's presence.
    //
    // Matched against both attendees.name and the linked people.name: an
    // attendee row can carry a null name while still pointing at a person
    // who has one, and the caller cannot know which side holds it. Neither
    // table is written to here, and neither gained a column — AD #10.
    //
    // Substring, case-insensitive, same shape as `q` above: the name comes
    // from a human typing it into the capture prompt, so "tyler" and
    // "Tyler Lang" both have to reach the same calls. The cost is that a
    // short string matches broadly — "an" would sweep in Lang — which is
    // the same bargain `q` already makes.
    if (query.attendee) {
      const attendeeLike = `%${query.attendee}%`;
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.attendees)
            .leftJoin(
              schema.people,
              eq(schema.people.id, schema.attendees.personId),
            )
            .where(
              and(
                eq(schema.attendees.recordingId, schema.moments.recordingId),
                or(
                  ilike(schema.attendees.name, attendeeLike),
                  ilike(schema.people.name, attendeeLike),
                ),
              ),
            ),
        ),
      );
    }
    if (query.q) {
      // SAA-158: this used to run one ILIKE against the whole query
      // string, so a multi-word query only matched a moment where the
      // words appeared contiguously and in that order — a query for two
      // words that are both in the moment's text, just not next to each
      // other, returned zero regardless of what the store contained.
      // Split on whitespace and AND a substring match per word instead
      // (each word can land in either title or summary independently).
      // Still pure substring matching, no ranking or embeddings — AD
      // #13's separation of the lexical and semantic paths is unchanged.
      const words = query.q.split(/\s+/).filter(Boolean);
      for (const word of words) {
        const like = `%${word}%`;
        const wordMatch = or(
          ilike(schema.moments.title, like),
          ilike(schema.moments.summary, like),
        );
        if (wordMatch) conditions.push(wordMatch);
      }
    }

    // Semantic path — separate from substring per AD #13. Return shape
    // matches the substring path apart from the added similarity and
    // embeddingModel fields, so callers can treat rows uniformly; the
    // extras on semantic results are intentional (a threshold picked
    // in advance is tuning without evidence — surface the score and
    // let downstream decide).
    if (query.semantic_q) {
      // input_type=query is load-bearing here. Passing "document" would
      // return valid-looking vectors that retrieve plausibly-but-worse
      // results, with no error and no visible symptom (AD #13). The
      // write-side call site in embeddings.ts passes "document"; the
      // two must stay different.
      const [qvec] = await embed([query.semantic_q], "query");
      // Vector HNSW index (moments_embedding_idx, schema.ts:218) uses
      // vector_cosine_ops; cosineDistance matches that opclass. Passing
      // number[] lets drizzle bind the value as a parameter rather than
      // splicing SQL.
      const distance = cosineDistance(schema.moments.embedding, qvec);
      // Vector index only covers non-null rows; excluding nulls also
      // avoids sorting on NULL distance which pgvector treats as
      // greater than any distance value.
      conditions.push(isNotNull(schema.moments.embedding));

      // True match count (SAA-131, SAA-108): computed against the same
      // `conditions` this query's WHERE uses, before `limit` cuts it down,
      // so a caller can tell a complete result from a page of one.
      const [{ count: totalMatches }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.moments)
        .innerJoin(schema.recordings, eq(schema.moments.recordingId, schema.recordings.id))
        .where(and(...conditions));

      const limit = query.limit ?? 50;
      const rows = await db
        .select({
          id: schema.moments.id,
          recordingId: schema.moments.recordingId,
          kind: schema.moments.kind,
          title: schema.moments.title,
          summary: schema.moments.summary,
          startSec: schema.moments.startSec,
          endSec: schema.moments.endSec,
          score: schema.moments.score,
          metadata: schema.moments.metadata,
          embeddingModel: schema.moments.embeddingModel,
          createdAt: schema.moments.createdAt,
          recordingTitle: schema.recordings.title,
          recordingSlug: schema.recordings.slug,
          // External identity of the recording — for Clipwise captures this
          // is the manifest recording_id. Selected so a moment traces back to
          // the capture it came from without a second round trip.
          recordingSourceId: schema.recordings.sourceId,
          // Cosine similarity = 1 - cosine distance. Voyage vectors are
          // unit-normalised (verified in the pre-check recorded on
          // AD #13), so the range is [-1, 1] with 1 being identical.
          similarity: sql<number>`1 - (${distance})`,
        })
        .from(schema.moments)
        .innerJoin(
          schema.recordings,
          eq(schema.moments.recordingId, schema.recordings.id),
        )
        .where(and(...conditions))
        .orderBy(asc(distance))
        .limit(limit);
      res.json({
        moments: rows,
        totalMatches,
        truncated: totalMatches > rows.length,
        scope: resolvedScope,
        scopeDefaulted,
      });
      return;
    }

    // True match count (SAA-131, SAA-108) — see the semantic branch above
    // for why this runs against `conditions` before `limit` is applied.
    const [{ count: totalMatches }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.moments)
      .innerJoin(schema.recordings, eq(schema.moments.recordingId, schema.recordings.id))
      .where(and(...conditions));

    const limit = query.limit ?? 50;
    const rows = await db
      .select({
        id: schema.moments.id,
        recordingId: schema.moments.recordingId,
        kind: schema.moments.kind,
        title: schema.moments.title,
        summary: schema.moments.summary,
        startSec: schema.moments.startSec,
        endSec: schema.moments.endSec,
        score: schema.moments.score,
        metadata: schema.moments.metadata,
        createdAt: schema.moments.createdAt,
        recordingTitle: schema.recordings.title,
        recordingSlug: schema.recordings.slug,
        recordingSourceId: schema.recordings.sourceId,
      })
      .from(schema.moments)
      .innerJoin(
        schema.recordings,
        eq(schema.moments.recordingId, schema.recordings.id),
      )
      .where(and(...conditions))
      // SAA-108: plain `desc(createdAt)` exhausts the most-recently-extracted
      // recording before a caller ever sees a second one, because moments
      // from one extraction run land within seconds of each other — a
      // query matching 9+ recordings returned all 50 from the newest 1-2.
      // Round-robin by recording instead: rank each recording's own matches
      // by recency (most recent first within that recording), then take
      // every recording's rank-1 moment before any recording's rank-2, and
      // so on. This is ordering, not scoring — no relevance model, nothing
      // AD #13 would call fusion — so a single-recording query (one
      // partition) degenerates to the original createdAt-desc order with
      // nothing dropped, while a multi-recording query gets breadth without
      // thinning out the recordings that actually have many matches (they
      // keep contributing at every round-robin depth).
      .orderBy(
        sql`row_number() over (partition by ${schema.moments.recordingId} order by ${schema.moments.createdAt} desc)`,
        desc(schema.moments.createdAt),
      )
      .limit(limit);

    res.json({
      moments: rows,
      totalMatches,
      truncated: totalMatches > rows.length,
      scope: resolvedScope,
      scopeDefaulted,
    });
  }),
);

momentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    const [moment] = await db
      .select()
      .from(schema.moments)
      .where(
        and(
          eq(schema.moments.accountId, accountId),
          eq(schema.moments.id, req.params.id),
        ),
      );
    if (!moment) throw new HttpError(404, "moment_not_found");
    res.json({ moment });
  }),
);