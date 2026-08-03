import { Router } from "express";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody, parseQuery } from "../lib/http.js";

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

    const conditions = [eq(schema.moments.accountId, accountId)];
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