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
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { runCollapse, type CollapseInput, type CollapseResult } from "./collapse.js";
import { embedMomentsByIds } from "./embeddings.js";

// Sonnet 4.6 — matches prior extraction cost profile (~$0.30-0.50/call).
const MODEL = "claude-sonnet-4-6";

const TOPIC_SEGMENTATION_SYSTEM = `You are indexing a conversation, not summarizing it. Your output is the seed for extraction, so coverage matters more than salience.

Read the transcript and enumerate every distinct topic span. A "span" is a contiguous range of segments about one thing. Prefer more spans over fewer: personal chat, weekend plans, brief tangents, side jokes, and process asides all get their own spans. If two people talk about the board deck for eight minutes and then the same two people talk about hiring, that's two spans, not one.

Do not merge related topics into a single span "for tidiness." The extractor downstream will fail to surface anything you fold together here.

Emit spans in document order. Each span references a contiguous range of segment indices from the input.`;

const MOMENT_EXTRACTION_SYSTEM = `You are extracting the moments inside one topic span. A moment records one distinct claim, decision, question, commitment, initiative, or personnel assessment.

Aim for the SMALLEST number of moments that captures what was actually said in the span. One moment per distinct claim — not one per sentence, not one per exchange, not one per restatement. Two sentences making the same point are one moment. A single argument developed across three turns is one moment. Restatements, illustrating examples, and rephrasings do not each get their own moment. If two moments in your draft would say the same thing in different words, merge them into one better-worded moment before emitting.

Prefer fewer moments over more. A note-taker jotting the distinct takeaways from this span would write a small number, not one bullet per sentence.

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

Zero moments is a valid answer if the span is pure filler. Otherwise, err on the side of one strong moment rather than several thin ones.`;

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
  preCollapseMomentCount: number;
  // Number of moments visible after collapse — i.e. reps + singletons.
  // Nothing is actually deleted; losers stay in the DB with
  // metadata.collapsed_into, filtered out by the harness / search.
  // Distinct from preCollapseMomentCount which is the rows-written count.
  momentsVisibleAfterCollapse: number;
  collapseGroupCount: number;
  momentsInCollapseGroups: number;
  collapseDroppedCount: number;
  collapseBackstops: {
    outOfRangeDropped: number;
    collisionsDropped: number;
    groupsDiscarded: number;
    representativesReplaced: number;
  };
  personnelAssessmentCount: number;
  outOfRangeCount: number;
  tilingGaps: number;
  tilingOverlaps: number;
  elapsedMs: number;
};

