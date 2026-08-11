// Thin CLI over runCapturePipeline. This is what the recorder spawns on Stop.
//
// Owns process concerns only — argv, exit code, pool teardown. The pipeline
// itself is a library so a future watcher or upload handler can call it
// without going through a shell.
//
// Usage:
//   tsx src/pipeline/cli.ts <capture_dir> [--stem <stem>] [--force-extract]
//
// Exit code is the contract with the recorder: 0 means moments exist for this
// capture, non-zero means a step failed and pipeline-<stem>.json says which.

import { pool } from "../db/index.js";
import { runCapturePipeline } from "./run-capture.js";

function usage(): never {
  process.stderr.write(
    "usage: tsx src/pipeline/cli.ts <capture_dir> [--stem <stem>] [--force-extract]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir || dir.startsWith("--")) usage();

  let stem: string | undefined;
  let forceExtract = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--stem") {
      stem = argv[++i];
      if (!stem) usage();
    } else if (argv[i] === "--force-extract") {
      forceExtract = true;
    } else {
      process.stderr.write(`pipeline: unknown argument ${argv[i]}\n`);
      usage();
    }
  }

  const result = await runCapturePipeline({ dir, stem, forceExtract });

  process.stdout.write("\n=== pipeline result ===\n");
  process.stdout.write(`stem:              ${result.stem}\n`);
  process.stdout.write(`recording_id:      ${result.recordingId}\n`);
  process.stdout.write(`db_recording_id:   ${result.dbRecordingId}\n`);
  process.stdout.write(`sidecar:           ${result.sidecarPath}\n`);
  if (result.extraction) {
    process.stdout.write(`extraction_run:    ${result.extraction.runUuid}\n`);
    process.stdout.write(
      `moments (visible): ${result.extraction.momentsVisibleAfterCollapse}\n`,
    );
  } else {
    process.stdout.write("extraction:        already complete, not re-run\n");
  }
}

main()
  .catch((err) => {
    process.stderr.write(
      `pipeline: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
