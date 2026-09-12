#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ClipwiseClient, loadConfig } from "./client.js";

// Descriptions are shared between the zod schema (used for
// server-side arg validation, .describe() strings never leave the
// process) and the MCP inputSchema literal (which IS what the client
// sees). Keeping them in constants below means the two can't drift
// apart — historically that split was where guidance meant to steer
// callers ended up in the copy nobody reads.

const DESC = {
  searchMomentsTool:
    "Search the Clipwise moments database for the configured account. Two retrieval paths (per Architecture Decision #13, kept separate rather than fused): `query` for lexical/substring matching, `semanticQuery` for cosine-similarity retrieval over embeddings. Pass one or the other, not both. Returns moment metadata plus the recording title so Claude can cite where the moment came from; semantic results also include a similarity score and the producing embedding model. The response also carries `totalMatches` (the true count before `limit` cut it down) and `truncated` (true when `totalMatches` exceeds the returned list). Check `truncated` before concluding something is absent or rare — on a truncated result that conclusion is unsound, and raising `limit` or narrowing the query (e.g. adding `recordingId`) is required first. The response also carries `scope` (the personal/work filter that actually ran) and `scopeDefaulted` (true when `scope` was not passed and \"work\" was applied automatically) — a caller drawing a conclusion like \"there's nothing about X\" should check this before treating it as evidence about personal calls too. A third mode, `index` (SAA-85), enumerates recordings themselves — which meetings existed, with attendees and moment counts by kind, no moment content — for questions like \"what happened last week\" or \"every 1:1 with X\"; see the `index` parameter.",
  query:
    "Lexical search. Case-insensitive substring match against moment title/summary. Best for exact terms — names, product names, dollar figures — where similarity cannot separate them even in principle. A multi-word query ANDs a substring match per word (each word can land in title or summary independently); words need not be contiguous or in order.",
  semanticQuery:
    "Semantic search. Free-text question or description; results are ranked by cosine similarity against moment embeddings. Best for interpretation-heavy queries (what did we decide about X, who pushed back on Y). Returns up to `limit` results with a per-result `similarity` score in [-1,1]. Results always fill up to the limit regardless of relevance because there is no distance floor — you MUST read the similarity score to judge whether a low-ranked result is actually a match, otherwise you will treat unrelated moments as answers. Mutually exclusive with `query` — pass one or the other, not both.",
  recordingId: "Restrict to a single recording (UUID).",
  kind: 'Restrict to a specific moment kind (e.g. "decision", "objection").',
  attendee:
    "Restrict to recordings this person was on. Case-insensitive substring match against the attendee's name — who was in the meeting, not who the moment talks about, so a call where they never came up still matches and a call where they were only mentioned does not. Composes with `query` or `semanticQuery` (both filters apply) and works on its own. Only recordings whose attendee list was captured can match; one with no attendee rows is invisible to this filter rather than an error.",
  limit: "Max results. Defaults to 50.",
  scope:
    'Personal-vs-work filter (SAA-153). One of "work" (default), "personal", or "all". Defaults to "work" when omitted — pass "personal" explicitly to reach personal calls (e.g. the family FaceTime case this was built for), or "all" to search across both. The response echoes back which scope actually ran.',
  index:
    "Recording-level enumeration instead of a moment search (SAA-85). Mutually exclusive with `query`/`semanticQuery` — pass this alone, optionally with `attendee`, `dateFrom`/`dateTo`, `scope` and `recordingId` to narrow which recordings are listed. Use this to answer \"what happened over this period\" or \"list every 1:1 with X\" — questions about which meetings existed, not what was said in them. Returns `recordings` instead of `moments`: each entry has the recording id (needed for get_transcript — otherwise a UUID is only discoverable by accident from a moment result), title, startedAt, durationSec, attendees (guests, not the host), momentCounts (an object keyed by moment kind, e.g. {\"decision\": 2, \"observation\": 5} — a kind with zero moments is simply absent, not present as 0) and totalMoments. Carries no moment title/summary text — this is an index, not a content view; follow up with a regular query scoped to a specific recordingId to read what was actually said. Still respects `truncated`/`totalMatches` and the personal/work `scope` default exactly like a moment search.",
  dateFrom:
    "With `index`: only recordings started at or after this ISO 8601 datetime (e.g. \"2026-09-07T00:00:00Z\"). Combine with dateTo to bound a window; either alone is a valid half-open range.",
  dateTo:
    "With `index`: only recordings started at or before this ISO 8601 datetime. See dateFrom.",
  getTranscriptTool:
    "Fetch the full transcript for a recording, with per-segment timestamps and speaker labels.",
  getTranscriptRecordingId: "The recording to fetch the transcript for (UUID).",
} as const;

const searchMomentsInput = z.object({
  query: z.string().optional().describe(DESC.query),
  semanticQuery: z.string().optional().describe(DESC.semanticQuery),
  recordingId: z.string().uuid().optional().describe(DESC.recordingId),
  kind: z.string().optional().describe(DESC.kind),
  attendee: z.string().min(1).max(256).optional().describe(DESC.attendee),
  limit: z.number().int().min(1).max(200).optional().describe(DESC.limit),
  scope: z.enum(["work", "personal", "all"]).optional().describe(DESC.scope),
  index: z.boolean().optional().describe(DESC.index),
  dateFrom: z.string().optional().describe(DESC.dateFrom),
  dateTo: z.string().optional().describe(DESC.dateTo),
});

const getTranscriptInput = z.object({
  recordingId: z.string().uuid().describe(DESC.getTranscriptRecordingId),
});

async function main(): Promise<void> {
  const client = new ClipwiseClient(loadConfig());
  const server = new Server(
    { name: "clipwise", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_moments",
        description: DESC.searchMomentsTool,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: DESC.query },
            semanticQuery: { type: "string", description: DESC.semanticQuery },
            recordingId: { type: "string", description: DESC.recordingId },
            kind: { type: "string", description: DESC.kind },
            attendee: { type: "string", description: DESC.attendee },
            limit: { type: "number", description: DESC.limit },
            scope: {
              type: "string",
              enum: ["work", "personal", "all"],
              description: DESC.scope,
            },
            index: { type: "boolean", description: DESC.index },
            dateFrom: { type: "string", description: DESC.dateFrom },
            dateTo: { type: "string", description: DESC.dateTo },
          },
        },
      },
      {
        name: "get_transcript",
        description: DESC.getTranscriptTool,
        inputSchema: {
          type: "object",
          properties: {
            recordingId: {
              type: "string",
              description: DESC.getTranscriptRecordingId,
            },
          },
          required: ["recordingId"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "search_moments") {
        const input = searchMomentsInput.parse(args ?? {});
        const result = await client.searchMoments({
          q: input.query,
          semanticQ: input.semanticQuery,
          recordingId: input.recordingId,
          kind: input.kind,
          attendee: input.attendee,
          limit: input.limit,
          scope: input.scope,
          index: input.index,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      if (name === "get_transcript") {
        const input = getTranscriptInput.parse(args ?? {});
        const result = await client.getTranscript(input.recordingId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