export async function runExtraction(
  recordingId: string,
  options: { applyCollapse?: boolean } = {},
): Promise<ExtractionResult> {
  const applyCollapseStep = options.applyCollapse ?? true;
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
  // In-memory buffer of everything we insert per-span, keyed by insert
  // order. Used to hand a flat list to the collapse step and to identify
  // exact DB rows to update on collapse commit. The DB is the durable
  // record — this array is only for building the collapse plan.
  const buffered: BufferedMoment[] = [];
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
      console.log(
        `extract: span ${i}/${spans.length - 1} "${span.label}" — 0 moments (visible gap) — running total ${buffered.length}`,
      );
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
    const insertedRows = await db
      .insert(schema.moments)
      .values(rows)
      .returning({ id: schema.moments.id });
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      buffered.push({
        id: insertedRows[k].id,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        startSec: r.startSec,
        endSec: r.endSec,
        spanLabel: span.label,
        isPersonnelAssessment: r.isPersonnelAssessment,
        metadata: r.metadata,
      });
    }
    console.log(
      `extract: span ${i}/${spans.length - 1} "${span.label}" — ${moments.length} moment(s) — running total ${buffered.length}`,
    );
  }
  if (outOfRange > 0) {
    console.warn(`extract: ${outOfRange} moment(s) had out-of-range offsets, clamped to span bounds`);
  }

  const preCollapseCount = buffered.length;
  console.log(`extract: pre-collapse — ${preCollapseCount} moment(s) inserted under run ${runUuid}`);

  const collapse = applyCollapseStep
    ? await runAndApplyCollapse(client, runUuid, buffered)
    : ({
        groups: [],
        keptIndices: new Set(buffered.map((_, i) => i)),
        droppedCount: 0,
        backstops: {
          outOfRangeDropped: 0,
          collisionsDropped: 0,
          groupsDiscarded: 0,
          representativesReplaced: 0,
        },
      } satisfies CollapseResult);
  if (!applyCollapseStep) {
    console.log(`extract: collapse SKIPPED (--no-collapse) — ${preCollapseCount} raw moments visible`);
  }

  // Embed the moments this run just produced. Decide the id set from
  // the same branch that produced `collapse`, not from keptIndices on
  // the object — the no-collapse fallback happens to populate that
  // field correctly today, but relying on it means a future edit to
  // the fallback silently reduces this to a no-op that logs "0
  // embedded" and reads as a clean run.
  //
  // Post-collapse ordering is a trade, not a free choice. Embedding
  // before collapse would leave losers already vectorised, so a later
  // resetCollapseMarkers() call (SAA-80) would surface them as
  // searchable with no further work. Embedding after saves the tokens
  // for those losers now, at the cost that a later collapse reset
  // needs a fresh sweep — new Voyage spend, and the losers are
  // unsearchable in the window between reset and sweep. The sweep in
  // embeddings.ts is the recovery path; anyone resetting collapse
  // should run it afterwards or search will look thin.
  //
  // Verified against collapse.ts:16-18 — collapse is lexical, does not
  // read moment.embedding, so ordering is safe to defer.
  const idsToEmbed = applyCollapseStep
    ? [...collapse.keptIndices].map((i) => buffered[i].id)
    : buffered.map((b) => b.id);
  const embedResult = await embedMomentsByIds(idsToEmbed);
  console.log(
    `extract: embeddings — ${embedResult.embedded} embedded, ${embedResult.failed} failed (retry via sweep), ${embedResult.skipped} skipped (empty title+summary)`,
  );

  const finalPersonnelCount = await personnelCountForRun(recordingId, runUuid);

  // Promote this run to `current_extraction_run` on the recording. The
  // search gate (routes/moments.ts:110) joins on
  //   moment.metadata.extraction_run = recording.metadata.current_extraction_run
  // so without this write, every moment this run just produced is
  // unreachable via search_moments — regardless of source.
  //
  // Done at the very end, after collapse and embed, on purpose: this is
  // the only durable statement in the whole function that says "this run
  // succeeded." If any earlier step fails, the recording stays pointed at
  // whatever run was previously current, and the failed run's rows remain
  // queryable outside the gate for inspection but do not become visible.
  //
  // Merge into existing metadata rather than replacing it — recordings
  // may carry other keys (transcript source paths, capture stamps, etc.)
  // that this update must not clobber.
  await db
    .update(schema.recordings)
    .set({
      metadata: sql`coalesce(${schema.recordings.metadata}, '{}'::jsonb) || jsonb_build_object('current_extraction_run', ${runUuid}::text)`,
    })
    .where(eq(schema.recordings.id, recordingId));
  console.log(
    `extract: promoted current_extraction_run = ${runUuid} on recording ${recordingId}`,
  );

  return {
    runUuid,
    spans,
    spansYieldingZeroMoments: zeroYield,
    preCollapseMomentCount: preCollapseCount,
    momentsVisibleAfterCollapse: preCollapseCount - collapse.droppedCount,
    collapseGroupCount: collapse.groups.length,
    momentsInCollapseGroups: collapse.groups.reduce((n, g) => n + g.indices.length, 0),
    collapseDroppedCount: collapse.droppedCount,
    collapseBackstops: collapse.backstops,
    personnelAssessmentCount: finalPersonnelCount,
    outOfRangeCount: outOfRange,
    tilingGaps: gaps.length,
    tilingOverlaps: overlaps.length,
    elapsedMs: Date.now() - t0,
  };
}

// In-memory record of an inserted moment. Carries the DB id so the
// collapse commit can target exact rows by primary key.
type BufferedMoment = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  startSec: number;
  endSec: number;
  spanLabel: string;
  isPersonnelAssessment: boolean;
  metadata: Record<string, unknown>;
};

