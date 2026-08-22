// The unattended recovery pass (SAA-136): find captures whose processing never
// finished and finish them, with nobody watching.
//
// The recorder spawns this on launch and after a pipeline run fails. There is
// no button, no notification and nothing for the user to notice — a closed
// laptop or a dropped hotspot costs a few minutes of recompute instead of a
// recording. Median extraction is 32s across 25 observed runs, worst 438s, so
// recompute is the cheap side of that trade; checkpoint/resume is not in scope.
//
// WHAT COUNTS AS FINISHED IS READ FROM THE DATABASE. Not from the sidecar —
// the sidecar is the thing this replaces. It claimed `ok` for a recording row
// that no longer existed, and on 2026-08-20 it recorded `failed_partial` for a
// run that died in pass 1 having written nothing, which is what left a real
// 1:1 stuck behind a Retry button that could never work. A recording is done
// when it carries the terminal status AND a promoted current_extraction_run;
// anything else is work.
//
// ENUMERATION STARTS FROM THE MANIFESTS ON DISK, NOT FROM THE RECORDINGS TABLE.
// This is deliberate and it is what closes the pre-ingest hole: a capture that
// dies during transcription — the longest step before anything is written,
// up to ~2 minutes on a long meeting — never reaches ingest, so no recording
// row exists and a database-driven enumeration cannot see it at all. The
// manifest is the capture's durable identity (SAA-93) and its recording_id is
// what ingest stores as source_id, so walking manifests and asking the
// database about each one covers both cases with one pass: "no row at all" and
// "row that never reached a terminal status" are the same answer — not done.
//
// Usage:
//   tsx src/pipeline/recover.ts <capture_dir> [--max-attempts N] [--dry-run]

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db, pool, schema } from "../db/index.js";
import { CLIPWISE_SOURCE } from "../ingest/clipwise.js";
import { TERMINAL_STATUS } from "../extract/extract.js";
import { runCapturePipeline, type Sidecar } from "./run-capture.js";

// How many times a single capture may be picked up before this pass stops
// offering it. Chosen at 3: the failures this exists for are transient — a
// hotspot dropping, an API 429, a laptop lid — and the 2026-08-20 incident
// recovered on its third attempt. A capture that has burned three full
// extractions is failing for a reason retrying will not fix (a corrupt PCM, a
// model that rejects the transcript, an expired key), and the fourth attempt
// costs the same minutes as the first while producing the same nothing.
// The bound is per capture, not per launch, so a capture that fails on every
// launch stops after three launches rather than retrying forever.
const DEFAULT_MAX_ATTEMPTS = 3;

// Minimum gap between two attempts on the same capture. Without it the
// after-a-failure trigger and the on-launch trigger can fire seconds apart
// during a network outage and spend the entire budget while the cause is still
// present — which would abandon a recording permanently for a problem that
// fixes itself. Ten minutes is long enough that the second attempt is a
// genuinely different moment, short enough that a transient blip still
// recovers within one sitting. The first attempt after a failed pipeline run
// is not delayed: that run is not counted here, so a one-off blip still gets
// an immediate retry.
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

// How long a sidecar step left in `running` is treated as possibly still
// running. This is a liveness hint and explicitly NOT a completion read: the
// pipeline is spawned detached and unref'd so it outlives the app, which means
// a relaunch can happen while a previous session's pipeline is still working.
// Starting a second one would not corrupt anything — re-running is safe, the
// promotion swaps the visible set atomically — but it would burn a duplicate
// extraction for nothing.
//
// 30 minutes is comfortably past the worst observed end-to-end run (~127s
// transcribe + 438s extract ≈ 10 min) so a live pipeline is never stepped on,
// and bounded so a step left `running` by a killed process unblocks by itself
// rather than wedging recovery permanently.
const RUNNING_GRACE_MS = 30 * 60 * 1000;

type Manifest = { recording_id?: string; stem?: string; started_at?: string };

type Candidate = {
  stem: string;
  recordingId: string;
  startedAt: string | null;
};

type Attempts = {
  stem: string;
  recording_id: string;
  attempts: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
};

function log(msg: string): void {
  process.stdout.write(`recover: ${msg}\n`);
}

// --- disk -----------------------------------------------------------------

function manifestCandidates(dir: string): Candidate[] {
  const out: Candidate[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^manifest-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$/);
    if (!m) continue;
    const stem = m[1];
    let doc: Manifest;
    try {
      doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as Manifest;
    } catch {
      // A manifest that will not parse cannot be filed under an identity, and
      // the pipeline would refuse it for the same reason. Skipped loudly
      // rather than counted as work.
      log(`  ${stem}: manifest unreadable — skipping`);
      continue;
    }
    if (!doc.recording_id) {
      log(`  ${stem}: manifest has no recording_id (predates SAA-93) — skipping`);
      continue;
    }
    out.push({ stem, recordingId: doc.recording_id, startedAt: doc.started_at ?? null });
  }
  // Oldest first: if several are outstanding, the one that has been waiting
  // longest is the one a person is most likely to be missing.
  out.sort((a, b) => a.stem.localeCompare(b.stem));
  return out;
}

