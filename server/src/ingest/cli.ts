// CLI wrapper over ingestTranscript.
//
// Usage:
//   tsx src/ingest/cli.ts <transcript.json>
//
// Owns process.exit and pool.end so the library remains importable
// without side effects. Prints the recording id on the last line, the
// same shape the previous single-file entry point printed.

import { ingestTranscript } from "./clipwise.js";
import { pool } from "../db/index.js";

async function main(): Promise<void> {
  const transcriptPath = process.argv[2];
  if (!transcriptPath) {
    process.stderr.write("ingest: usage: tsx src/ingest/cli.ts <transcript.json>\n");
    process.exit(1);
  }
  const result = await ingestTranscript(transcriptPath);
  process.stdout.write(`\nrecording_id: ${result.recordingId}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`ingest: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
