// The capture→moments seam: transcribe → ingest → extract, with no person in
// between. Replaces capture-to-moments-throwaway.ts, whose stated deletion
// condition was a real seam existing in code.
//
// This is a library. The recorder spawns the CLI wrapper in cli.ts on Stop;
// a future directory watcher or upload handler would call runCapturePipeline
// directly. That is the whole reason the invoke mechanism lives outside this
// file — recorder-spawns-on-stop is true while the recorder and the pipeline
// share a filesystem, and nothing here assumes it will stay that way.
//
// Identity comes from the SAA-93 manifest, never from the filename. The
// manifest's recording_id becomes the recording's source_id, which is what
// makes a retry safe (ingest adopts the existing row) and what lets a moment
// be traced back to the capture it came from.
//
// Per-step state lands in pipeline-<stem>.json beside the manifest, so a
// failure is a fact on disk rather than a line in a log nobody opens. This is
// deliberately not a jobs framework: a JSON file, an exit code, and a tray
// item is the whole retry surface.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ingestTranscript, type CaptureIdentity } from "../ingest/clipwise.js";
import { runExtraction } from "../extract/extract.js";

const SIDECAR_VERSION = 1;

export type StepName = "transcribe" | "ingest" | "extract";

export type StepState =
  | "pending"
  | "running"
  | "ok"
  | "skipped"
  // Extraction only. runExtraction has no transactional boundary (SAA-82), so
  // a failure part-way through may already have written moments. Retrying it
  // blind would double-extract silently, so this state refuses to auto-retry
  // and demands an explicit force. Not a fix for SAA-82 — a refusal to make
  // its consequences invisible.
  | "failed_partial"
  | "failed";

type StepRecord = {
  state: StepState;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  detail: Record<string, unknown> | null;
};

export type Sidecar = {
  sidecar_version: number;
  recording_id: string;
  stem: string;
  capture_dir: string;
  db_recording_id: string | null;
  updated_at: string;
  steps: Record<StepName, StepRecord>;
};

export type PipelineResult = {
  stem: string;
  recordingId: string;
  dbRecordingId: string;
  sidecarPath: string;
  reusedRecording: boolean;
  extraction: { runUuid: string; momentsVisibleAfterCollapse: number } | null;
};

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly step: StepName | "manifest" | "capture",
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

const STEP_ORDER: StepName[] = ["transcribe", "ingest", "extract"];

function emptyStep(): StepRecord {
  return { state: "pending", started_at: null, ended_at: null, error: null, detail: null };
}

function log(msg: string): void {
  process.stdout.write(`pipeline: ${msg}\n`);
}

// --- capture directory ----------------------------------------------------

export function findLatestStem(dir: string): string {
  const entries = readdirSync(dir);
  const tap = new Set<string>();
  const mic = new Set<string>();
  for (const name of entries) {
    let m = name.match(/^system-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.f32le\.pcm$/);
    if (m) tap.add(m[1]);
    m = name.match(/^mic-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.wav$/);
    if (m) mic.add(m[1]);
  }
  const both = [...tap].filter((s) => mic.has(s)).sort();
  if (both.length === 0) {
    throw new PipelineError(
      `no stem in ${dir} has both a system-*.f32le.pcm and a mic-*.wav`,
      "capture",
    );
  }
  return both[both.length - 1];
}

type Manifest = {
  recording_id?: string;
  started_at?: string;
  stem?: string;
  tracks?: unknown;
};

function readManifest(dir: string, stem: string): CaptureIdentity {
  const path = join(dir, `manifest-${stem}.json`);
  if (!existsSync(path)) {
    throw new PipelineError(
      `no manifest at ${path}. The seam keys on the manifest's recording_id; ` +
        `a capture without one predates SAA-93 and has no durable identity to file it under.`,
      "manifest",
    );
  }
  const doc = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (!doc.recording_id) {
    throw new PipelineError(`manifest ${path} has no recording_id`, "manifest");
  }
  if (!doc.started_at) {
    throw new PipelineError(`manifest ${path} has no started_at`, "manifest");
  }
  return {
    recordingId: doc.recording_id,
    startedAt: doc.started_at,
    stem: doc.stem ?? stem,
    manifestFile: path,
    tracks: doc.tracks,
  };
}

// --- sidecar --------------------------------------------------------------

function sidecarPathFor(dir: string, stem: string): string {
  return join(dir, `pipeline-${stem}.json`);
}

