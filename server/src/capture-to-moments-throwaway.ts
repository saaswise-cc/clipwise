// SAA-83 throwaway trigger — capture directory in, moments out, no
// human-copied identifiers in between.
//
// THIS FILE IS DELIBERATELY DISPOSABLE. Delete it when the SAA-72
// recorder-shell decision lands and the recorder/server invocation
// seam is designed (see SAA-83 for why). It has no state, no retry,
// no jobs-table integration, no directory watching. It is glue.
//
// What it does:
//   1. Reads the capture directory.
//   2. Finds the newest stamp that has both system-<stamp>.f32le.pcm
//      and mic-<stamp>.wav.
//   3. If transcript-<stamp>.json is missing, runs recorder/transcribe.py.
//   4. Calls ingestTranscript to insert the recording; keeps the UUID.
//   5. Calls runExtraction with that UUID; keeps the run UUID and count.
//   6. Prints the recording UUID and the moment count.
//
// Usage:
//   tsx src/capture-to-moments-throwaway.ts <capture_dir>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { pool } from "./db/index.js";
import { ingestTranscript } from "./ingest/clipwise.js";
import { runExtraction } from "./extract/extract.js";

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/;

function findLatestStamp(dir: string): string {
  const entries = readdirSync(dir);
  const tapStamps = new Set<string>();
  const micStamps = new Set<string>();
  for (const name of entries) {
    let m = name.match(/^system-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.f32le\.pcm$/);
    if (m && STAMP_RE.test(m[1])) tapStamps.add(m[1]);
    m = name.match(/^mic-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.wav$/);
    if (m && STAMP_RE.test(m[1])) micStamps.add(m[1]);
  }
  const both = [...tapStamps].filter((s) => micStamps.has(s)).sort();
  if (both.length === 0) {
    throw new Error(`no stamp in ${dir} has both a system-*.f32le.pcm and a mic-*.wav`);
  }
  return both[both.length - 1];
}

function transcribeIfMissing(dir: string, stamp: string): string {
  const transcriptPath = join(dir, `transcript-${stamp}.json`);
  if (existsSync(transcriptPath)) {
    process.stdout.write(`trigger: transcript exists → ${transcriptPath}\n`);
    return transcriptPath;
  }
  const tapPath = join(dir, `system-${stamp}.f32le.pcm`);
  const micPath = join(dir, `mic-${stamp}.wav`);
  const transcribePy = resolve(__dirname, "..", "..", "recorder", "transcribe.py");
  if (!existsSync(transcribePy)) {
    throw new Error(`recorder/transcribe.py not found at ${transcribePy}`);
  }
  process.stdout.write(
    `trigger: transcribing → python3 ${transcribePy} ${tapPath} ${micPath} ${transcriptPath}\n`,
  );
  execFileSync("python3", [transcribePy, tapPath, micPath, transcriptPath], {
    stdio: "inherit",
  });
  return transcriptPath;
}

async function main(): Promise<void> {
  const dirArg = process.argv[2];
  if (!dirArg) {
    process.stderr.write(
      "trigger: usage: tsx src/capture-to-moments-throwaway.ts <capture_dir>\n",
    );
    process.exit(1);
  }
  const dir = resolve(dirArg);
  process.stdout.write(`trigger: capture dir = ${dir}\n`);

  const stamp = findLatestStamp(dir);
  process.stdout.write(`trigger: stamp = ${stamp}\n`);

  const transcriptPath = transcribeIfMissing(dir, stamp);
  process.stdout.write(`trigger: transcript = ${basename(transcriptPath)}\n`);

  const ingest = await ingestTranscript(transcriptPath);
  process.stdout.write(`trigger: recording_id = ${ingest.recordingId}\n`);

  const extraction = await runExtraction(ingest.recordingId);
  process.stdout.write("\n=== trigger result ===\n");
  process.stdout.write(`recording_id: ${ingest.recordingId}\n`);
  process.stdout.write(`extraction_run: ${extraction.runUuid}\n`);
  process.stdout.write(
    `moments (visible after collapse): ${extraction.momentsVisibleAfterCollapse}\n`,
  );
  process.stdout.write(
    `moments (pre-collapse rows written): ${extraction.preCollapseMomentCount}\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(
      `trigger: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
