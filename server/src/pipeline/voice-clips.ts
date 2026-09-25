// The naming data for SAA-195's window: for a capture diarize just split
// into 2+ voices, cut a few short single-voice clips from the best-quality
// audio on disk and pull each voice's two longest transcript lines, so the
// recorder can show something to listen to and read without touching the
// database itself (main.js never has DB access — see identity.ts's own
// file-based answer for the same reason, the other direction).
//
// Written only when diarize actually split the recording (2+ voices). A
// two-party call never gets this file, and the naming window never shows a
// step 2 for it.
//
// Clips are recordings, so they stay out of the repo (Architecture
// Decision #11) — same directory as everything else this capture already
// wrote, gitignored by the same rule that covers the rest of that
// directory tree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export type ClipRange = { start: number; end: number };

export type NamingVoice = {
  voiceIndex: number;
  speakerId: string;
  clipPaths: string[];
  // The two longest segments attributed to this voice, not the first two
  // (SAA-195's design comment: on 09-14 the first lines were "Yeah…" and
  // "forth on that…" — useless for recognizing someone by ear).
  lines: Array<{ text: string; start: number; end: number }>;
};

export type NamingData = {
  recording_id: string;
  stem: string;
  generated_at: string;
  voices: NamingVoice[];
};

export function namingDataPathFor(dir: string, stem: string): string {
  return join(dir, `voices-${stem}.json`);
}

function clipPathFor(dir: string, stem: string, voiceIndex: number, n: number): string {
  return join(dir, `voice-clip-${stem}-${voiceIndex}-${n}.wav`);
}

// Duplicated from apply-identity.ts's readManifestRecordingId rather than
// imported: this module is reached from the diarize pipeline step, and
// apply-identity.ts pulls in ingest/identity.ts, which pulls in this
// file's own sibling (diarize.ts, for isVoiceLabel) — importing back from
// apply-identity.ts here risks the same circular shape identity.ts's own
// comment already avoids once. One ten-line function is the cheaper side.
function readManifestRecordingId(dir: string, stem: string): string {
  const path = join(dir, `manifest-${stem}.json`);
  const doc = JSON.parse(readFileSync(path, "utf8")) as { recording_id?: string };
  if (!doc.recording_id) throw new Error(`manifest ${path} has no recording_id`);
  return doc.recording_id;
}

// Cuts from system-<stem>.f32le.pcm — the native-rate tap capture, never
// the 16kHz copy diarize itself reads — because these clips are for a
// person to listen to, not a model to analyze. Raw f32le/48kHz/mono input
// framing matches transcribe.py's own ffmpeg_downsample_pcm exactly (the
// only other place this repo reads that file format).
function cutClip(tapPcmPath: string, range: ClipRange, outPath: string): void {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "f32le", "-ar", "48000", "-ac", "1",
    "-i", tapPcmPath,
    "-ss", String(range.start), "-to", String(range.end),
    "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", "-c:a", "pcm_s16le", "-f", "wav",
    outPath,
  ]);
}

// Called from diarize.ts right after a successful split, with the same
// per-voice clip ranges the sidecar carried and the speakerId each voice's
// new `speakers` row actually got. Best-effort by design, same posture as
// diarize itself: a clip-cutting failure here must not undo the split or
// fail the capture, so the caller wraps this the same way it wraps the
// diarize tool's own execFileSync.
export async function generateVoiceNamingData(
  dir: string,
  stem: string,
  voices: Array<{ voiceIndex: number; clipRanges: ClipRange[] }>,
  speakerIdByVoice: Map<number, string>,
): Promise<string> {
  const tapPcmPath = join(dir, `system-${stem}.f32le.pcm`);
  if (!existsSync(tapPcmPath)) {
    throw new Error(`native tap audio not found at ${tapPcmPath}`);
  }

  const namingVoices: NamingVoice[] = [];
  for (const voice of voices) {
    const speakerId = speakerIdByVoice.get(voice.voiceIndex);
    if (!speakerId) continue; // unreachable in practice — every voice in `voices` has a row

    const clipPaths: string[] = [];
    for (let i = 0; i < voice.clipRanges.length; i++) {
      const outPath = clipPathFor(dir, stem, voice.voiceIndex, i + 1);
      cutClip(tapPcmPath, voice.clipRanges[i], outPath);
      clipPaths.push(outPath);
    }

    const segments = await db
      .select({ text: schema.segments.text, startSec: schema.segments.startSec, endSec: schema.segments.endSec })
      .from(schema.segments)
      .where(eq(schema.segments.speakerId, speakerId));
    const duration = (s: { startSec: number; endSec: number }) => s.endSec - s.startSec;
    const lines = segments
      .slice()
      .sort((a, b) => duration(b) - duration(a))
      .slice(0, 2)
      .map((s) => ({ text: s.text, start: s.startSec, end: s.endSec }));

    namingVoices.push({ voiceIndex: voice.voiceIndex, speakerId, clipPaths, lines });
  }

  const doc: NamingData = {
    recording_id: readManifestRecordingId(dir, stem),
    stem,
    generated_at: new Date().toISOString(),
    voices: namingVoices,
  };
  const path = namingDataPathFor(dir, stem);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}