function loadSidecar(dir: string, stem: string, recordingId: string): Sidecar {
  const path = sidecarPathFor(dir, stem);
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf8")) as Sidecar;
      if (prior.recording_id === recordingId && prior.steps) return prior;
      // A sidecar for a different recording_id under the same stem means the
      // capture was re-identified. Start clean rather than merge two histories.
    } catch {
      // Unreadable sidecar: rebuild rather than fail the capture over it.
    }
  }
  return {
    sidecar_version: SIDECAR_VERSION,
    recording_id: recordingId,
    stem,
    capture_dir: dir,
    db_recording_id: null,
    updated_at: new Date().toISOString(),
    steps: {
      transcribe: emptyStep(),
      ingest: emptyStep(),
      extract: emptyStep(),
    },
  };
}

function writeSidecar(dir: string, sidecar: Sidecar): void {
  sidecar.updated_at = new Date().toISOString();
  writeFileSync(sidecarPathFor(dir, sidecar.stem), JSON.stringify(sidecar, null, 2) + "\n");
}

// --- steps ----------------------------------------------------------------

function transcribeIfMissing(dir: string, stem: string): { path: string; ran: boolean } {
  const transcriptPath = join(dir, `transcript-${stem}.json`);
  if (existsSync(transcriptPath)) {
    log(`transcript exists → ${transcriptPath}`);
    return { path: transcriptPath, ran: false };
  }
  // Three levels up lands at the repo root from either src/pipeline (tsx) or
  // dist/pipeline (built), so this holds however the seam is invoked.
  const transcribePy = resolve(__dirname, "..", "..", "..", "recorder", "transcribe.py");
  if (!existsSync(transcribePy)) {
    throw new PipelineError(`recorder/transcribe.py not found at ${transcribePy}`, "transcribe");
  }
  const tapPath = join(dir, `system-${stem}.f32le.pcm`);
  const micPath = join(dir, `mic-${stem}.wav`);
  log(`transcribing → python3 ${transcribePy}`);
  execFileSync("python3", [transcribePy, tapPath, micPath, transcriptPath], {
    stdio: "inherit",
  });
  return { path: transcriptPath, ran: true };
}

type TrackContent = { peak?: number; rms?: number; nonzero_fraction?: number };

// The one silence check worth making without SAA-89's classifier.
//
// A bitwise-zero tap is the ordinary case, not a fault: it means no system
// audio was playing. Denied-tap and nothing-playing-tap have the identical
// exact-zero signature, and telling them apart is exactly what SAA-89 is for.
// So this refuses only when BOTH tracks are exactly zero — nothing was
// captured at all, on either side — which no legitimate capture produces.
//
// It does not catch a transient gap, a live-but-quiet noise floor, or Whisper
// hallucinating over near-silence (SAA-91). Trusting the seam unattended still
// waits on SAA-89. This only stops the loop manufacturing moments from a file
// that contains no audio whatsoever.
export function assertNotWhollySilent(transcriptPath: string): void {
  const doc = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
    content?: { tap?: TrackContent; mic?: TrackContent };
  };
  const tap = doc.content?.tap;
  const mic = doc.content?.mic;
  if (typeof tap?.peak !== "number" || typeof mic?.peak !== "number") {
    log("content stats absent from transcript — silence guard skipped");
    return;
  }
  log(`content: tap peak=${tap.peak} rms=${tap.rms} | mic peak=${mic.peak} rms=${mic.rms}`);
  if (tap.peak === 0 && mic.peak === 0) {
    throw new PipelineError(
      `both tracks are bitwise silent (tap peak=0, mic peak=0) — nothing was captured. ` +
        `Refusing to ingest rather than transcribe silence into moments. ` +
        `Why it was silent (denied grant, transient gap, blocked in setup) is SAA-89's job.`,
      "ingest",
    );
  }
}

// --- orchestration --------------------------------------------------------

export type PipelineOptions = {
  dir: string;
  stem?: string;
  forceExtract?: boolean;
};

