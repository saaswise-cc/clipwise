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

import { db } from "../db/index.js";
import { ingestTranscript, type CaptureIdentity } from "../ingest/clipwise.js";
import { readExtractionCompletion, runExtraction } from "../extract/extract.js";
import { runDiarizationForCapture } from "./diarize.js";
import {
  applyCalendarMatch,
  describeCalendarMatchApplication,
  readCalendarMatch,
} from "../ingest/calendar-match.js";
import { matchCaptureToCalendar } from "./match-calendar.js";
import {
  classifyCapture,
  type CaptureClassification,
  type TranscriptContent,
} from "./classify-capture.js";

const SIDECAR_VERSION = 1;

export type StepName = "match" | "transcribe" | "ingest" | "diarize" | "extract";

export type StepState =
  | "pending"
  | "running"
  | "ok"
  | "skipped"
  // Match only. The step ran and produced a real answer, but not every
  // calendar it was supposed to search was reachable (a share revoked, a
  // calendar deleted) — see calendar_errors in the step's detail. Kept
  // apart from "ok" deliberately: "ok" and "searched what it could, one
  // source silently gone" must not read the same to someone scanning step
  // states rather than opening the detail blob, which is exactly the
  // failure shape SAA-183 exists to explain, one level down.
  | "ok_partial"
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
  // PID of the process that last wrote this file. Liveness only — it says
  // nothing about whether anything succeeded. A step left in `running` is
  // ambiguous on its own: the pipeline may still be working, or it may have
  // been killed mid-step, which is precisely the failure the recovery pass
  // exists to clean up (SAA-136). Without a PID to test, recovery has to
  // assume the optimistic reading and wait out a timeout before touching the
  // one case it most needs to fix.
  pid: number | null;
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

const STEP_ORDER: StepName[] = ["match", "transcribe", "ingest", "diarize", "extract"];

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
  permissions?: { tap?: string; mic?: string };
  // Which application's mic use started this capture, or null for a manual
  // start (SAA-170). Absent on manifests written before this shipped.
  trigger_app?: { key?: string; name?: string } | null;
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
    // Absent on manifests written before SAA-89. The classifier treats an
    // unknown permission as unknown rather than assuming granted.
    permissions: doc.permissions,
    triggerApp: doc.trigger_app ?? null,
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
    pid: null,
    steps: {
      match: emptyStep(),
      transcribe: emptyStep(),
      ingest: emptyStep(),
      diarize: emptyStep(),
      extract: emptyStep(),
    },
  };
}

// A sidecar written before this step existed has no `diarize` key at all —
// `sidecar.steps.diarize` reads as `undefined`, not a StepRecord, until the
// first pipeline run past this change calls begin("diarize") on it. That's
// safe on its own (begin/finish below spread `sidecar.steps[step]`, and
// spreading undefined is a no-op), and recover.ts's looksInFlight() already
// iterates `Object.values(doc.steps ?? {})` rather than indexing named keys,
// so an old, shorter sidecar composes with both old and new code without
// migration. Nothing else reads sidecar.steps.diarize before this file's own
// begin("diarize") call does.

