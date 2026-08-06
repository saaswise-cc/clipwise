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
    "Search the Clipwise moments database for the configured account. Two retrieval paths (per Architecture Decision #13, kept separate rather than fused): `query` for lexical/substring matching, `semanticQuery` for cosine-similarity retrieval over embeddings. Pass one or the other, not both. Returns moment metadata plus the recording title so Claude can cite where the moment came from; semantic results also include a similarity score and the producing embedding model.",
  query:
    "Lexical search. Case-insensitive substring match against moment title/summary. Best for exact terms — names, product names, dollar figures — where similarity cannot separate them even in principle.",
  semanticQuery:
    "Semantic search. Free-text question or description; results are ranked by cosine similarity against moment embeddings. Best for interpretation-heavy queries (what did we decide about X, who pushed back on Y). Returns up to `limit` results with a per-result `similarity` score in [-1,1]. Results always fill up to the limit regardless of relevance because there is no distance floor — you MUST read the similarity score to judge whether a low-ranked result is actually a match, otherwise you will treat unrelated moments as answers. Mutually exclusive with `query` — pass one or the other, not both.",
  recordingId: "Restrict to a single recording (UUID).",
  kind: 'Restrict to a specific moment kind (e.g. "decision", "objection").',
  limit: "Max results. Defaults to 50.",
  getTranscriptTool:
    "Fetch the full transcript for a recording, with per-segment timestamps and speaker labels.",
  getTranscriptRecordingId: "The recording to fetch the transcript for (UUID).",
} as const;

const searchMomentsInput = z.object({
  query: z.string().optional().describe(DESC.query),
  semanticQuery: z.string().optional().describe(DESC.semanticQuery),
  recordingId: z.string().uuid().optional().describe(DESC.recordingId),
  kind: z.string().optional().describe(DESC.kind),
  limit: z.number().int().min(1).max(200).optional().describe(DESC.limit),
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
            limit: { type: "number", description: DESC.limit },
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
          limit: input.limit,
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