export async function runCapturePipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const dir = resolve(opts.dir);
  const stem = opts.stem ?? findLatestStem(dir);
  log(`capture dir = ${dir}`);
  log(`stem = ${stem}`);

  const capture = readManifest(dir, stem);
  log(`recording_id = ${capture.recordingId} (from manifest)`);

  const sidecar = loadSidecar(dir, stem, capture.recordingId);
  writeSidecar(dir, sidecar);

  const begin = (step: StepName): void => {
    sidecar.steps[step] = {
      ...sidecar.steps[step],
      state: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      error: null,
    };
    writeSidecar(dir, sidecar);
  };
  const finish = (
    step: StepName,
    state: StepState,
    detail: Record<string, unknown> | null = null,
    error: string | null = null,
  ): void => {
    sidecar.steps[step] = {
      ...sidecar.steps[step],
      state,
      ended_at: new Date().toISOString(),
      error,
      detail,
    };
    writeSidecar(dir, sidecar);
  };
  const fail = (step: StepName, err: unknown, state: StepState = "failed"): never => {
    const message = err instanceof Error ? err.message : String(err);
    finish(step, state, null, message);
    throw err instanceof Error ? err : new Error(message);
  };

  // --- transcribe ---
  let transcriptPath: string;
  begin("transcribe");
  try {
    const t = transcribeIfMissing(dir, stem);
    transcriptPath = t.path;
    finish("transcribe", t.ran ? "ok" : "skipped", { transcript: transcriptPath, ran: t.ran });
  } catch (err) {
    return fail("transcribe", err);
  }

  // --- ingest (with the silence refusal in front of it) ---
  begin("ingest");
  let dbRecordingId: string;
  let reused: boolean;
  try {
    assertNotWhollySilent(transcriptPath);
    const result = await ingestTranscript(transcriptPath, capture);
    dbRecordingId = result.recordingId;
    reused = result.reused;
    sidecar.db_recording_id = dbRecordingId;
    finish("ingest", reused ? "skipped" : "ok", {
      db_recording_id: dbRecordingId,
      source_id: result.sourceId,
      reused,
      segment_count: result.segmentCount,
    });
    log(`db recording = ${dbRecordingId}${reused ? " (reused existing row)" : ""}`);
  } catch (err) {
    return fail("ingest", err);
  }

  // --- extract ---
  const prior = sidecar.steps.extract;
  if (prior.state === "ok") {
    log("extraction already completed for this capture — nothing to do");
    return {
      stem,
      recordingId: capture.recordingId,
      dbRecordingId,
      sidecarPath: sidecarPathFor(dir, stem),
      reusedRecording: reused,
      extraction: null,
    };
  }
  if ((prior.state === "failed_partial" || prior.state === "running") && !opts.forceExtract) {
    const err = new PipelineError(
      `extraction previously ended in state "${prior.state}" for this capture. ` +
        `runExtraction has no transactional boundary (SAA-82), so a partial run may have ` +
        `written moments already and re-running blind would double-extract. ` +
        `Re-run with --force-extract to proceed anyway.`,
      "extract",
    );
    // Leave the prior state intact — overwriting it would erase the evidence
    // that a partial run happened.
    throw err;
  }

  // Checked before the step is marked running. runExtraction throws on a
  // missing key before it touches the database, so treating that as a partial
  // run would demand --force-extract to recover from a config mistake that
  // wrote nothing. Pre-flight failures are plainly retryable; only a failure
  // after the run begins is ambiguous.
  if (!process.env.ANTHROPIC_API_KEY) {
    finish("extract", "failed", null, "ANTHROPIC_API_KEY not set");
    throw new PipelineError(
      "ANTHROPIC_API_KEY not set — extraction cannot run. The pipeline is spawned " +
        "by the recorder and inherits no shell, so the key belongs in server/.env.",
      "extract",
    );
  }

  begin("extract");
  try {
    const extraction = await runExtraction(dbRecordingId);
    finish("extract", "ok", {
      run_uuid: extraction.runUuid,
      moments_visible_after_collapse: extraction.momentsVisibleAfterCollapse,
      moments_pre_collapse: extraction.preCollapseMomentCount,
    });
    log(
      `extraction ${extraction.runUuid} → ${extraction.momentsVisibleAfterCollapse} moments visible`,
    );
    return {
      stem,
      recordingId: capture.recordingId,
      dbRecordingId,
      sidecarPath: sidecarPathFor(dir, stem),
      reusedRecording: reused,
      extraction: {
        runUuid: extraction.runUuid,
        momentsVisibleAfterCollapse: extraction.momentsVisibleAfterCollapse,
      },
    };
  } catch (err) {
    // Any failure here may have written rows. Recorded as partial so the next
    // run refuses rather than silently extracting a second time.
    return fail("extract", err, "failed_partial");
  }
}

export { STEP_ORDER, sidecarPathFor };
