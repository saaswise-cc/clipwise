import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { slugify, slugWithSuffix } from "../lib/slug.js";

const createRecordingSchema = z.object({
  title: z.string().max(512).optional(),
  slug: z.string().max(128).optional(),
  source: z.string().max(64).optional(),
  sourceId: z.string().max(256).optional(),
  mediaUrl: z.string().url().max(2048).optional(),
  durationSec: z.number().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  status: z.string().max(32).optional(),
  meetingKind: z.string().max(32).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const createAttendeeSchema = z.object({
  email: z.string().email().max(320).optional(),
  name: z.string().max(256).optional(),
  role: z.string().max(64).optional(),
  domainKind: z.enum(["internal", "external"]).optional(),
  isHost: z.boolean().optional(),
  personId: z.string().uuid().optional(),
});

export const recordingsRouter = Router({ mergeParams: true });

async function ensureAccount(accountId: string): Promise<void> {
  const [account] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!account) throw new HttpError(404, "account_not_found");
}

async function findRecording(accountId: string, recordingId: string) {
  const [recording] = await db
    .select()
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.accountId, accountId),
        eq(schema.recordings.id, recordingId),
      ),
    );
  return recording;
}

recordingsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const body = parseBody(createRecordingSchema, req);
    const slug = body.slug
      ? slugify(body.slug)
      : slugWithSuffix(body.title ?? "recording");
    const [recording] = await db
      .insert(schema.recordings)
      .values({
        accountId,
        slug,
        title: body.title,
        source: body.source,
        sourceId: body.sourceId,
        mediaUrl: body.mediaUrl,
        durationSec: body.durationSec,
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
        status: body.status ?? "pending",
        meetingKind: body.meetingKind,
        metadata: body.metadata,
      })
      .returning();
    res.status(201).json({ recording });
  }),
);

recordingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const recordings = await db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.accountId, accountId))
      .orderBy(desc(schema.recordings.startedAt));
    res.json({ recordings });
  }),
);

recordingsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const recording = await findRecording(req.params.accountId, req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const attendees = await db
      .select()
      .from(schema.attendees)
      .where(eq(schema.attendees.recordingId, recording.id));
    res.json({ recording, attendees });
  }),
);

recordingsRouter.post(
  "/:id/attendees",
  asyncHandler(async (req, res) => {
    const recording = await findRecording(req.params.accountId, req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const body = parseBody(createAttendeeSchema, req);
    const [attendee] = await db
      .insert(schema.attendees)
      .values({
        recordingId: recording.id,
        personId: body.personId,
        email: body.email,
        name: body.name,
        role: body.role,
        domainKind: body.domainKind,
        isHost: body.isHost ?? false,
      })
      .returning();
    res.status(201).json({ attendee });
  }),
);

recordingsRouter.get(
  "/:id/attendees",
  asyncHandler(async (req, res) => {
    const recording = await findRecording(req.params.accountId, req.params.id);
    if (!recording) throw new HttpError(404, "recording_not_found");
    const attendees = await db
      .select()
      .from(schema.attendees)
      .where(eq(schema.attendees.recordingId, recording.id));
    res.json({ attendees });
  }),
);
