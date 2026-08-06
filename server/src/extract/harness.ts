// Coverage harness for a single extraction run against a Fathom summary.
//
// The denominator is leaf bullets under ## Topics only (see fathom-leaves).
// Key Takeaways restates topics already counted; Next Steps is
// commitments, a different extraction target — both deliberately excluded.
//
// Filter design: coverage is measured on moments whose
// metadata.extraction_run equals the run UUID passed in — NOTHING else.
// metadata.source="extracted" alone would false-pass over yesterday's
// output. Before scoring, we prove the filter can fail by running the
// same filter against a random bogus UUID and asserting zero moments
// returned.
//
// Soft-delete filter: moments with metadata.collapsed_into set are
// merged-away siblings from the collapse step (SAA-80). They stay in
// the DB so a bad merge is inspectable and reversible, but the scorer
// treats them as if deleted. This filter is a no-op on baseline runs
// (which have no collapsed_into markers), so before/after comparability
// against d9dbbcc5 is preserved.
//
// Matching uses 0-based indices into a numbered moment list (never
// UUIDs — the model has been observed to fabricate them). Each leaf is
// assigned at most one moment index or "none".

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { parseFathomLeaves, type Leaf } from "./fathom-leaves.js";

const MODEL = "claude-sonnet-4-6";

const CLUSTER_SYSTEM = `You are grouping near-duplicate moments. Two moments are near-duplicates when they record the same underlying claim, decision, or observation from the transcript — even if wording, kind, or timestamp differs. Two moments about "the same topic" are NOT duplicates if they make different claims about it.

Emit clusters. Each cluster is a set of 0-based indices into the moment list. Only include a cluster if it has 2 or more members. Every moment appears in at most one cluster. Include a short "representative" phrase for each cluster.`;

const MATCH_SYSTEM = `You are matching a list of Fathom summary leaf bullets against a list of extracted moments. For each leaf, decide which moment (if any) best covers it, and how confidently.

Rules:
- A moment covers a leaf when the moment records the same underlying claim from the transcript, even if wording differs.
- Return the 0-based INDEX into the numbered moment list. Never invent an index; if nothing covers, return null.
- Do not double-book: a moment can cover at most one leaf. If two leaves both point at the same moment, keep the better fit and mark the other null.
- Confidence: high (unambiguous), medium (plausible), low (weak fit). If low would feel like a stretch, use null.
- Do not use the leaf text as ground truth for correctness. The leaves are a coverage yardstick only — a leaf can be wrong about what the transcript said and you should still match a moment that faithfully records the transcript's version.`;

type MomentRow = {
  id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  startSec: number;
  endSec: number;
  isPersonnelAssessment: boolean;
  metadata: unknown;
};

async function momentsForRun(runUuid: string, recordingId: string): Promise<MomentRow[]> {
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
        // Soft-delete filter (SAA-80): row-selection change only, no
        // scoring change. No-op on baselines with no collapsed_into.
        sql`(${schema.moments.metadata}->>'collapsed_into') IS NULL`,
      ),
    );
  return rows;
}

type MatchDecision = {
  leafIndex: number;
  momentIndex: number | null;
  confidence: "high" | "medium" | "low" | null;
  reason?: string;
};

async function runClustering(
  client: Anthropic,
  moments: MomentRow[],
): Promise<DuplicateCluster[]> {
  if (moments.length < 2) return [];
  const numbered = moments
    .map(
      (m, i) =>
        `#${i}  [${m.kind}]  ${m.title ?? "(no title)"}\n     ${m.summary ?? ""}`,
    )
    .join("\n");
  const tool = {
    name: "emit_clusters",
    description: "Emit near-duplicate moment clusters.",
    input_schema: {
      type: "object",
      required: ["clusters"],
      properties: {
        clusters: {
          type: "array",
          items: {
            type: "object",
            required: ["indices", "representative"],
            properties: {
              indices: {
                type: "array",
                minItems: 2,
                items: { type: "integer", minimum: 0, maximum: moments.length - 1 },
              },
              representative: { type: "string" },
            },
          },
        },
      },
    },
  } as const;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: CLUSTER_SYSTEM,
    tools: [tool as never],
    tool_choice: { type: "tool", name: "emit_clusters" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `MOMENTS (${moments.length}):\n${numbered}\n\nEmit near-duplicate clusters via emit_clusters. Only groups of 2+.`,
          },
        ],
      },
    ],
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error("clusterer: no tool_use in response");
  const arr = (use.input as { clusters: { indices: number[]; representative: string }[] }).clusters;
  // Backstop: dedupe within-cluster and drop any indices outside the real range.
  const seen = new Set<number>();
  const cleaned: DuplicateCluster[] = [];
  for (const c of arr) {
    const inRange = Array.from(new Set(c.indices)).filter(
      (i) => Number.isInteger(i) && i >= 0 && i < moments.length && !seen.has(i),
    );
    if (inRange.length < 2) continue;
    for (const i of inRange) seen.add(i);
    cleaned.push({ indices: inRange, representative: c.representative });
  }
  return cleaned;
}

