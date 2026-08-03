import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";

const speakerInputSchema = z.object({
  label: z.string().max(128),
  displayName: z.string().max(256).optional(),
  personId: z.string().uuid().optional(),
});

const segmentInputSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1),
  speakerLabel: z.string().max(128).optional(),
  orderIndex: z.number().int().nonnegative().optional(),
});

const importTranscriptSchema = z.object({
  provider: z.string().max(64).optional(),
  language: z.string().max(16).optional(),
  text: z.string().optional(),
  status: z.string().max(32).optional(),
  speakers: z.array(speakerInputSchema).optional(),
  segments: z.array(segmentInputSchema).min(1),
});

export const transcriptRouter = Router();

transcriptRouter.get(
  "/recordings/:id/transcript",
  asyncHandler(async (req, res) => {
    const recordingId = req.params.id;
    const [recording] = await db
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, recordingId));
    if (!recording) throw new HttpError(404, "recording_not_found");

    const [transcript] = await db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.recordingId, recordingId))
      .orderBy(asc(schema.transcripts.createdAt))
      .limit(1);

    if (!transcript) {
      res.json({ transcript: null, segments: [] });
      return;
    }

    const segments = await db
      .select({
        id: schema.segments.id,
        startSec: schema.segments.startSec,
        endSec: schema.segments.endSec,
        text: schema.segments.text,
        speakerLabel: schema.speakers.label,
        speakerDisplayName: schema.speakers.displayName,
      })
      .from(schema.segments)
      .leftJoin(schema.speakers, eq(schema.segments.speakerId, schema.speakers.id))
      .where(eq(schema.segments.transcriptId, transcript.id))
      .orderBy(asc(schema.segments.orderIndex));

    res.json({
      transcript: {
        id: transcript.id,
        provider: transcript.provider,
        language: transcript.language,
        status: transcript.status,
      },
      segments,
    });
  }),
);

transcriptRouter.post(
  "/recordings/:id/transcript",
  asyncHandler(async (req, res) => {
    const recordingId = req.params.id;
    const [recording] = await db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.id, recordingId));
    if (!recording) throw new HttpError(404, "recording_not_found");

    const body = parseBody(importTranscriptSchema, req);
    const speakerInputs = body.speakers ?? [];

    const result = await db.transaction(async (tx) => {
      const [transcript] = await tx
        .insert(schema.transcripts)
        .values({
          recordingId,
          provider: body.provider,
          language: body.language,
          text: body.text,
          status: body.status ?? "ready",
        })
        .returning();

      const speakerByLabel = new Map<string, string>();
      if (speakerInputs.length > 0) {
        const insertedSpeakers = await tx
          .insert(schema.speakers)
          .values(
            speakerInputs.map((s) => ({
              recordingId,
              personId: s.personId,
              label: s.label,
              displayName: s.displayName,
            })),
          )
          .returning();
        for (const s of insertedSpeakers) {
          if (s.label) speakerByLabel.set(s.label, s.id);
        }
      }

      const referencedLabels = new Set(
        body.segments.map((s) => s.speakerLabel).filter((l): l is string => !!l),
      );
      for (const label of referencedLabels) {
        if (!speakerByLabel.has(label)) {
          const [inserted] = await tx
            .insert(schema.speakers)
            .values({ recordingId, label })
            .returning();
          speakerByLabel.set(label, inserted.id);
        }
      }

      const segmentRows = body.segments.map((s, idx) => ({
        accountId: recording.accountId,
        recordingId,
        transcriptId: transcript.id,
        speakerId: s.speakerLabel ? speakerByLabel.get(s.speakerLabel) : undefined,
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.text,
        orderIndex: s.orderIndex ?? idx,
      }));

      const insertedSegments = await tx
        .insert(schema.segments)
        .values(segmentRows)
        .returning({ id: schema.segments.id });

      return {
        transcript,
        speakerCount: speakerByLabel.size,
        segmentCount: insertedSegments.length,
      };
    });

    res.status(201).json(result);
  }),
);
