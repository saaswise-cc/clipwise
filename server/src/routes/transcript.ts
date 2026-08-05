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

// SAA-78. The fidelity declaration a client must send with every
// transcript payload. Counts MUST be taken off the source's raw
// turn/text fields (Fathom transcript_messages, Whisper segments,
// etc.) BEFORE any parsing or normalization — a client that counts
// from the object it's about to POST will declare its own losses
// and pass its own check. `countedFrom` names the field the count
// was taken from so the next client can either match it or notice
// the mismatch loudly.
const sourceFidelitySchema = z.object({
  declaredTurnCount: z.number().int().nonnegative(),
  declaredBodyChars: z.number().int().nonnegative(),
  countedFrom: z.string().min(1).max(512),
});

const importTranscriptSchema = z.object({
  provider: z.string().max(64).optional(),
  language: z.string().max(16).optional(),
  text: z.string().optional(),
  status: z.string().max(32).optional(),
  speakers: z.array(speakerInputSchema).optional(),
  segments: z.array(segmentInputSchema).min(1),
  sourceFidelity: sourceFidelitySchema,
});

// The fidelity counting rule, applied identically on both sides of
// the check. A declaring client using this same rule against its
// source's raw turn/text fields will produce numbers that match a
// faithful server-side count.
//
// Rule (SAA-78):
//   turnCount = number of turns  (one per source turn = one segment)
//   bodyChars = sum over segments of segment.text.length, where
//               .length is JS String length in UTF-16 code units,
//               with NO trimming, NO whitespace normalization, and
//               NO inclusion of speaker labels or timestamps.
//
// Do not change this rule without updating every declaring client at
// the same time — a rule change on one side without the other
// silently re-enables the failure this check exists to catch.
function countObservedFidelity(
  segments: { text: string }[],
): { turnCount: number; bodyChars: number } {
  return {
    turnCount: segments.length,
    bodyChars: segments.reduce((n, s) => n + s.text.length, 0),
  };
}

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

    // Fidelity check runs before any DB work — a mismatch never
    // partially writes. See sourceFidelitySchema for the counting rule.
    const observed = countObservedFidelity(body.segments);
    const declared = body.sourceFidelity;
    if (
      observed.turnCount !== declared.declaredTurnCount ||
      observed.bodyChars !== declared.declaredBodyChars
    ) {
      throw new HttpError(422, "transcript_fidelity_mismatch", {
        declaredTurnCount: declared.declaredTurnCount,
        observedTurnCount: observed.turnCount,
        turnCountDelta: observed.turnCount - declared.declaredTurnCount,
        declaredBodyChars: declared.declaredBodyChars,
        observedBodyChars: observed.bodyChars,
        bodyCharsDelta: observed.bodyChars - declared.declaredBodyChars,
        countedFrom: declared.countedFrom,
      });
    }

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
