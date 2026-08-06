// Post-extraction collapse step. Given a flat list of moments from all
// spans, groups near-duplicates and names a representative per group.
// Runs before insert, so only representatives are written to the DB;
// the dropped siblings' key fields are preserved on the representative's
// metadata.merged_from for later inspection.
//
// This is a separate step from the harness clusterer (see harness.ts).
// Own prompt, own tool schema. Uses the same model
// (claude-sonnet-4-6) as the harness clusterer — separation is
// prompt-level only. If this step and the scorer were the same call, the
// before/after would be unfalsifiable (see SAA-80 measurement hazard).
//
// Cross-span AND within-span: input is span-agnostic, so duplicates from
// the same span collapse the same way as cross-span duplicates.
//
// No embeddings — `moment.embedding` is null on the target corpus, and
// the Architecture Decisions doc defers the embedding question. If
// duplicate-density noise proves unreadable, cosine-based collapse is
// the escalation, not the opening move.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

const COLLAPSE_SYSTEM = `You are collapsing near-duplicate moments extracted from a single meeting into a smaller set — one representative per duplicate group.

Two moments are near-duplicates when they record the same underlying claim, decision, question, or observation from the transcript, even if they:
- use different wording
- carry different kinds (a "discussion" and an "observation" about the same point)
- have different timestamps or came from different topic spans
- came from the same span but split one claim across two moments

Two moments are NOT duplicates if they make different claims about the same topic. Example: "The billing system needs a full rewrite" and "The billing system's tax calculation is wrong" are both about billing, but the first is a structural argument and the second is a specific defect — two claims, not one.

For each duplicate group, pick a representative — the moment that best captures the underlying claim (most specific, most complete, best-worded). The other moments in the group will be preserved in metadata for later inspection, but only the representative appears in search results.

Constraints:
- A group has 2 or more indices.
- Every index appears in AT MOST ONE group. A moment cannot belong to two groups.
- representative_index MUST be one of the indices in the group.
- Do NOT emit groups of size 1. A singleton is not a duplicate; leave it alone.
- Prefer under-collapsing over over-collapsing. When in doubt, leave two moments as two moments — losing a distinct claim is worse than surfacing a duplicate.`;

export type CollapseInput = {
  kind: string;
  title: string;
  summary: string;
  startSec: number;
  endSec: number;
  spanLabel: string;
};

export type CollapseGroup = {
  indices: number[];
  representativeIndex: number;
  reason?: string;
};

export type CollapseResult = {
  groups: CollapseGroup[];
  keptIndices: Set<number>;
  droppedCount: number;
  // Backstop counters: how many silent corrections the code made to
  // the model's output. Reported alongside duplicate density so a
  // reader can see whether the score has invisible corrections baked in.
  backstops: {
    outOfRangeDropped: number;   // fabricated / out-of-range indices dropped from the model's output
    collisionsDropped: number;   // indices skipped because a prior group already claimed them
    groupsDiscarded: number;     // groups discarded because they fell below 2 members after backstops
    representativesReplaced: number; // model rep not in group; replaced with min(indices)
  };
};

export async function runCollapse(
  client: Anthropic,
  moments: CollapseInput[],
): Promise<CollapseResult> {
  if (moments.length < 2) {
    const kept = new Set<number>();
    for (let i = 0; i < moments.length; i++) kept.add(i);
    return {
      groups: [],
      keptIndices: kept,
      droppedCount: 0,
      backstops: {
        outOfRangeDropped: 0,
        collisionsDropped: 0,
        groupsDiscarded: 0,
        representativesReplaced: 0,
      },
    };
  }

  const numbered = moments
    .map(
      (m, i) =>
        `#${i}  [${m.kind}]  ${m.title}\n     span: ${m.spanLabel}\n     time: ${m.startSec.toFixed(0)}–${m.endSec.toFixed(0)}s\n     ${m.summary}`,
    )
    .join("\n\n");

  const tool = {
    name: "emit_collapse_groups",
    description:
      "Emit near-duplicate groups. Each group names one representative index; the others will be preserved in metadata but not surfaced.",
    input_schema: {
      type: "object",
      required: ["groups"],
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            required: ["indices", "representative_index"],
            properties: {
              indices: {
                type: "array",
                minItems: 2,
                items: { type: "integer", minimum: 0, maximum: moments.length - 1 },
              },
              representative_index: {
                type: "integer",
                minimum: 0,
                maximum: moments.length - 1,
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
    max_tokens: 8000,
    system: COLLAPSE_SYSTEM,
    tools: [tool as never],
    tool_choice: { type: "tool", name: "emit_collapse_groups" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `MOMENTS (${moments.length}):\n\n${numbered}\n\nEmit near-duplicate groups via emit_collapse_groups. Only groups of 2+; leave singletons alone.`,
          },
        ],
      },
    ],
  });

  const use = resp.content.find((b) => b.type === "tool_use");
  if (!use || use.type !== "tool_use") throw new Error("collapse: no tool_use in response");
  const raw = (use.input as {
    groups: { indices: number[]; representative_index: number; reason?: string }[];
  }).groups;

  // Backstops: dedupe within-group, drop out-of-range indices, enforce
  // one-cluster-per-moment on a first-writer-wins basis, and fall back to
  // min index if the model's representative_index is not in the group.
  // Every silent correction increments a counter so the caller can log
  // it alongside the duplicate-density number.
  const seen = new Set<number>();
  const cleaned: CollapseGroup[] = [];
  let outOfRangeDropped = 0;
  let collisionsDropped = 0;
  let groupsDiscarded = 0;
  let representativesReplaced = 0;
  for (const g of raw) {
    const uniqueClaimed = Array.from(new Set(g.indices));
    const validIndices = uniqueClaimed.filter(
      (i) => Number.isInteger(i) && i >= 0 && i < moments.length,
    );
    outOfRangeDropped += uniqueClaimed.length - validIndices.length;
    const inRange = validIndices.filter((i) => !seen.has(i));
    collisionsDropped += validIndices.length - inRange.length;
    if (inRange.length < 2) {
      if (uniqueClaimed.length >= 2) groupsDiscarded += 1;
      continue;
    }
    for (const i of inRange) seen.add(i);
    let rep = g.representative_index;
    if (!inRange.includes(rep)) {
      rep = Math.min(...inRange);
      representativesReplaced += 1;
    }
    cleaned.push({ indices: inRange, representativeIndex: rep, reason: g.reason });
  }

  const dropped = new Set<number>();
  for (const g of cleaned) {
    for (const i of g.indices) if (i !== g.representativeIndex) dropped.add(i);
  }
  const keptIndices = new Set<number>();
  for (let i = 0; i < moments.length; i++) if (!dropped.has(i)) keptIndices.add(i);
  return {
    groups: cleaned,
    keptIndices,
    droppedCount: dropped.size,
    backstops: {
      outOfRangeDropped,
      collisionsDropped,
      groupsDiscarded,
      representativesReplaced,
    },
  };
}