function attemptsPathFor(dir: string, stem: string): string {
  return join(dir, `recovery-${stem}.json`);
}

// The retry budget lives in its own file rather than in the pipeline sidecar.
// The sidecar is a completion record this pass is not allowed to trust, and
// putting a counter inside it would invite exactly that confusion. Losing this
// file costs three more attempts and nothing else — it is a rate limiter, not
// state anything depends on.
function readAttempts(dir: string, stem: string, recordingId: string): Attempts {
  const path = attemptsPathFor(dir, stem);
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf8")) as Attempts;
      if (prior.recording_id === recordingId && typeof prior.attempts === "number") return prior;
    } catch {
      // Unreadable: start the budget over rather than refuse to recover.
    }
  }
  return {
    stem,
    recording_id: recordingId,
    attempts: 0,
    first_attempt_at: null,
    last_attempt_at: null,
    last_error: null,
  };
}

function writeAttempts(dir: string, a: Attempts): void {
  writeFileSync(attemptsPathFor(dir, a.stem), JSON.stringify(a, null, 2) + "\n");
}

// Liveness only — never consulted for completion.
//
// A step left in `running` means nothing by itself. The pipeline is spawned
// detached, so it may genuinely still be working; but a process killed
// mid-extraction leaves exactly the same mark, and that is the failure this
// whole pass exists to clean up. Reading `running` as "busy" would defer the
// primary case for the length of the timeout — verified while building this:
// a hard kill during pass 1 left `extract: running` and nothing else.
//
// So the test is whether the writing process is actually alive. signal 0
// performs the permission and existence checks without delivering anything;
// ESRCH means no such process. The age window stays as an upper bound against
// PID reuse — a recycled PID can only mislead inside it.
function looksInFlight(dir: string, stem: string): boolean {
  const path = join(dir, `pipeline-${stem}.json`);
  if (!existsSync(path)) return false;
  let doc: Sidecar;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Sidecar;
  } catch {
    return false;
  }
  const now = Date.now();
  let running = false;
  for (const step of Object.values(doc.steps ?? {})) {
    if (step?.state !== "running" || !step.started_at) continue;
    const age = now - Date.parse(step.started_at);
    if (Number.isFinite(age) && age >= 0 && age < RUNNING_GRACE_MS) running = true;
  }
  if (!running) return false;
  // No PID recorded: the sidecar predates this field, so fall back to the
  // timeout. Pessimistic in the safe direction — it waits rather than
  // double-running.
  if (typeof doc.pid !== "number") return true;
  try {
    process.kill(doc.pid, 0);
    return true;
  } catch (err) {
    // ESRCH: gone. EPERM: alive but owned by someone else, which on this
    // machine means it is not ours to duplicate either.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- database -------------------------------------------------------------

type DbState = { id: string; status: string; currentRun: string | null };

// One query for the whole directory rather than one per capture. Keyed by
// source_id, which is the manifest's recording_id — the same key ingest files
// the row under (ingest/clipwise.ts:177).
async function loadDbState(recordingIds: string[]): Promise<Map<string, DbState>> {
  const out = new Map<string, DbState>();
  if (recordingIds.length === 0) return out;
  const rows = await db
    .select({
      id: schema.recordings.id,
      sourceId: schema.recordings.sourceId,
      status: schema.recordings.status,
      currentRun: sql<string | null>`${schema.recordings.metadata}->>'current_extraction_run'`,
    })
    .from(schema.recordings)
    .where(
      and(
        eq(schema.recordings.source, CLIPWISE_SOURCE),
        inArray(schema.recordings.sourceId, recordingIds),
      ),
    );
  for (const r of rows) {
    if (r.sourceId) out.set(r.sourceId, { id: r.id, status: r.status, currentRun: r.currentRun });
  }
  return out;
}

function isComplete(s: DbState | undefined): boolean {
  return s !== undefined && s.status === TERMINAL_STATUS && s.currentRun !== null;
}

// --- pass -----------------------------------------------------------------

export type RecoveryOutcome = {
  stem: string;
  recordingId: string;
  action:
    | "complete"
    | "in_flight"
    | "budget_exhausted"
    | "cooling_down"
    | "recovered"
    | "failed"
    | "skipped";
  detail: string;
};

export async function runRecoveryPass(opts: {
  dir: string;
  maxAttempts?: number;
  dryRun?: boolean;
}): Promise<RecoveryOutcome[]> {
  const dir = resolve(opts.dir);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const dryRun = opts.dryRun ?? false;

  const candidates = manifestCandidates(dir);
  const state = await loadDbState(candidates.map((c) => c.recordingId));
  log(`${candidates.length} capture(s) on disk, ${state.size} with a recording row`);

  const outcomes: RecoveryOutcome[] = [];
  const todo: Candidate[] = [];

  for (const c of candidates) {
    const s = state.get(c.recordingId);
    if (isComplete(s)) {
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "complete",
        detail: `status=${s!.status} run=${s!.currentRun}`,
      });
      continue;
    }
    if (looksInFlight(dir, c.stem)) {
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "in_flight",
        detail: "a pipeline step is running and recent — leaving it alone",
      });
      continue;
    }
    const a = readAttempts(dir, c.stem, c.recordingId);
    if (a.attempts >= maxAttempts) {
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "budget_exhausted",
        detail: `${a.attempts}/${maxAttempts} attempts used; last error: ${a.last_error ?? "none recorded"}`,
      });
      continue;
    }
    const sinceLast = a.last_attempt_at ? Date.now() - Date.parse(a.last_attempt_at) : Infinity;
    if (Number.isFinite(sinceLast) && sinceLast >= 0 && sinceLast < RETRY_COOLDOWN_MS) {
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "cooling_down",
        detail:
          `attempted ${Math.round(sinceLast / 1000)}s ago ` +
          `(${a.attempts}/${maxAttempts} used); waiting out the ${RETRY_COOLDOWN_MS / 60000}min cooldown`,
      });
      continue;
    }
    todo.push(c);
  }

  const done = outcomes.filter((o) => o.action === "complete").length;
  log(
    `${done} already complete, ${outcomes.length - done} held back, ${todo.length} to run` +
      (dryRun ? " (dry run)" : ""),
  );

  // Sequential on purpose. Extraction is API-bound and two at once would race
  // for the same rate limit while making the log unreadable; there is also no
  // deadline here worth the complexity of a queue.
  for (const c of todo) {
    const s = state.get(c.recordingId);
    log(
      `→ ${c.stem} (recording_id=${c.recordingId}, ` +
        `db=${s ? `${s.id} status=${s.status}` : "no row — never ingested"})`,
    );
    if (dryRun) {
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "skipped",
        detail: "dry run",
      });
      continue;
    }
    const a = readAttempts(dir, c.stem, c.recordingId);
    const now = new Date().toISOString();
    a.attempts += 1;
    a.first_attempt_at = a.first_attempt_at ?? now;
    a.last_attempt_at = now;
    // Written before the run, not after. A process killed mid-extraction —
    // the exact failure this exists for — would otherwise never record the
    // attempt and could retry without bound.
    writeAttempts(dir, a);

    try {
      const result = await runCapturePipeline({ dir, stem: c.stem });
      a.last_error = null;
      writeAttempts(dir, a);
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "recovered",
        detail: result.extraction
          ? `run ${result.extraction.runUuid}, ${result.extraction.momentsVisibleAfterCollapse} moment(s) visible`
          : "pipeline reported nothing to extract",
      });
      log(`  ${c.stem}: recovered`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      a.last_error = message;
      writeAttempts(dir, a);
      outcomes.push({
        stem: c.stem,
        recordingId: c.recordingId,
        action: "failed",
        detail: `attempt ${a.attempts}/${maxAttempts}: ${message}`,
      });
      log(`  ${c.stem}: attempt ${a.attempts}/${maxAttempts} failed — ${message}`);
      // Deliberately not rethrown: one bad capture must not stop the others
      // from being recovered.
    }
  }

  return outcomes;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir || dir.startsWith("--")) {
    process.stderr.write(
      "usage: tsx src/pipeline/recover.ts <capture_dir> [--max-attempts N] [--dry-run]\n",
    );
    process.exit(2);
  }
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--max-attempts") {
      maxAttempts = Number(argv[++i]);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        process.stderr.write("recover: --max-attempts needs a positive integer\n");
        process.exit(2);
      }
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else {
      process.stderr.write(`recover: unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }

  const outcomes = await runRecoveryPass({ dir, maxAttempts, dryRun });

  process.stdout.write("\n=== recovery pass ===\n");
  for (const o of outcomes) {
    process.stdout.write(`${o.action.padEnd(18)} ${o.stem}  ${o.detail}\n`);
  }
  const failed = outcomes.filter((o) => o.action === "failed").length;
  const recovered = outcomes.filter((o) => o.action === "recovered").length;
  process.stdout.write(`\nrecovered=${recovered} failed=${failed} total=${outcomes.length}\n`);
  // A failure here is not a failure of the pass: the pass ran, found work and
  // reported what happened. Exiting non-zero would make the recorder treat a
  // single unrecoverable capture as a broken recovery mechanism.
}

// Only when run as a CLI — importing this module (the recorder does not, but a
// future watcher might) must not start a pass or close the pool.
if (process.argv[1] && process.argv[1].endsWith("recover.ts")) {
  main()
    .catch((err) => {
      process.stderr.write(
        `recover: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
