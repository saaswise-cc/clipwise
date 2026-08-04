// Two-pass moment extractor. Runs against segments already in the DB for
// a given recording_id, produces moments tagged with a unique
// extraction_run UUID + metadata.source="extracted".
//
// Pass 1: enumerate topic spans over the transcript. This is the coverage
// mechanism — every distinct thread the meeting touched (including short
// tangents and social banter) gets its own span. Coverage is a property
// of segmentation rather than something the model is trusted to volunteer.
//
// Pass 2: for each span, extract every distinct moment. Zero-moment spans
// are logged as visible gaps rather than silently dropped.
//
// Both passes run with the transcript cached in Anthropic's prompt cache
// so per-span cost is output-bound.

import Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";

// Sonnet 4.6 — matches prior extraction cost profile (~$0.30-0.50/call).
const MODEL = "claude-sonnet-4-6";

const TOPIC_SEGMENTATION_SYSTEM = `You are indexing a conversation, not summarizing it. Your output is the seed for extraction, so coverage matters more than salience.

Read the transcript and enumerate every distinct topic span. A "span" is a contiguous range of segments about one thing. Prefer more spans over fewer: personal chat, weekend plans, brief tangents, side jokes, and process asides all get their own spans. If two people talk about the board deck for eight minutes and then the same two people talk about hiring, that's two spans, not one.

Do not merge related topics into a single span "for tidiness." The extractor downstream will fail to surface anything you fold together here.

Emit spans in document order. Each span references a contiguous range of segment indices from the input.`;

const MOMENT_EXTRACTION_SYSTEM = `You are extracting the moments inside one topic span. Emit every distinct claim, decision, question, commitment, initiative, or personnel assessment made in this span. Prefer more moments over fewer; a discussion of five points is five moments, not one.

Moment kinds:
- decision — a conclusion reached, an action committed
- discussion — a topic being worked through, without a firm decision
- question — an open question or unknown flagged
- commitment — someone commits to do something (name the person)
- initiative — a plan or project spanning beyond this meeting
- observation — a factual claim about the world, the business, or a person
- tangent — off-topic content worth recording (weekend plans, jokes, banter)

Separately, set is_personnel_assessment=true when a moment is candid commentary about a named colleague's performance, ability, fit, or behaviour. The boolean is independent of kind — a personnel assessment is typically also an observation or discussion.

For each moment, name the speaker(s) if known and give a start/end offset in seconds within the span.

Zero moments is a valid answer if the span is pure filler. Do not force moments; but if the span contains any distinct claim, extract it.`;

type Segment = {
  orderIndex: number;
  startSec: number;
  endSec: number;
  text: string;
  speakerLabel: string | null;
};

async function loadSegments(recordingId: string): Promise<Segment[]> {
  const rows = await db
    .select({
      orderIndex: schema.segments.orderIndex,
      startSec: schema.segments.startSec,
      endSec: schema.segments.endSec,
      text: schema.segments.text,
      speakerLabel: schema.speakers.label,
    })
    .from(schema.segments)
    .leftJoin(schema.speakers, eq(schema.segments.speakerId, schema.speakers.id))
    .where(eq(schema.segments.recordingId, recordingId))
    .orderBy(asc(schema.segments.orderIndex));
  return rows.map((r) => ({
    orderIndex: r.orderIndex,
    startSec: r.startSec,
    endSec: r.endSec,
    text: r.text,
    speakerLabel: r.speakerLabel ?? null,
  }));
}

function renderTranscript(segs: Segment[]): string {
  return segs
    .map((s) => {
      const mm = Math.floor(s.startSec / 60);
      const ss = Math.floor(s.startSec % 60)
        .toString()
        .padStart(2, "0");
      const sp = s.speakerLabel ?? "?";
      return `[#${s.orderIndex} ${mm}:${ss}] ${sp}: ${s.text}`;
    })
    .join("\n");
}

async function loadRecording(recordingId: string): Promise<{ accountId: string; title: string | null }> {
  const [row] = await db
    .select({
      accountId: schema.recordings.accountId,
      title: schema.recordings.title,
    })
    .from(schema.recordings)
    .where(eq(schema.recordings.id, recordingId));
  if (!row) throw new Error(`recording ${recordingId} not found`);
  return { accountId: row.accountId, title: row.title };
}

type Span = {
  label: string;
  startSegmentIndex: number;
  endSegmentIndex: number;
};

type ExtractedMoment = {
  kind: string;
  title: string;
  summary: string;
  startSec: number;
  endSec: number;
  speakers: string[];
  isPersonnelAssessment: boolean;
  offsetsClamped?: boolean;
  offsetsOriginal?: { start_sec: number; end_sec: number };
};