async function personnelCountForRun(recordingId: string, runUuid: string): Promise<number> {
  const rows = await db
    .select({ id: schema.moments.id })
    .from(schema.moments)
    .where(
      and(
        eq(schema.moments.recordingId, recordingId),
        sql`${schema.moments.metadata}->>'extraction_run' = ${runUuid}`,
        sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
        eq(schema.moments.isPersonnelAssessment, true),
      ),
    );
  return rows.length;
}

// Runs the collapse step against the buffered moments and applies the
// plan to the DB (UPDATE reps with merged_from + OR'd personnel flag;
// UPDATE losers with collapsed_into = <rep_id>). Both mutations are
// soft-marker changes only — no DELETEs — so a wrong run UUID never
// destroys data and a re-collapse is free after a reset.
async function runAndApplyCollapse(
  client: Anthropic,
  runUuid: string,
  buffered: BufferedMoment[],
): Promise<CollapseResult> {
  if (buffered.length < 2) {
    console.log(`extract: collapse — skipping (only ${buffered.length} moment(s) in run)`);
    return {
      groups: [],
      keptIndices: new Set(buffered.map((_, i) => i)),
      droppedCount: 0,
      backstops: {
        outOfRangeDropped: 0,
        collisionsDropped: 0,
        groupsDiscarded: 0,
        representativesReplaced: 0,
      },
    };
  }

  const inputs: CollapseInput[] = buffered.map((m) => ({
    kind: m.kind,
    title: m.title,
    summary: m.summary,
    startSec: m.startSec,
    endSec: m.endSec,
    spanLabel: m.spanLabel,
  }));

  console.log(`extract: collapse — grouping ${buffered.length} moments`);
  let plan: CollapseResult;
  try {
    plan = await runCollapse(client, inputs);
  } catch (err) {
    console.error(
      `extract: collapse FAILED — raw extraction is intact in DB (run ${runUuid}, ${buffered.length} moments). Re-run 'run.ts collapse <recording_id> --run ${runUuid}' to retry.`,
    );
    throw err;
  }
  console.log(
    `extract: collapse — ${plan.groups.length} groups covering ${plan.groups.reduce((n, g) => n + g.indices.length, 0)} moments; ${plan.droppedCount} to be marked collapsed_into representatives`,
  );
  const b = plan.backstops;
  console.log(
    `extract: collapse backstops — out-of-range: ${b.outOfRangeDropped}, collisions: ${b.collisionsDropped}, groups discarded: ${b.groupsDiscarded}, reps replaced: ${b.representativesReplaced}`,
  );

  await applyCollapse(runUuid, buffered, plan);
  return plan;
}

// Apply the collapse plan to the DB (soft-delete only):
// - UPDATE each representative: metadata.merged_from = [<loser ids>].
// - UPDATE each loser: metadata.collapsed_into = <rep id>.
// Runs in a single transaction. Losers stay in the DB — search_moments
// and the harness filter them out by the presence of collapsed_into.
//
// The is_personnel_assessment column is NOT mutated here. Each row's
// flag continues to describe THAT row only. A consumer wanting the
// merged personnel view walks metadata.merged_from and ORs the losers'
// flags itself. This keeps re-collapse fully reversible via
// resetCollapseMarkers — otherwise the OR would ratchet the flag true
// permanently across iterations.
export async function applyCollapse(
  runUuid: string,
  buffered: BufferedMoment[],
  plan: CollapseResult,
): Promise<void> {
  if (plan.groups.length === 0) return;

  type RepUpdate = { id: string; metadata: Record<string, unknown> };
  type LoserUpdate = { id: string; metadata: Record<string, unknown> };
  const repUpdates: RepUpdate[] = [];
  const loserUpdates: LoserUpdate[] = [];
  const seenIds = new Set<string>();

  for (const group of plan.groups) {
    const rep = buffered[group.representativeIndex];
    if (!rep) throw new Error(`collapse apply: representative index ${group.representativeIndex} out of bounds`);
    const droppedMoments = group.indices
      .filter((i) => i !== group.representativeIndex)
      .map((i) => {
        const m = buffered[i];
        if (!m) throw new Error(`collapse apply: dropped index ${i} out of bounds`);
        return m;
      });
    repUpdates.push({
      id: rep.id,
      metadata: { ...rep.metadata, merged_from: droppedMoments.map((m) => m.id) },
    });
    for (const m of droppedMoments) {
      if (seenIds.has(m.id)) {
        throw new Error(
          `collapse apply: loser ${m.id} appears in two groups; aborting to keep raw extraction intact under ${runUuid}`,
        );
      }
      seenIds.add(m.id);
      loserUpdates.push({
        id: m.id,
        metadata: { ...m.metadata, collapsed_into: rep.id },
      });
    }
  }

  await db.transaction(async (tx) => {
    for (const u of repUpdates) {
      await tx
        .update(schema.moments)
        .set({ metadata: u.metadata, updatedAt: sql`now()` })
        .where(eq(schema.moments.id, u.id));
    }
    for (const u of loserUpdates) {
      await tx
        .update(schema.moments)
        .set({ metadata: u.metadata, updatedAt: sql`now()` })
        .where(eq(schema.moments.id, u.id));
    }
  });
  console.log(
    `extract: collapse applied — ${repUpdates.length} rep(s) tagged merged_from, ${loserUpdates.length} loser(s) tagged collapsed_into`,
  );
}