function writeSidecar(dir: string, sidecar: Sidecar): void {
  sidecar.updated_at = new Date().toISOString();
  sidecar.pid = process.pid;
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

// Classify the capture's audio content against the permission state the
// manifest recorded. Replaces the both-tracks-bitwise-zero check this file
// used to carry: that refusal survives as one outcome of the classification,
// so behaviour on a wholly silent capture is unchanged, but a single dead
// track is now named and kept rather than passing through unnoticed.
function classifyOrNull(
  transcriptPath: string,
  capture: CaptureIdentity,
): CaptureClassification | null {
  const doc = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
    content?: TranscriptContent;
  };
  const result = classifyCapture({
    content: doc.content,
    permissions: capture.permissions,
  });
  if (!result) {
    log("content stats absent from transcript — classification skipped");
    return null;
  }
  const { tap, mic } = result.tracks;
  log(`classify: tap band=${tap.band} verdict=${tap.verdict} perm=${tap.permission} rms=${tap.rms} peak=${tap.peak} nonzero=${tap.nonzero_fraction}`);
  log(`classify: mic band=${mic.band} verdict=${mic.verdict} perm=${mic.permission} rms=${mic.rms} peak=${mic.peak} nonzero=${mic.nonzero_fraction}`);
  for (const t of [tap, mic]) {
    for (const g of t.gaps) log(`classify: ${t.track} dropout ${g.start_s}s → ${g.end_s}s (${g.duration_s}s)`);
  }
  log(`classify: verdict=${result.verdict} concern=${result.concern} — ${result.reason}`);
  if (result.excludedLabels.length) {
    log(`classify: excluding segments for label(s) ${result.excludedLabels.join(", ")} — no audio on that track`);
  }
  if (result.verdict === "unusable") {
    throw new PipelineError(
      `capture is unusable: ${result.reason}. Refusing to ingest rather than ` +
        `transcribe silence into moments.`,
      "ingest",
    );
  }
  return result;
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

  // --- match (SAA-115) ---
  //
  // Runs first, ahead of transcribe, so a matched event's attendee names
  // are reachable by the capture pipeline before transcription runs — not
  // only written to the database at ingest. This is the design constraint
  // named on the issue: if the writes landed only at ingest, a whisper
  // initial-prompt fix (SAA-185) would stay unavailable even on captures
  // that matched an event, the one population it needs to work on.
  //
  // Best-effort only. Never calls fail("match", ...) — that would abort the
  // whole pipeline run over a calendar lookup, which the recorder's own
  // stated principle (nothing may delay or discard a capture) rules out.
  // transcribe/ingest/extract proceed exactly as if nothing was configured
  // whenever this is skipped, whatever the reason.
  begin("match");
  try {
    const result = await matchCaptureToCalendar(dir, stem, capture);
    const calendarErrorCount = Array.isArray(result.detail.calendar_errors)
      ? result.detail.calendar_errors.length
      : 0;
    const hasCalendarErrors = calendarErrorCount > 0;
    finish("match", hasCalendarErrors ? "ok_partial" : "ok", {
      matched: result.matched,
      ...result.detail,
    });
    if (result.matched) {
      log(`calendar match: event=${result.detail.event_id} offset_ms=${result.detail.offset_ms}`);
    } else {
      log(`calendar match: none (${result.detail.reason})`);
    }
    if (hasCalendarErrors) {
      log(`calendar match: ok_partial — ${calendarErrorCount} calendar(s) failed to fetch`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("match", "skipped", { error: message });
    log(`calendar match: skipped — ${message}`);
  }

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
    const classification = classifyOrNull(transcriptPath, capture);
    const result = await ingestTranscript(transcriptPath, capture, classification);
    dbRecordingId = result.recordingId;
    reused = result.reused;
    sidecar.db_recording_id = dbRecordingId;

    // Apply a calendar match written by the "match" step above, if any.
    // No separate late-apply entry point is needed here (unlike identity —
    // SAA-173's whole reason for existing): the match was computed
    // synchronously, one step earlier in this same pipeline run, so there's
    // no async-arrival race to close. Best-effort and separately caught: a
    // failure writing invitees must not retroactively fail an ingest that
    // already succeeded at inserting the recording, transcript and segments.
    let calendarMatchDetail: Record<string, unknown> | null = null;
    const calendarMatch = readCalendarMatch(dir, stem);
    if (calendarMatch) {
      try {
        // Its own transaction, not the ingest one above (already committed
        // by this point): several writes (N invitee upserts, then
        // recurring_event_id, then title) that must land all-or-nothing.
        // Without this, a failure partway leaves some applied and some
        // not, with nothing to retry it (decision 1: no jobs table) — the
        // same shape SAA-82 is open for on extraction. The upsert already
        // makes re-application safe, which is what would make a rollback
        // and a later retry compose correctly if a retry path ever exists.
        const application = await db.transaction((tx) =>
          applyCalendarMatch(tx, result.accountId, dbRecordingId, stem, calendarMatch),
        );
        calendarMatchDetail = { applied: true, ...application };
        log(`calendar match applied: ${describeCalendarMatchApplication(application)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        calendarMatchDetail = { applied: false, error: message };
        log(`calendar match application failed (ingest still ok): ${message}`);
      }
    }

    finish("ingest", reused ? "skipped" : "ok", {
      db_recording_id: dbRecordingId,
      source_id: result.sourceId,
      reused,
      segment_count: result.segmentCount,
      excluded_segment_count: result.excluded.turnCount,
      classification,
      calendar_match: calendarMatchDetail,
    });
    log(`db recording = ${dbRecordingId}${reused ? " (reused existing row)" : ""}`);
  } catch (err) {
    return fail("ingest", err);
  }

  // --- diarize (SAA-194) ---
  //
  // Best-effort, same posture as "match": never calls fail("diarize", ...).
  // Voice separation is an enhancement to a capture, not a precondition for
  // one — a slow Mac, a missing binary (models not fetched), an Intel
  // machine, or a genuine FluidAudio error all leave the recording exactly
  // as it is today (a single `them` speaker), not blocked or discarded.
  //
  // After ingest, not before: ingest is what creates the `them` speaker row
  // and points every tap-track segment at it, and diarize needs that row to
  // already exist so it can re-point segments rather than create them.
  // Before extract: extraction's transcript rendering has to see the final
  // voice split, and its unresolved-identity guard reasoning must not run
  // on stale segment-to-speaker assignments.
  begin("diarize");
  try {
    const diarization = await runDiarizationForCapture(dir, stem, dbRecordingId);
    finish("diarize", diarization.applied ? "ok" : "skipped", {
      applied: diarization.applied,
      reason: diarization.reason,
      voices_found: diarization.voicesFound,
      model_revision: diarization.modelRevision,
      processing_time_seconds: diarization.processingTimeSeconds,
      host_echo: diarization.hostEcho,
    });
    log(`diarize: ${diarization.applied ? "applied" : "skipped"} — ${diarization.reason}`);
  } catch (err) {
    // Defense in depth: runDiarizationForCapture returns rather than throws
    // for every case it anticipates. Anything that reaches here is
    // unanticipated, and still must not fail the capture.
    const message = err instanceof Error ? err.message : String(err);
    finish("diarize", "skipped", { error: message });
    log(`diarize: skipped — ${message}`);
  }

  // --- extract ---
  //
  // Completion is read from the recording row, never from the sidecar
  // (SAA-136). The sidecar is a per-machine cache of what was last attempted
  // and it has been wrong in both directions: it claimed `ok` for a recording
  // row that no longer existed (stem 2026-08-11T17-25-28Z still does), and on
  // 2026-08-20 it recorded `failed_partial` for a run that died in pass 1
  // having written nothing — which is what left the tray's Retry button unable
  // to ever succeed (SAA-132). It stays as the log of what each step did; it
  // simply no longer gets to decide whether there is work to do.
  //
  // The question asked here is narrow on purpose. It is NOT "did a previous
  // run leave rows behind" — a partial run genuinely can, that is SAA-82, and
  // re-running over one is verified safe: promoting the new run evicts the old
  // visible set in the same statement that admits the new one, hand-curated
  // moments are untouched, and nothing duplicates. Refusing on leftover rows
  // is what SAA-132 was filed about.
  //
  // It is "has this recording already finished", because re-extracting a
  // healthy recording is the one genuinely destructive thing this path can do.
  // The same transcript does not reproduce: on the 2026-08-22 check the same
  // recording and model yielded 54 moments and then 41, and the 54 were
  // evicted. So a completed recording is refused unless someone explicitly
  // asks, and everything else is simply run.
  const completion = await readExtractionCompletion(dbRecordingId);
  if (completion.complete && !opts.forceExtract) {
    log(
      `extraction already complete for this recording — status=${completion.status}, ` +
        `current_extraction_run=${completion.currentRun}. Nothing to do.`,
    );
    // Bring the sidecar back in line with the database. It is no longer read
    // for this decision, but it drives the tray, and leaving it claiming a
    // failure the database has since disproved is how the stuck Retry button
    // looked to a user.
    if (sidecar.steps.extract.state !== "ok") {
      finish("extract", "ok", {
        reconciled_from_db: true,
        status: completion.status,
        run_uuid: completion.currentRun,
      });
    }
    return {
      stem,
      recordingId: capture.recordingId,
      dbRecordingId,
      sidecarPath: sidecarPathFor(dir, stem),
      reusedRecording: reused,
      extraction: null,
    };
  }
  if (completion.complete && opts.forceExtract) {
    log("extraction already complete, but --force-extract was passed — re-extracting");
  } else {
    log(
      `extraction not complete for this recording — status=${completion.status ?? "(no row)"}, ` +
        `current_extraction_run=${completion.currentRun ?? "none"}. Extracting.`,
    );
  }
  sidecar.steps.extract = emptyStep();
  writeSidecar(dir, sidecar);

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