async function runPass1(
  client: Anthropic,
  transcriptRendered: string,
  segCount: number,
): Promise<Span[]> {
  const tool = {
    name: "emit_spans",
    description: "Emit the ordered list of topic spans identified in the transcript.",
    input_schema: {
      type: "object",
      required: ["spans"],
      properties: {
        spans: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["label", "start_segment_index", "end_segment_index"],
            properties: {
              label: { type: "string" },
              start_segment_index: { type: "integer", minimum: 0, maximum: segCount - 1 },
              end_segment_index: { type: "integer", minimum: 0, maximum: segCount - 1 },
            },
          },
        },
      },
    },
  } as const;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: TOPIC_SEGMENTATION_SYSTEM,
    tools: [tool as never],
    tool_choice: { type: "tool", name: "emit_spans" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Transcript follows. Segment indices are shown in the [#N ...] prefix.\n\n" +
              transcriptRendered,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "Enumerate every distinct topic span. Emit them via the emit_spans tool.",
          },
        ],
      },
    ],
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error("pass1: no tool_use in response");
  const spans = (use.input as { spans: Span[] }).spans;
  return spans.map((s) => ({
    label: s.label,
    startSegmentIndex: (s as unknown as { start_segment_index: number }).start_segment_index,
    endSegmentIndex: (s as unknown as { end_segment_index: number }).end_segment_index,
  }));
}