async function matchLeaves(
  client: Anthropic,
  leaves: Leaf[],
  moments: MomentRow[],
): Promise<MatchDecision[]> {
  const numberedMoments = moments
    .map(
      (m, i) =>
        `#${i}  [${m.kind}${m.isPersonnelAssessment ? " · personnel" : ""}]  ${m.title ?? "(no title)"}\n     ${m.summary ?? ""}`,
    )
    .join("\n");
  const numberedLeaves = leaves
    .map((l) => `L${l.index}  [${l.section}]  ${l.text}`)
    .join("\n");

  const tool = {
    name: "emit_matches",
    description: "Emit one match decision per leaf.",
    input_schema: {
      type: "object",
      required: ["matches"],
      properties: {
        matches: {
          type: "array",
          minItems: leaves.length,
          maxItems: leaves.length,
          items: {
            type: "object",
            required: ["leaf_index", "moment_index", "confidence"],
            properties: {
              leaf_index: { type: "integer", minimum: 0, maximum: leaves.length - 1 },
              moment_index: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: Math.max(0, moments.length - 1),
              },
              confidence: {
                type: ["string", "null"],
                enum: ["high", "medium", "low", null],
              },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  } as const;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: MATCH_SYSTEM,
    tools: [tool as never],
    tool_choice: { type: "tool", name: "emit_matches" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `MOMENTS (${moments.length}):\n${numberedMoments}`,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `LEAVES (${leaves.length}):\n${numberedLeaves}\n\nEmit one decision per leaf via emit_matches. Enforce the no-double-book rule.`,
          },
        ],
      },
    ],
  });
  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error("matcher: no tool_use in response");
  const arr = (use.input as { matches: unknown[] }).matches;
  return arr.map((m) => {
    const r = m as {
      leaf_index: number;
      moment_index: number | null;
      confidence: "high" | "medium" | "low" | null;
      reason?: string;
    };
    // Backstop: if the model invented an index outside the real range,
    // treat it as null (per prior lesson on fabricated UUIDs; same class).
    let momentIndex = r.moment_index;
    if (momentIndex !== null && (momentIndex < 0 || momentIndex >= moments.length)) {
      momentIndex = null;
    }
    return {
      leafIndex: r.leaf_index,
      momentIndex,
      confidence: r.confidence,
      reason: r.reason,
    };
  });
}

export type DuplicateCluster = { indices: number[]; representative: string };

export type CoveragePass = {
  label: string;
  poolSize: number;
  perLeaf: { leaf: Leaf; passed: boolean; momentIndex: number | null; confidence: string | null }[];
  covered: number;
};

export type CoverageResult = {
  runUuid: string;
  fathomPath: string;
  leaves: Leaf[];
  excludedParents: { text: string; section: string }[];
  ignoredSections: string[];
  filterRegression: { bogusUuid: string; observedMoments: number };
  filterRegressionPassed: boolean;
  total: number;
  momentCount: number;
  duplicateClusters: DuplicateCluster[];
  momentsInClusters: number;
  distinctAfterCollapse: number;
  full: CoveragePass;
  distinctOnly: CoveragePass;
};

