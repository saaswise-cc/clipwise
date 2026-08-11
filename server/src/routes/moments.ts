import { Router } from "express";
import { and, asc, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
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
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
    if (query.q) {
      const like = `%${query.q}%`;
      const textMatch = or(
        ilike(schema.moments.title, like),
        ilike(schema.moments.summary, like),
      );
      if (textMatch) conditions.push(textMatch);
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
        .limit(query.limit ?? 50);
      res.json({ moments: rows });
      return;
    }

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
      .orderBy(desc(schema.moments.createdAt))
      .limit(query.limit ?? 50);

    res.json({ moments: rows });
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