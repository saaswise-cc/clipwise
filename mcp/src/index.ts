#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ClipwiseClient, loadConfig } from "./client.js";

const searchMomentsInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Keyword to match against moment title/summary. Case-insensitive substring match.",
    ),
  recordingId: z
    .string()
    .uuid()
    .optional()
    .describe("Restrict to a single recording."),
  kind: z
    .string()
    .optional()
    .describe('Restrict to a moment kind (e.g. "decision", "objection").'),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
});

const getTranscriptInput = z.object({
  recordingId: z
    .string()
    .uuid()
    .describe("The recording to fetch the transcript for."),
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
        description:
          "Search the Clipwise moments database for the configured account. Returns moment metadata plus the recording title, so Claude can cite where the moment came from.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Keyword to match against moment title/summary. Case-insensitive substring.",
            },
            recordingId: {
              type: "string",
              description: "Restrict to a single recording (UUID).",
            },
            kind: {
              type: "string",
              description:
                'Restrict to a specific moment kind (e.g. "decision", "objection").',
            },
            limit: {
              type: "number",
              description: "Max results. Defaults to 50.",
            },
          },
        },
      },
      {
        name: "get_transcript",
        description:
          "Fetch the full transcript for a recording, with per-segment timestamps and speaker labels.",
        inputSchema: {
          type: "object",
          properties: {
            recordingId: {
              type: "string",
              description: "The recording to fetch the transcript for (UUID).",
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