export async function runCoverage(
  recordingId: string,
  runUuid: string,
  fathomPath: string,
): Promise<CoverageResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic();

  // Filter regression test: apply the same DB filter with a random UUID
  // that nothing was extracted under. If the filter returns any rows,
  // it's not actually filtering by run.
  const bogusUuid = randomUUID();
  const bogusRows = await momentsForRun(bogusUuid, recordingId);
  const regressionPassed = bogusRows.length === 0;
  console.log(
    `harness: filter regression — bogus uuid ${bogusUuid} returned ${bogusRows.length} moments (${regressionPassed ? "OK" : "FAIL"})`,
  );
  if (!regressionPassed) {
    throw new Error(
      `filter regression FAILED — filter returned ${bogusRows.length} moments for a UUID nothing was extracted under. Coverage results would be untrustworthy.`,
    );
  }

  const { leaves, excludedParents, ignoredSections } = parseFathomLeaves(fathomPath);
  const moments = await momentsForRun(runUuid, recordingId);
  console.log(
    `harness: run ${runUuid} — ${moments.length} moments, ${leaves.length} leaves`,
  );

  const emptyPass = (label: string): CoveragePass => ({
    label,
    poolSize: 0,
    perLeaf: leaves.map((l) => ({ leaf: l, passed: false, momentIndex: null, confidence: null })),
    covered: 0,
  });

  if (moments.length === 0) {
    return {
      runUuid,
      fathomPath,
      leaves,
      excludedParents: excludedParents.map((p) => ({ text: p.text, section: p.section })),
      ignoredSections,
      filterRegression: { bogusUuid, observedMoments: 0 },
      filterRegressionPassed: true,
      total: leaves.length,
      momentCount: 0,
      duplicateClusters: [],
      momentsInClusters: 0,
      distinctAfterCollapse: 0,
      full: emptyPass("all moments"),
      distinctOnly: emptyPass("one representative per cluster"),
    };
  }

  console.log(`harness: clustering ${moments.length} moments for duplicate density`);
  const clusters = await runClustering(client, moments);
  const momentsInClusters = clusters.reduce((n, c) => n + c.indices.length, 0);
  const distinctAfterCollapse = moments.length - momentsInClusters + clusters.length;
  console.log(
    `harness: ${clusters.length} clusters covering ${momentsInClusters} moments; distinct after collapse = ${distinctAfterCollapse}/${moments.length}`,
  );

  // Full pass: match against all moments.
  console.log(`harness: coverage pass 1 — against all ${moments.length} moments`);
  const full = await scorePass(client, "all moments", leaves, moments);

  // Distinct-only pass: keep first index of each cluster + all singletons.
  const dropped = new Set<number>();
  for (const c of clusters) {
    // Keep the lowest index as the surviving representative; drop the rest.
    const kept = Math.min(...c.indices);
    for (const i of c.indices) if (i !== kept) dropped.add(i);
  }
  const distinctMoments = moments.filter((_, i) => !dropped.has(i));
  console.log(
    `harness: coverage pass 2 — against ${distinctMoments.length} distinct moments (dropped ${dropped.size})`,
  );
  const distinctOnly = await scorePass(client, "one representative per cluster", leaves, distinctMoments);

  return {
    runUuid,
    fathomPath,
    leaves,
    excludedParents: excludedParents.map((p) => ({ text: p.text, section: p.section })),
    ignoredSections,
    filterRegression: { bogusUuid, observedMoments: bogusRows.length },
    filterRegressionPassed: true,
    total: leaves.length,
    momentCount: moments.length,
    duplicateClusters: clusters,
    momentsInClusters,
    distinctAfterCollapse,
    full,
    distinctOnly,
  };
}

async function scorePass(
  client: Anthropic,
  label: string,
  leaves: Leaf[],
  moments: MomentRow[],
): Promise<CoveragePass> {
  const matches = await matchLeaves(client, leaves, moments);

  // Enforce no-double-book in code as a backstop.
  const assigned = new Map<number, MatchDecision>();
  for (const dec of matches) {
    if (dec.momentIndex === null) continue;
    const prev = assigned.get(dec.momentIndex);
    const rank = (c: MatchDecision["confidence"]) =>
      c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0;
    if (!prev || rank(dec.confidence) > rank(prev.confidence)) {
      if (prev) {
        prev.momentIndex = null;
        prev.confidence = null;
      }
      assigned.set(dec.momentIndex, dec);
    } else {
      dec.momentIndex = null;
      dec.confidence = null;
    }
  }

  const perLeaf = leaves.map((leaf) => {
    const dec = matches.find((d) => d.leafIndex === leaf.index);
    const passed =
      dec !== undefined &&
      dec.momentIndex !== null &&
      (dec.confidence === "high" || dec.confidence === "medium");
    return {
      leaf,
      passed,
      momentIndex: dec?.momentIndex ?? null,
      confidence: dec?.confidence ?? null,
    };
  });

  const covered = perLeaf.filter((r) => r.passed).length;
  return { label, poolSize: moments.length, perLeaf, covered };
}