async function runPass2(
  client: Anthropic,
  transcriptRendered: string,
  span: Span,
  segs: Segment[],
): Promise<ExtractedMoment[]> {
  const spanSegs = segs.filter(
    (s) =>
      s.orderIndex >= span.startSegmentIndex &&
      s.orderIndex <= span.endSegmentIndex,
  );
  const spanStart = spanSegs[0]?.startSec ?? 0;
  const spanEnd = spanSegs[spanSegs.length - 1]?.endSec ?? spanStart;

  const tool = {
    name: "emit_moments",
    description: "Emit the moments identified within this topic span.",
    input_schema: {
      type: "object",
      required: ["moments"],
      properties: {
        moments: {
          type: "array",
          items: {
            type: "object",
            required: ["kind", "title", "summary", "start_sec", "end_sec", "is_personnel_assessment", "speakers"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "decision",
                  "discussion",
                  "question",
                  "commitment",
                  "initiative",
                  "observation",
                  "tangent",
                ],
              },
              title: { type: "string" },
              summary: { type: "string" },
              // Offsets are validated in code, not schema — bounding via
              // schema would reject a whole tool call when a moment sits
              // on a span's last turn whose fabricated end_sec spills into
              // the next span (see SAA-79). Better to log out-of-range
              // and clamp than to lose the moment.
              start_sec: { type: "number", minimum: 0 },
              end_sec: { type: "number", minimum: 0 },
              is_personnel_assessment: { type: "boolean" },
              speakers: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  } as const;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: MOMENT_EXTRACTION_SYSTEM,
    tools: [tool as never],
    tool_choice: { type: "tool", name: "emit_moments" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Full transcript for reference (each turn prefixed [#N MM:SS] Speaker):\n\n" +
              transcriptRendered,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text:
              `Extract moments from the following span only.\n\n` +
              `Span label: ${span.label}\n` +
              `Segment range: #${span.startSegmentIndex} through #${span.endSegmentIndex}\n` +
              `Wall-clock range: ${spanStart.toFixed(0)}s to ${spanEnd.toFixed(0)}s\n\n` +
              `Emit moments via the emit_moments tool. If the span is pure filler, emit an empty array.`,
          },
        ],
      },
    ],
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error("pass2: no tool_use in response");
  const out = (use.input as { moments: unknown[] }).moments;
  return out.map((m) => {
    const r = m as {
      kind: string;
      title: string;
      summary: string;
      start_sec: number;
      end_sec: number;
      is_personnel_assessment: boolean;
      speakers: string[];
    };
    return {
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      startSec: r.start_sec,
      endSec: r.end_sec,
      speakers: r.speakers ?? [],
      isPersonnelAssessment: r.is_personnel_assessment === true,
    };
  });
}

export type ExtractionResult = {
  runUuid: string;
  spans: Span[];
  spansYieldingZeroMoments: Span[];
  momentsInserted: number;
  personnelAssessmentCount: number;
  outOfRangeCount: number;
  tilingGaps: number;
  tilingOverlaps: number;
  elapsedMs: number;
};

export async function runExtraction(recordingId: string): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const t0 = Date.now();
  const client = new Anthropic();
  const recording = await loadRecording(recordingId);
  const segs = await loadSegments(recordingId);
  if (segs.length === 0) {
    throw new Error(`recording ${recordingId} has zero segments — nothing to extract`);
  }
  const rendered = renderTranscript(segs);
  const runUuid = randomUUID();

  console.log(`extract: recording ${recordingId} — ${segs.length} segments`);
  console.log(`extract: run uuid ${runUuid}`);
  console.log(`extract: pass 1 (topic segmentation) starting`);
  const spans = await runPass1(client, rendered, segs.length);
  console.log(`extract: pass 1 emitted ${spans.length} spans`);

  // Assert spans tile [0, segCount-1]. Report gaps and overlaps loudly;
  // do not silently repair — an uncovered range is an invisible coverage
  // hole and the whole point of two-pass is that these are visible.
  const covered = new Array<number>(segs.length).fill(0);
  for (const s of spans) {
    for (let i = s.startSegmentIndex; i <= s.endSegmentIndex; i++) {
      if (i >= 0 && i < segs.length) covered[i]++;
    }
  }
  const gaps: number[] = [];
  const overlaps: number[] = [];
  for (let i = 0; i < covered.length; i++) {
    if (covered[i] === 0) gaps.push(i);
    else if (covered[i] > 1) overlaps.push(i);
  }
  if (gaps.length > 0) {
    console.warn(
      `extract: TILING GAP — ${gaps.length} segment(s) not in any span: ${gaps.slice(0, 20).join(", ")}${gaps.length > 20 ? "..." : ""}`,
    );
  }
  if (overlaps.length > 0) {
    console.warn(
      `extract: TILING OVERLAP — ${overlaps.length} segment(s) in multiple spans: ${overlaps.slice(0, 20).join(", ")}${overlaps.length > 20 ? "..." : ""}`,
    );
  }
  if (gaps.length === 0 && overlaps.length === 0) {
    console.log(`extract: spans tile the transcript cleanly (${segs.length} segments, no gaps or overlaps)`);
  }

  const zeroYield: Span[] = [];
  let inserted = 0;
  let personnelCount = 0;
  let outOfRange = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const moments = await runPass2(client, rendered, span, segs);

    // Validate offsets in code (see schema comment on start_sec/end_sec).
    const spanSegs = segs.filter(
      (s) => s.orderIndex >= span.startSegmentIndex && s.orderIndex <= span.endSegmentIndex,
    );
    const lo = spanSegs[0]?.startSec ?? 0;
    const hi = spanSegs[spanSegs.length - 1]?.endSec ?? lo;
    for (const m of moments) {
      if (m.startSec < lo || m.endSec > hi || m.endSec < m.startSec) {
        outOfRange++;
        console.warn(
          `extract: span ${i} out-of-range moment "${m.title}" start=${m.startSec} end=${m.endSec} (span ${lo}..${hi})`,
        );
        // Preserve the model's original values on the moment so a later
        // reader can distinguish measured from computed. Otherwise this
        // reproduces the SAA-79 failure inside the moment row itself, with
        // the added twist that the bounds we clamp to are also fabricated.
        m.offsetsOriginal = { start_sec: m.startSec, end_sec: m.endSec };
        m.offsetsClamped = true;
        m.startSec = Math.max(lo, Math.min(m.startSec, hi));
        m.endSec = Math.max(m.startSec, Math.min(m.endSec, hi));
      }
    }

    if (moments.length === 0) {
      zeroYield.push(span);
      console.log(`extract: span ${i}/${spans.length - 1} "${span.label}" — 0 moments (visible gap) — running total ${inserted}`);
      continue;
    }
    const rows = moments.map((m) => ({
      accountId: recording.accountId,
      recordingId,
      kind: m.kind,
      title: m.title,
      summary: m.summary,
      startSec: m.startSec,
      endSec: m.endSec,
      isPersonnelAssessment: m.isPersonnelAssessment,
      metadata: {
        source: "extracted",
        extraction_run: runUuid,
        span_label: span.label,
        span_segment_range: [span.startSegmentIndex, span.endSegmentIndex],
        speakers: m.speakers,
        ...(m.offsetsClamped
          ? {
              offsets_clamped: true,
              offsets_original: m.offsetsOriginal,
            }
          : {}),
      },
    }));
    await db.insert(schema.moments).values(rows);
    inserted += rows.length;
    personnelCount += rows.filter((r) => r.isPersonnelAssessment).length;
    console.log(
      `extract: span ${i}/${spans.length - 1} "${span.label}" — ${moments.length} moment(s) — running total ${inserted}`,
    );
  }
  if (outOfRange > 0) {
    console.warn(`extract: ${outOfRange} moment(s) had out-of-range offsets, clamped to span bounds`);
  }

  return {
    runUuid,
    spans,
    spansYieldingZeroMoments: zeroYield,
    momentsInserted: inserted,
    personnelAssessmentCount: personnelCount,
    outOfRangeCount: outOfRange,
    tilingGaps: gaps.length,
    tilingOverlaps: overlaps.length,
    elapsedMs: Date.now() - t0,
  };
}