// Reset collapse markers on all moments in the given run. Removes
// metadata.merged_from and metadata.collapsed_into. Used by
// runCollapseOnly before re-collapse so iteration on the collapse prompt
// stays free and reversible.
export async function resetCollapseMarkers(recordingId: string, runUuid: string): Promise<number> {
  const rows = await db
    .select({ id: schema.moments.id, metadata: schema.moments.metadata })
    .from(schema.moments)
    .where(
      and(
        eq(schema.moments.recordingId, recordingId),
        sql`${schema.moments.metadata}->>'extraction_run' = ${runUuid}`,
      ),
    );
  let touched = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const meta = (r.metadata as Record<string, unknown> | null) ?? {};
      if (!("merged_from" in meta) && !("collapsed_into" in meta)) continue;
      const cleaned: Record<string, unknown> = { ...meta };
      delete cleaned.merged_from;
      delete cleaned.collapsed_into;
      await tx
        .update(schema.moments)
        .set({ metadata: cleaned, updatedAt: sql`now()` })
        .where(eq(schema.moments.id, r.id));
      touched++;
    }
  });
  return touched;
}

// Standalone collapse over an existing extraction run. Non-destructive:
// resets any prior collapse markers on the run, then runs collapse.
// Safe to point at any run UUID — nothing is deleted. Used to iterate
// on the collapse prompt without re-extracting.
export async function runCollapseOnly(
  recordingId: string,
  runUuid: string,
): Promise<CollapseResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic();

  const resetCount = await resetCollapseMarkers(recordingId, runUuid);
  console.log(`extract: collapse-only — reset markers on ${resetCount} moment(s) in run ${runUuid}`);

  const rows = await db
    .select({
      id: schema.moments.id,
      kind: schema.moments.kind,
      title: schema.moments.title,
      summary: schema.moments.summary,
      startSec: schema.moments.startSec,
      endSec: schema.moments.endSec,
      isPersonnelAssessment: schema.moments.isPersonnelAssessment,
      metadata: schema.moments.metadata,
    })
    .from(schema.moments)
    .where(
      and(
        eq(schema.moments.recordingId, recordingId),
        sql`${schema.moments.metadata}->>'extraction_run' = ${runUuid}`,
      ),
    )
    .orderBy(asc(schema.moments.createdAt), asc(schema.moments.id));

  if (rows.length === 0) {
    throw new Error(`collapse-only: no moments found for recording ${recordingId} run ${runUuid}`);
  }

  const buffered: BufferedMoment[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title ?? "",
    summary: r.summary ?? "",
    startSec: r.startSec,
    endSec: r.endSec,
    spanLabel: ((r.metadata as { span_label?: string } | null) ?? {}).span_label ?? "(unknown span)",
    isPersonnelAssessment: r.isPersonnelAssessment,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  }));

  return runAndApplyCollapse(client, runUuid, buffered);
}
