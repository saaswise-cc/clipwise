// Clipwise recorder — Electron menu bar shell.
// Main process only. Spawns tap + mic + poller directly (no bash wrapper),
// tracks a four-label state machine, and tears everything down on Stop or
// Quit. Filenames, timestamp format and output directory match what
// recorder/transcribe.py expects.
//
// On Stop it also spawns the capture→moments pipeline, which is what makes
// the loop unattended: nothing between a capture ending and moments existing
// is a human. The recorder is the trigger; the manifest it wrote at capture
// start is the record the pipeline keys on.

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    IDENTITY_WINDOW, contentHeightFor, knownGuestNames, mergeGuestNames,
    buildAnswerDoc, writeAnswer,
} = require('./identity-answer.js');
const { loadAppScope, scopeForKey } = require('./app-scope.js');

// --- constants ------------------------------------------------------------
// All measurements come from 5-second captures on 2026-08-09. A long
// recording may tear down or flush differently — these are provisional.

// SIGINT to all children, wait, then SIGKILL survivors. Observed exit:
// tap 5–15 ms, ffmpeg 10–30 ms. 750 ms is ~25× the observed max. miccap
// replaced ffmpeg on the mic (SAA-106); its stop path is the same shape —
// stop the IOProc, patch the WAV header, close — and has not been re-timed,
// so the same grace applies until it is.
const KILL_GRACE_MS = 750;

// Starting → Recording deadline. First-byte observed: tap ~100 ms,
// mic ~1700 ms (mic is the binding constraint). Generous deliberately —
// failing early refuses a recording that would have worked.
const STARTING_TIMEOUT_MS = 9000;

// File-size poll interval and per-child staleness windows.
// Observed growth cadence: tap ~50 ms, ffmpeg flushed every ~1550 ms —
// per-tick growth cannot be the test. A child counts as growing if it
// grew within its own window. miccap writes every IOProc callback (~10.7 ms
// at 48 kHz), so the mic is now far smoother than the window assumes; the
// window is left as-is because it is an upper bound and a smoother writer
// cannot trip it. Staleness switches the tray label to
// "Recording (stalled)" but does not kill children — losing the rest of
// a call to a possibly-wrong constant is worse than a misleading label.
const POLL_INTERVAL_MS = 250;
const TAP_STALE_MS = 1000;
const MIC_STALE_MS = 3200;

// Manifest schema version. Bump on any change that is not purely additive.
const MANIFEST_VERSION = 1;

// Minimum gap between recording↔stalled notifications. Every other transition
// notifies unconditionally, but this pair can oscillate: staleness is evaluated
// every POLL_INTERVAL_MS against a 1 s window, so a marginal tap can cross the
// line several times a minute and would otherwise produce a notification each
// time. The tray label still flips immediately; only the notification is held.
const FLAP_NOTIFY_MIN_MS = 30000;

// How long a detection prompt stays answerable (SAA-113). A prompt that is
// never answered expires to "not now", which writes nothing — so this is the
// window in which a durable answer can be given, not a deadline on the call.
// Generous because the prompt arrives exactly when someone is joining a call
// and has other things to do for the first minute of it.
const DETECT_PROMPT_TTL_MS = 180000;

// Minimum gap between prompts for the same application. Without it an app
// that opens and closes the microphone repeatedly — a browser tab being
// reloaded — would queue a prompt each time. A declined app going quiet and
// noisy again inside this window is the same episode, not a new one.
const DETECT_REPROMPT_MS = 120000;

// Executable names belonging to Clipwise's own capture. miccap holds the
// microphone for the whole of a recording, so without this the detector sees
// its own capture and offers to record it — observed on the SAA-113 probe run
// as exactly what Fathom does when it auto-starts on a call. Matched on the
// executable name because these are bare SPM binaries with no bundle ID.
const DETECT_SELF_EXES = new Set(['miccap', 'systemtap', 'audiodevs', 'micwatch']);

// The tap is created with isMono=true, so its stream is one channel whatever
// the output device carries. Recorded here because the tap track is headerless
// PCM: a consumer cannot recover channel count from the file.
const TAP_CHANNELS = 1;

// --- paths ----------------------------------------------------------------

// Two layouts, told apart by one file. Run from a checkout (`npm start`),
// every path is relative to this one. Run from the .app that build-app.sh
// produces, the three helper binaries ship inside the bundle and the server
// checkout does not — there is no copy of it to bundle, and the pipeline has
// to execute the current one. build-app.sh stamps that absolute path into
// build-info.json at build time, and the presence of that file is what says
// which layout this is.
//
// Presence of the file rather than app.isPackaged: isPackaged is derived from
// the name of the executable, which is a fact about how the bundle was
// assembled rather than a statement about where this app expects to find
// anything. A rename would silently move every path below.
const BUILD_INFO = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    } catch {
        return null;
    }
})();

const RECORDER_DIR = path.resolve(__dirname, '..');
const BUNDLED_BIN = path.resolve(__dirname, '..', 'bin');
const SYSTEMTAP_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'systemtap')
    : path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap');
const MICCAP_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'miccap')
    : path.join(RECORDER_DIR, 'miccap', '.build', 'release', 'miccap');
const AUDIODEVS_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'audiodevs')
    : path.join(RECORDER_DIR, 'audiodevs');
const MICWATCH_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'micwatch')
    : path.join(RECORDER_DIR, 'micwatch');

const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'clipwise');
const OUTDIR = path.join(SUPPORT_DIR, 'recordings');

// Which applications may start a capture, learned one answer at a time
// (SAA-113). No list ships: this file does not exist until the first durable
// answer is given. It lives beside the recordings rather than in the bundle
// so it survives both an app restart and a rebuild — build-app.sh writes only
// recorder/app/dist, and never touches this directory.
const DETECT_STORE_PATH = path.join(SUPPORT_DIR, 'detected-apps.json');

// The capture→moments pipeline. Run through the server's own tsx so the seam
// always executes current source — a built dist would silently run whatever
// it was last compiled from. cwd is the server directory so dotenv/config
// finds server/.env; the recorder never handles a secret itself.
const SERVER_DIR = BUILD_INFO
    ? BUILD_INFO.server_dir
    : path.resolve(RECORDER_DIR, '..', 'server');

// --- log ------------------------------------------------------------------
//
// Everything this process reports about itself goes to stderr, and a
// double-clicked app has no stderr — launchd sends it nowhere a person can
// read. That is the whole diagnostic surface of the recorder disappearing at
// exactly the point it stops being launched from a terminal, which is what
// packaging is for. Every notification-delivery line, every child spawn
// failure and every pipeline error is in there.
//
// Only when packaged. A terminal run already shows this, and writing a file
// nobody asked for would be a change to how development works.
const LOG_PATH = path.join(SUPPORT_DIR, 'recorder.log');
if (BUILD_INFO) {
    const toStderr = console.error.bind(console);
    console.error = (...args) => {
        toStderr(...args);
        try {
            fs.mkdirSync(SUPPORT_DIR, { recursive: true });
            fs.appendFileSync(
                LOG_PATH,
                `${new Date().toISOString()} ${args.map(a => String(a)).join(' ')}\n`,
            );
        } catch {
            // A log that cannot be written is not worth losing a capture over.
        }
    };
    console.error(
        `[clipwise-recorder] launched from bundle — built ${BUILD_INFO.built_at} ` +
        `commit ${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+dirty' : ''}`);
}
const TSX_BIN = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
const PIPELINE_ENTRY = path.join(SERVER_DIR, 'src', 'pipeline', 'cli.ts');
// Finds captures whose processing never finished and finishes them (SAA-136).
// Spawned on launch and after a pipeline run fails. It decides what is
// outstanding from the database, not from the sidecars in OUTDIR.
const RECOVER_ENTRY = path.join(SERVER_DIR, 'src', 'pipeline', 'recover.ts');
// Applies an identity answer to a capture that has already been ingested. The
// ordinary case never needs it — see startApplyIdentity.
const APPLY_IDENTITY_ENTRY = path.join(SERVER_DIR, 'src', 'pipeline', 'apply-identity.ts');

// The identity prompt's page, and the file that remembers what the person
// answering is called. The name is asked for once and reused; it is never
// derived from the account — `id -F` on this machine answers "JD", which is
// what the OS knows and not what a person would type. Guessing it would put a
// name nobody chose on every recording.
const IDENTITY_HTML = path.join(__dirname, 'identity.html');
// How long the prompt waits for the page to report its height before showing
// itself anyway. Short enough not to be noticed after a capture, long enough
// for a local file: the measurement is sent from the page's first script run.
const IDENTITY_REVEAL_GRACE_MS = 400;
const SELF_PATH = path.join(SUPPORT_DIR, 'identity-self.json');

// A GUI-launched Electron inherits a minimal PATH with no Homebrew on it, and
// the pipeline shells out to python3, ffmpeg and whisper-cli. Launched from a
// terminal this changes nothing.
const PIPELINE_PATH = [
    ...new Set([
        ...(process.env.PATH || '').split(':').filter(Boolean),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ]),
].join(':');

// --- state ----------------------------------------------------------------

let tray = null;
// Set once quitApp has started tearing down, so anything that restarts
// itself on death — the detector — knows not to.
let isQuitting = false;
// 'stopped' | 'starting' | 'recording' | 'stalled'
let state = 'stopped';
let session = null;
// What caused the capture that is about to start, when it was not a person.
// Set immediately before the detection path calls startRecording() and
// consumed unconditionally there, so it can never survive to label a later,
// unrelated start. Carries the fact the removed "call detected" notification
// used to carry (SAA-151).
let pendingStartTrigger = null;
let teardownInFlight = false;

// Pipeline state is tracked separately from capture state, not folded into
// it. Transcription and extraction take minutes and outlive the capture that
// triggered them; a single state variable would leave the tray claiming to be
// busy and refusing to start the next meeting's recording for no reason.
// { stem, state: 'running' | 'failed', proc }
let pipeline = null;

// Most recent permission finding, shown in the tray until dismissed.
// { denied: ['System Audio', …], blocked: bool, note: string|null }
let permissionIssue = null;

// Last time a recording↔stalled transition was allowed to notify.
let lastFlapNotifyMs = 0;

// Call detection (SAA-113). `detectApps` is the learned list, mirrored from
// DETECT_STORE_PATH; `detectProc` is the micwatch subprocess; `detectPending`
// is the prompt currently awaiting an answer, if any; `detectLastPrompt` maps
// a bundle ID to when it was last asked about, for DETECT_REPROMPT_MS.
//
// detectPending is deliberately in memory only. It is the whole of the
// "not now" answer: if this process dies, or the prompt is never answered, it
// disappears and nothing was written. { key, name, pid, at, timer }
let detectApps = null;
let detectProc = null;
let detectPending = null;
const detectLastPrompt = new Map();

// App -> scope inference (SAA-170). Logic lives in app-scope.js (no
// Electron in it, same reason identity-answer.js is split out); this is
// just the lazy load and the lookup main.js's capture path calls.
let appScope = null;
function scopeForDetectedKey(key) {
    if (!key) return null;
    if (!appScope) appScope = loadAppScope(SUPPORT_DIR);
    return scopeForKey(key, appScope);
}

// The human-recognisable name for a detected-apps entry, preferring the
// app-scope store's `label` (e.g. "FaceTime" for the avconferenced daemon)
// over the process-derived `name` detectApps itself carries, and falling
// back to the raw key when neither is set. Read path only — the label lives
// in app-scope.js's store, not duplicated into detected-apps.json.
function displayNameForDetectedKey(key, entry) {
    if (!appScope) appScope = loadAppScope(SUPPORT_DIR);
    const scoped = appScope[key];
    return (scoped && scoped.label) || (entry && entry.name) || key;
}

// Which application keys are using the microphone right now, maintained from
// micwatch's in_start/in_stop pairs. Only needed to answer one question: when
// an answer arrives after its prompt has lapsed, is the call still going?
const detectActive = new Map();

// Identity prompts waiting to be shown, and the one on screen (SAA-114).
// A queue rather than a single slot: two captures can stop before either is
// answered, and replacing the open window would silently drop the first
// answer. { stem, recordingId, token }
const identityQueue = [];
let identityWindow = null;

const LABEL = {
    stopped:   'Stopped',
    starting:  'Starting',
    recording: 'Recording',
    stalled:   'Recording (stalled)',
};

// Menu-item text, not title text — see renderTray. These were tray-title
// suffixes and were the same overflow hazard as the permission suffix that
// actually triggered it.
// Functions rather than strings because the failed line names a file, and a
// file name that is not built from the stem is a literal `<stem>` on screen —
// which is what it read as, while the Retry item directly below it carried the
// real one (SAA-150).
const PIPELINE_NOTE = {
    running: () => 'Processing capture…',
    failed:  stem => `Processing failed — see pipeline-${stem}.json`,
};

// --- helpers --------------------------------------------------------------

function utcStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
           `T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}Z`;
}

function fileSize(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}

// One pre-flight CoreAudio snapshot: the device identity and nominal rate that
// seed the manifest. Taken before the children spawn, because neither child has
// reported its own format yet at the moment the manifest is written — see
// writeManifest. Since SAA-106 the mic entry is no longer final at that point:
// finalizeMicFormat overwrites it at teardown with the device and format miccap
// read back off the written file. These values remain what the manifest carries
// if that readback is unavailable.
function readDevices() {
    const out = execFileSync(AUDIODEVS_BIN, ['--once'], { encoding: 'utf8' });
    const field = (re, label) => {
        const m = out.match(re);
        if (!m) throw new Error(`audiodevs --once: could not parse ${label} from: ${out}`);
        return m[1];
    };
    // audiodevs reports 0 when the rate query fails. Unknown is null in the
    // manifest, never a plausible-looking number.
    const rate = (re, label) => {
        const n = Number(field(re, label));
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
        inName:  field(/\bin_name="([^"]*)"/, 'in_name'),
        inUid:   field(/\bin_uid="([^"]*)"/, 'in_uid'),
        inRate:  rate(/\bin_rate=(\S+)/, 'in_rate'),
        outName: field(/\bout_name="([^"]*)"/, 'out_name'),
        outUid:  field(/\bout_uid="([^"]*)"/, 'out_uid'),
        outRate: rate(/\bout_rate=(\S+)/, 'out_rate'),
        micPerm: field(/\bmic_perm=(\S+)/, 'mic_perm'),
        tapPerm: field(/\btap_perm=(\S+)/, 'tap_perm'),
    };
}

// Settings panes, for the affordance offered when a grant is missing. Telling
// someone permission is off without a way to fix it is only half an answer.
const SETTINGS_PANE = {
    'System Audio': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
    'Microphone':   'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

// Only an explicit denial counts. notDetermined resolves with a click (the
// prompt fires on first use, and SAA-90's start gate covers a non-answer), and
// unavailable/restricted are not statements about this user's grant.
function deniedServices(dev) {
    const out = [];
    if (dev.micPerm === 'denied') out.push('Microphone');
    if (dev.tapPerm === 'denied') out.push('System Audio');
    return out;
}

// The manifest is what makes a capture a thing rather than a naming
// convention: an opaque id that does not depend on a correct clock, and the
// per-track device and rate that are otherwise recoverable only from child
// stderr that nothing preserves.
//
// Rates come from the CoreAudio query above, not from the children. systemtap
// and miccap both report their real format milliseconds after they start;
// waiting for that would make this a post-hoc artifact rather than something
// written at capture start. sample_rate_source records that provenance in the
// file so a consumer never has to guess which it is holding — and for the mic
// track it is rewritten to wav_fmt_chunk_readback once the file is finished.
function buildManifest(stamp, startedAt, dev, paths, trigger) {
    return {
        manifest_version: MANIFEST_VERSION,
        recording_id: randomUUID().toUpperCase(),
        started_at: startedAt,
        // The filename stem stays the human-readable handle. It is recorded,
        // not derived from — recording_id is the identifier.
        stem: stamp,
        // Which application's microphone use started this capture, or null
        // for a manual start (SAA-170). This is step one of that issue:
        // nothing downstream can be verified about app-inferred scope until
        // the app that triggered a capture is on the record somewhere other
        // than a variable that dies with the process.
        trigger_app: trigger ? { key: trigger.key, name: trigger.name } : null,
        tracks: [
            {
                track: 'system',
                file: path.basename(paths.tap),
                encoding: 'f32le',
                container: 'raw',
                channels: TAP_CHANNELS,
                sample_rate: dev.outRate,
                sample_rate_source: 'coreaudio_nominal_output',
                // The tap captures the default output device, so that is the
                // device this track belongs to.
                device_name: dev.outName,
                device_uid: dev.outUid,
            },
            {
                track: 'mic',
                file: path.basename(paths.mic),
                encoding: 'f32le',
                container: 'wav',
                sample_rate: dev.inRate,
                sample_rate_source: 'coreaudio_nominal_input',
                device_name: dev.inName,
                device_uid: dev.inUid,
            },
        ],
        logs: [paths.tapLog, paths.micLog, paths.pollLog].map(p => path.basename(p)),
        // Permission state at capture start. This is the only thing that can
        // tell a denied tap from a tap with nothing playing — the two are
        // bitwise identical in the audio itself (SAA-87). The classifier
        // downstream reads these; without them a silent tap is indeterminate.
        permissions: {
            mic: dev.micPerm,
            tap: dev.tapPerm,
            mic_source: 'avcapturedevice_authorization_status',
            tap_source: 'tcc_access_preflight_kTCCServiceAudioCapture',
        },
    };
}

// Rewrite the manifest's mic track from the format miccap read back off the
// finished WAV, replacing the CoreAudio nominal rate captured at start.
//
// The two are not always the same. A 2026-08-14 capture shipped a manifest
// declaring 24000 Hz for a track written at 48000 — anything trusting it read
// that timeline at half speed. The nominal rate is what the device said it
// would do; the fmt chunk is what it did. Only the second is a fact about the
// file, so it becomes authoritative and the first is kept alongside it under
// requested_sample_rate rather than discarded.
//
// Runs after the children are gone, because the readback line is written by
// miccap's SIGINT handler once the header has been patched. A failure here is
// logged and swallowed: the audio is already on disk and refusing to finish
// the capture over a metadata rewrite would be a worse outcome than a manifest
// that still carries the requested value.
function finalizeMicFormat(paths) {
    try {
        const log = fs.readFileSync(paths.micLog, 'utf8');
        const m = [...log.matchAll(
            /^readback format_tag=0x([0-9a-fA-F]+) channels=(\d+) sample_rate=(\d+) bits=(\d+) block_align=(\d+) data_bytes=(\d+) frames=(\d+) duration_s=([\d.]+)/gm,
        )].pop();
        if (!m) {
            console.error(`manifest: no readback line in ${paths.micLog} — mic format left as requested`);
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
        const track = (manifest.tracks || []).find(t => t.track === 'mic');
        if (!track) {
            console.error('manifest: no mic track to update');
            return;
        }
        // The device, from the same source, for the same reason. miccap
        // resolves kAudioHardwarePropertyDefaultInputDevice itself, so the name
        // readDevices() saw at start is a prediction — and the default input
        // can change between the two. A manifest naming a device that was not
        // the one recorded is the same class of lie as a wrong sample rate.
        // Last match, not first: logs are opened in append mode, so a reused
        // stem leaves earlier captures in the same file. Taking the first
        // device line and the last format line would describe two different
        // captures in one manifest entry.
        const d = [...log.matchAll(/^device=(.*) uid=(\S+) id=(\d+)$/gm)].pop();
        if (d) {
            track.requested_device_name = track.device_name;
            track.requested_device_uid = track.device_uid;
            track.device_name = d[1];
            track.device_uid = d[2];
            track.device_id = Number(d[3]);
            track.device_source = 'miccap_resolved_default_input';
            if (track.requested_device_uid !== track.device_uid) {
                console.error(
                    `manifest: mic device corrected ${track.requested_device_uid} -> ${track.device_uid} (default input changed between start and spawn)`);
            }
        } else {
            console.error(`manifest: no device line in ${paths.micLog} — mic device left as requested`);
        }

        track.requested_sample_rate = track.sample_rate;
        track.requested_sample_rate_source = track.sample_rate_source;
        track.sample_rate = Number(m[3]);
        track.sample_rate_source = 'wav_fmt_chunk_readback';
        track.format_tag = `0x${m[1].toLowerCase().padStart(4, '0')}`;
        track.channels = Number(m[2]);
        track.bits = Number(m[4]);
        track.block_align = Number(m[5]);
        track.data_bytes = Number(m[6]);
        track.frames = Number(m[7]);
        track.duration_s = Number(m[8]);
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
        if (track.requested_sample_rate !== track.sample_rate) {
            console.error(
                `manifest: mic rate corrected ${track.requested_sample_rate} -> ${track.sample_rate} from the written file`);
        }
    } catch (err) {
        console.error(`manifest: mic format readback failed: ${String(err)}`);
    }
}

// The same treatment for the tap track, and the more urgent half of it: the
// 2026-08-14 capture that declared 24000 Hz for a track written at 48000 was
// this field, not the mic's. coreaudio_nominal_output is what the output device
// said its rate was at capture start; systemtap reports the format of the tap
// stream it actually opened (kAudioTapPropertyFormat), which is what the bytes
// on disk are in.
//
// The tap file is headerless, so there is no fmt chunk to re-read — the format
// comes from systemtap's log and the byte count comes from the file itself,
// which is the part no log can be wrong about. If the two disagree the file
// wins and the discrepancy is logged.
//
// The tap's device is not read back: systemtap logs no device identity, so
// device_name/device_uid stay as readDevices() saw them. Noted rather than
// silently implied to be verified.
function finalizeTapFormat(paths) {
    try {
        const log = fs.readFileSync(paths.tapLog, 'utf8');
        const m = [...log.matchAll(
            /^format sample_rate=(\d+) channels=(\d+) bits=(\d+) is_float=(\w+) is_packed=(\w+)/gm,
        )].pop();
        if (!m) {
            console.error(`manifest: no format line in ${paths.tapLog} — tap format left as requested`);
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
        const track = (manifest.tracks || []).find(t => t.track === 'system');
        if (!track) {
            console.error('manifest: no system track to update');
            return;
        }
        const rate = Number(m[1]);
        const channels = Number(m[2]);
        const bits = Number(m[3]);

        // Ground truth for length. bytes_written is also logged, but a log line
        // is a claim about the file and the file is the file.
        let dataBytes = null;
        try { dataBytes = fs.statSync(paths.tap).size; } catch {}
        const claimed = [...log.matchAll(/^system_tap_stopped wall_ns=\d+ bytes_written=(\d+)/gm)].pop();
        if (claimed && dataBytes !== null && Number(claimed[1]) !== dataBytes) {
            console.error(
                `manifest: tap bytes_written=${claimed[1]} but file is ${dataBytes} — using the file`);
        }

        track.requested_sample_rate = track.sample_rate;
        track.requested_sample_rate_source = track.sample_rate_source;
        track.sample_rate = rate;
        track.sample_rate_source = 'systemtap_reported_tap_format';
        track.requested_channels = track.channels;
        track.channels = channels;
        track.bits = bits;
        track.is_float = m[4] === 'true';
        track.is_packed = m[5] === 'true';
        track.device_source = 'coreaudio_default_output_at_start';
        if (dataBytes !== null) {
            const blockAlign = (bits / 8) * channels;
            track.data_bytes = dataBytes;
            track.frames = blockAlign > 0 ? Math.floor(dataBytes / blockAlign) : null;
            track.duration_s = (rate > 0 && track.frames !== null)
                ? Number((track.frames / rate).toFixed(3))
                : null;
        }
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
        if (track.requested_sample_rate !== track.sample_rate) {
            console.error(
                `manifest: tap rate corrected ${track.requested_sample_rate} -> ${track.sample_rate} from systemtap's reported format`);
        }
    } catch (err) {
        console.error(`manifest: tap format readback failed: ${String(err)}`);
    }
}

function spawnChild(cmd, args, env, logPath) {
    const fd = fs.openSync(logPath, 'a');
    const proc = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'ignore', fd],
    });
    fs.closeSync(fd);
    return proc;
}

// --- tray icon ------------------------------------------------------------
//
// The tray was title-only, and a title-only item is sized by its text. When
// the status string grew from "Starting" to "Starting · Partial capture" the
// item silently disappeared from a full menu bar — macOS drops what does not
// fit, with no error and the app still running. An icon gives the item a fixed
// width it can never outgrow, so the failure cannot recur however the status
// vocabulary changes later. Status detail lives in the menu; the title stays
// down to a few characters.
//
// The icon is generated rather than shipped as an asset: a coloured dot is a
// few lines of PNG encoding, and that beats a binary file in the repo that
// nothing can diff.

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

// 32x32 RGBA dot, rendered at 16pt via scaleFactor 2.
function dotIcon(hex) {
    const size = 32, radius = 10, centre = (size - 1) / 2;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const raw = Buffer.alloc(size * (size * 4 + 1));
    let o = 0;
    for (let y = 0; y < size; y++) {
        raw[o++] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - centre, y - centre);
            // One pixel of feather at the edge, so it does not look jagged.
            const a = Math.max(0, Math.min(1, radius + 0.5 - d));
            raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = Math.round(a * 255);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    return nativeImage.createFromBuffer(png, { scaleFactor: 2 });
}

// Still here, and still the state palette — the drawn assets below use these
// same four hex values, and dotIcon remains the fallback when an asset cannot
// be read.
const DOT = {
    stopped:   '#8E8E93',
    starting:  '#FF9F0A',
    recording: '#FF453A',
    stalled:   '#FFD60A',
};

// --- the drawn marks (SAA-130) --------------------------------------------
//
// A hybrid, not a single variant, and the split is deliberate:
//
//   stopped    template   the resting state, and the one the icon spends
//   starting   template   almost all its life in. Its neighbours in the menu
//                         bar are all monochrome, so it should sit among them
//                         quietly and follow the bar from light to dark.
//   recording  colour     colour means "this needs you". Red while recording
//   stalled    colour     is macOS's own idiom, and yellow says attention.
//
// The colour variant was measured as nearly invisible in the stopped state —
// grey bars on a grey bar — and that is exactly the state in which finding
// Clipwise in the menu bar is already a known problem (SAA-105).
//
// Mixing the two on one Tray is only possible because template-ness is a
// property of each NativeImage rather than of the Tray. Confirmed rather than
// assumed, on both layers: AppKit redraws the same status item's button as
// colour -> template -> colour with no latching, and Electron preserves each
// image's flag across four alternating setImage calls. Tray exposes no
// template API at all, which is the structural reason there is nothing to
// latch.
//
// Both full variants stay on disk. Switching to all-template or all-colour is
// this table, and nothing else.
const TRAY_VARIANT = {
    stopped:   'template',
    starting:  'template',
    recording: 'colour',
    stalled:   'colour',
};

const TRAY_ASSET_DIR = BUILD_INFO
    ? path.resolve(__dirname, '..', 'tray')
    : path.join(__dirname, 'assets', 'tray');

// createFromPath picks up the @2x sibling on its own — verified, the loaded
// image reports scaleFactors [1,2] where a file with no sibling reports [1].
// So only the base name is ever named here.
function loadTrayIcon(s) {
    const template = TRAY_VARIANT[s] === 'template';
    const file = path.join(TRAY_ASSET_DIR, `${s}${template ? 'Template' : ''}.png`);
    let img = null;
    try {
        img = nativeImage.createFromPath(file);
    } catch (err) {
        console.error(`tray: ${file} failed to load: ${String(err)}`);
    }
    // createFromPath does NOT throw on a missing or unreadable file: it returns
    // an EMPTY image, and an empty image renders as no menu bar icon at all.
    // That is the same shape of silent failure this whole area keeps producing,
    // so it is checked rather than trusted, and the generated dot is still here
    // to fall back to. A plain icon beats an invisible one.
    if (!img || img.isEmpty()) {
        console.error(`tray: ${file} missing or empty — falling back to the generated dot`);
        return dotIcon(DOT[s]);
    }
    img.setTemplateImage(template);
    return img;
}

const ICON = {};
function iconFor(s) {
    if (!ICON[s]) ICON[s] = loadTrayIcon(s);
    return ICON[s];
}

// --- tray -----------------------------------------------------------------

// The learned list, and the way back from any answer given to it. This is what
// makes "never ask" reversible rather than a trap, so it is not optional
// decoration — a durable decline with no visible way to undo it would be the
// worst outcome of the whole design.
//
// A control surface only: which applications may start a capture, and nothing
// about meetings, recordings or transcripts. That is the line the milestone
// guardrail draws, and it is the reason this is allowed to exist at all.
function detectedAppsMenu() {
    if (!detectApps) detectApps = loadDetectApps();
    const displayName = key => displayNameForDetectedKey(key, detectApps[key]);
    const keys = Object.keys(detectApps).sort((a, b) =>
        displayName(a).localeCompare(displayName(b)));
    if (keys.length === 0) {
        return {
            label: 'Detected applications',
            submenu: [{ label: 'None yet — Clipwise asks the first time', enabled: false }],
        };
    }
    return {
        label: 'Detected applications',
        submenu: keys.map(key => {
            const entry = detectApps[key];
            const decisionLabel = entry.decision === 'record' ? 'Always record' : 'Never ask';
            return {
                label: `${displayName(key)} — ${decisionLabel}`,
                submenu: [
                    { label: 'Always record', type: 'radio', checked: entry.decision === 'record',
                      click: () => setAppDecision(key, 'record', entry.name) },
                    { label: 'Never ask', type: 'radio', checked: entry.decision === 'never',
                      click: () => setAppDecision(key, 'never', entry.name) },
                    { type: 'separator' },
                    // Back to unknown: the next time it uses the microphone
                    // Clipwise asks again, as if it had never been answered.
                    { label: 'Forget this app', click: () => setAppDecision(key, null) },
                ],
            };
        }),
    };
}

function renderTray() {
    const label = LABEL[state];
    const pipelineNote = pipeline && PIPELINE_NOTE[pipeline.state]
        ? PIPELINE_NOTE[pipeline.state](pipeline.stem)
        : null;
    const permNote = permissionIssue ? permissionIssue.note : null;

    // Title stays down to a few characters whatever the state vocabulary
    // grows into: a word for capture, and single glyphs for anything wanting
    // attention. Everything wordy is a menu item, which has room for it.
    const attention = permissionIssue || (pipeline && pipeline.state === 'failed');
    const title = [
        state === 'stopped' ? '' : 'Rec',
        pipeline && pipeline.state === 'running' ? '⚙' : '',
        // A live detection prompt is visible in the menu bar itself, so a
        // notification that never appeared is still recoverable (Decision #17).
        detectPending ? '?' : '',
        attention ? '⚠' : '',
    ].filter(Boolean).join(' ');
    tray.setImage(iconFor(state));
    tray.setTitle(title ? ` ${title}` : '');

    const active = state !== 'stopped';
    const items = [
        { label: `Status: ${label}`, enabled: false },
    ];
    if (pipelineNote) items.push({ label: pipelineNote, enabled: false });
    if (permNote) items.push({ label: permNote, enabled: false });
    // The live prompt, carried here as well as in the notification. These are
    // the same three answers; only the last one writes anything durable.
    if (detectPending) {
        const { key, name } = detectPending;
        items.push(
            { type: 'separator' },
            { label: `${name} is using the microphone`, enabled: false },
            { label: 'Always record this app', click: () => answerDetectPrompt(key, 'record') },
            { label: 'Not now', click: () => answerDetectPrompt(key, 'not_now') },
            { label: `Never ask about ${name}`, click: () => answerDetectPrompt(key, 'never') },
        );
    }
    items.push(
        { type: 'separator' },
        { label: 'Start', enabled: !active, click: startRecording },
        { label: 'Stop',  enabled:  active, click: stopRecording },
    );
    items.push({ type: 'separator' }, detectedAppsMenu());
    if (permissionIssue) {
        items.push({ type: 'separator' });
        for (const svc of permissionIssue.denied) {
            items.push({
                label: `Open ${svc} settings…`,
                click: () => shell.openExternal(SETTINGS_PANE[svc]),
            });
        }
        items.push({ label: 'Dismiss warning', click: () => { permissionIssue = null; renderTray(); } });
    }
    // A failed run is a menu item, not just a line in a log. Retry re-enters
    // the pipeline for that stem; it resumes from the first incomplete step.
    if (pipeline && pipeline.state === 'failed') {
        items.push(
            { type: 'separator' },
            { label: `Retry processing (${pipeline.stem})`, click: retryPipeline },
            { label: 'Dismiss failure', click: dismissPipelineFailure },
        );
    }
    items.push(
        { type: 'separator' },
        { label: 'About Clipwise', click: () => app.showAboutPanel() },
        { label: 'Quit', click: quitApp },
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
}

// --- notifications --------------------------------------------------------
//
// With the tray item evicted there is no permanent readout, so a notification
// is the only thing that says whether a capture started or stopped. Every
// notification here is therefore load-bearing rather than decorative, and
// every path that declines to start a capture has to fire one too — this is
// SAA-105's actual subject, and it is still open.
//
// Delivery is checked, not assumed. show() is fire-and-forget and returns
// nothing, so the obvious version of this function cannot tell a notification
// that appeared from one macOS dropped — which would be the same silent
// failure one layer further down. Measured on macOS 15 /
// Electron 43.3.0: with the signature the electron package ships, every single
// notification failed with UNErrorDomain error 1 and nothing was displayed
// while isSupported() still answered true. isSupported() is therefore not
// evidence of anything; the 'show' and 'failed' events are.
//
// fix-electron-signature.sh removes that cause at install time. The fallback
// below is for when it has not run, or when authorization is off for some other
// reason: osascript posts through a signed Apple binary that does not depend on
// how this app is signed. It is a worse notification — attributed to Script
// Editor rather than Clipwise — and it is still far better than silence, which
// is the only other option at that point.
//
// A failure of the fallback too is logged and swallowed. It is never worth
// losing a capture over.
function notifyFallback(title, body, why) {
    console.error(`notify: falling back to osascript (${why})`);
    // AppleScript has only double-quoted strings, and the status report is
    // multi-line. Backslash first, then the characters whose escapes are
    // backslashes, so the escaping is not itself re-escaped.
    const esc = s => String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
    const script =
        `display notification "${esc(body)}" with title "${esc(title)}"`;
    try {
        const proc = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
        proc.once('error', err => console.error(`notify fallback spawn failed: ${String(err)}`));
        proc.once('exit', code => {
            if (code !== 0) console.error(`notify fallback exited code=${code}`);
        });
    } catch (err) {
        console.error(`notify fallback failed: ${String(err)}`);
    }
}

function notify(title, body) {
    console.error(`notify: ${title} — ${body}`);
    if (!Notification.isSupported()) {
        notifyFallback(title, body, 'Notification.isSupported() is false');
        return;
    }
    try {
        const n = new Notification({ title, body });
        n.once('failed', (_event, err) => notifyFallback(title, body, String(err)));
        // The positive half of the same rule. No 'failed' line in the log is
        // absence of evidence — it reads identically to a notify() that was
        // never reached. 'show' is the event that says delivered, and once
        // this runs from a bundle the log is the only place anyone can see
        // either of them.
        n.once('show', () => console.error(`notify: delivered — ${title}`));
        n.show();
    } catch (err) {
        notifyFallback(title, body, String(err));
    }
}

// Natural-language duration for the stopped notification (SAA-187). Not
// reused by the identity prompt, which needs its own compact form ("23
// min") — this one spells the unit out because the notification has the
// room and nothing else on the line competing for it.
function formatDurationWords(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
    }
    const minutes = Math.round(totalSeconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Both halves of the started/stopped distinction the issue asks for, plus the
// two states in between. Reads `session` directly: every setState call happens
// while the session it describes is still assigned (teardown clears it only
// after stopRecording has already flipped the state).
function notifyStateChange(prev, next) {
    // 'starting' is deliberately silent (SAA-151). It fired roughly a second
    // before 'recording started' and said less: the useful fact is that both
    // tracks are writing, and until they are there is nothing to report that
    // the next notification does not report better. The tray already shows the
    // starting state, and a start that never reaches 'recording' still gets a
    // notification — the stopped branch below says nothing was saved.
    if (next === 'starting') return;
    if (next === 'recording' && prev === 'starting') {
        // Neither the stem nor a stop-style duration belongs here (SAA-187):
        // this fires while the person is sitting at the call being announced,
        // so it identifies nothing and doesn't need to — the recorder's
        // internal filename is not a fact about the call worth reading aloud
        // at the moment it starts.
        //
        // "Both tracks are writing" was Clipwise's internal model (mic +
        // system-audio tap), not what a user standing at the call wants to
        // know — which is whether it's getting the other side or only them.
        // That is exactly what the both-tracks check guarantees, so say that
        // instead. Not "the meeting" or "everyone on the call": there is
        // only ever one mixed far-side stream, not per-person audio
        // (SAA-94), and it only covers from this moment on (SAA-105) — both
        // would be over-claims in a notification the user is trusting.
        notify('Clipwise: recording started', session && session.trigger
            ? `Detected ${displayNameForDetectedKey(session.trigger.key, session.trigger)}. Capturing your mic and the call audio.`
            : 'Capturing your mic and the call audio.');
        return;
    }
    // The flapping pair.
    if (next === 'recording' || next === 'stalled') {
        const now = Date.now();
        if (now - lastFlapNotifyMs < FLAP_NOTIFY_MIN_MS) return;
        lastFlapNotifyMs = now;
        if (next === 'stalled') {
            notify('Clipwise: recording stalled',
                'A track stopped growing. The capture is still running.');
        } else {
            notify('Clipwise: recording resumed', 'Both tracks are writing again.');
        }
        return;
    }
    if (next === 'stopped') {
        // reachedRecording is what decides whether the pipeline runs, so it is
        // the honest thing to report: a capture that never got both tracks
        // going produced nothing and will not be processed. Unchanged by
        // SAA-187 — the stem is dropped from the branch above it, but a
        // duration on a capture that produced nothing would be its own kind
        // of wrong answer, so this stays its own branch rather than folding
        // a zero into the same sentence.
        const kept = session && session.reachedRecording;
        notify('Clipwise: recording stopped', kept
            ? `Recorded ${formatDurationWords(Date.now() - session.startedAtMs)}. Processing now.`
            : 'The capture never started — nothing was saved.');
    }
}

function setState(next) {
    const prev = state;
    state = next;
    renderTray();
    if (prev !== next) notifyStateChange(prev, next);
}

// --- call detection (SAA-113) ---------------------------------------------
//
// A process starts using the microphone; if it is an application we have been
// told to record, a capture starts; if we have never seen it, we ask. The
// signal comes from micwatch, which holds no policy — everything below is the
// policy, and all of it lives here rather than in the detector so that a
// change to it does not mean rebuilding a Swift binary.
//
// The sequence is detect -> ask -> capture -> ask who was on it at stop. It is
// deliberately not auto-record: a false positive costs a dismissable prompt
// rather than a wrong recording, which is what makes a bundle-ID filter
// adequate. Chrome cannot be distinguished from Chrome, so a browser voice
// message looks exactly like a Meet call and always will.

// A bundle ID where there is one, and the executable name where there is not.
// miccap and the other bare binaries have no bundle ID, and two different
// unbundled tools must not collapse onto the same empty key.
function detectKey(ev) {
    return ev.bundle ? ev.bundle : (ev.exe ? `exe:${ev.exe}` : null);
}

// The name a person would recognise, derived from the executable path rather
// than guessed from a table. Audio runs in helper processes, so both the
// bundle ID and the executable name describe the helper: Chrome's microphone
// is "Google Chrome Helper" / com.google.Chrome.helper, and Fathom's is
// "Fathom Helper". The parent application is the FIRST .app component of the
// path, which is exactly what those two nest inside:
//
//   /Applications/Google Chrome.app/Contents/Frameworks/…/Google Chrome Helper.app/…
//   /Applications/Fathom.app/Contents/Frameworks/Fathom Helper.app/…
//
// A process in no bundle at all — ffmpeg from Homebrew — has no .app in its
// path and keeps its own name, which is the honest answer for it. Only the
// displayed name changes; the bundle ID remains the matching key, so nothing
// about which process matched is affected by this.
function detectName(ev) {
    const full = ev.path || '';
    for (const part of full.split('/')) {
        if (part.endsWith('.app')) return part.slice(0, -4);
    }
    return ev.exe || ev.bundle || 'Unknown application';
}

function loadDetectApps() {
    try {
        const raw = JSON.parse(fs.readFileSync(DETECT_STORE_PATH, 'utf8'));
        if (raw && typeof raw === 'object' && raw.apps && typeof raw.apps === 'object') {
            return raw.apps;
        }
        console.error('detect: store has no apps object — starting empty');
    } catch (err) {
        // ENOENT is the normal first-run state: no list ships, so the file
        // does not exist until the first durable answer.
        if (err.code !== 'ENOENT') console.error(`detect: store unreadable (${String(err)}) — starting empty`);
    }
    return {};
}

// Written whole and only on a deliberate answer. Nothing on this path is
// reachable from a dismissed, ignored or expired prompt.
function saveDetectApps() {
    try {
        fs.mkdirSync(SUPPORT_DIR, { recursive: true });
        fs.writeFileSync(DETECT_STORE_PATH,
            JSON.stringify({ version: 1, apps: detectApps }, null, 2) + '\n');
        return true;
    } catch (err) {
        console.error(`detect: could not write store: ${String(err)}`);
        return false;
    }
}

function setAppDecision(key, decision, name) {
    if (!detectApps) detectApps = loadDetectApps();
    if (decision === null) delete detectApps[key];
    else detectApps[key] = { decision, name: name || (detectApps[key] && detectApps[key].name) || key,
                             updated_at: new Date().toISOString() };
    saveDetectApps();
    console.error(`detect: ${key} -> ${decision === null ? 'forgotten' : decision}`);
    renderTray();
}

function appDecision(key) {
    if (!detectApps) detectApps = loadDetectApps();
    const e = detectApps[key];
    return e ? e.decision : null;
}

// Clipwise's own capture, which holds the microphone for the whole recording.
// Checked by executable name and by the PIDs of the children this process
// spawned — the name alone would miss a renamed build, and the PIDs alone
// would miss a capture left running by a previous instance.
function isSelfCapture(ev) {
    if (ev.exe && DETECT_SELF_EXES.has(ev.exe)) return true;
    if (ev.pid === process.pid) return true;
    if (session) {
        for (const k of ['tap', 'mic', 'poller']) {
            const child = session[k];
            if (child && child.pid === ev.pid) return true;
        }
    }
    return false;
}

// Take the notification off the screen. An alert-style notification stays up
// until it is acted on, so without this an expired prompt leaves a clickable
// thing on screen whose backing state is gone — observed: prompted 15:34:22,
// expired 15:37:22, "record" clicked 15:40:02 and silently discarded.
//
// close() is the first line of defence and not the only one, for the same
// reason notify() has a fallback: nothing here can prove the notification
// actually went away. answerDetectPrompt therefore also handles an answer
// that arrives with no live prompt, rather than assuming this worked.
function withdrawPrompt(p) {
    if (!p || !p.notification) return;
    try { p.notification.close(); } catch (err) {
        console.error(`detect: could not withdraw notification: ${String(err)}`);
    }
}

// The prompt. Two surfaces on purpose.
//
// Architecture Decision #17 records that notification delivery is not reliably
// observable: show() returning is not evidence anything appeared, and two
// notifications during SAA-112 logged neither delivered nor failed. This
// prompt is the only thing standing between a detected call and no recording,
// so it cannot be the only surface.
//
// So the tray carries the same three choices for as long as the prompt is
// live, and the tray title shows a marker. If the notification never appears,
// the prompt is still there in the menu bar. If neither is noticed, the prompt
// expires to "not now" — which writes nothing, so the next call asks again.
// A missed prompt and a declined one are different states and only one of them
// is durable.
function promptForApp(ev, key) {
    const name = detectName(ev);
    detectLastPrompt.set(key, Date.now());
    detectPending = {
        key, name, pid: ev.pid, at: Date.now(),
        timer: setTimeout(() => {
            if (detectPending && detectPending.key === key) {
                console.error(`detect: prompt for ${key} expired — treated as "not now", nothing written`);
                withdrawPrompt(detectPending);
                detectPending = null;
                renderTray();
            }
        }, DETECT_PROMPT_TTL_MS),
    };
    renderTray();
    console.error(`detect: prompting for ${key} (pid ${ev.pid})`);

    // The buttons say what they do. Both write a durable rule for the
    // application, so neither is labelled as being about this one call —
    // "Record" over a rule that means "always record" is the same mismatch
    // as a decline that silently becomes permanent. Recording a single call
    // without deciding anything is what "Not now" is for — start it manually
    // from the tray if this one call should still be recorded.
    const title = `Clipwise: ${displayNameForDetectedKey(key, { name })} is using the microphone`;
    const body = 'Record calls from this app?';
    if (!Notification.isSupported()) {
        notifyFallback(title, `${body} Choose from the Clipwise menu bar icon.`,
            'Notification.isSupported() is false');
        return;
    }
    try {
        const n = new Notification({
            title, body,
            // macOS shows the first action as the button and the rest on the
            // expanded alert. "Never" is last deliberately: it is the only
            // durable decline and must not be the easy thing to hit.
            actions: [
                { type: 'button', text: 'Always record' },
                { type: 'button', text: 'Never ask about this app' },
            ],
            closeButtonText: 'Not now',
        });
        n.once('failed', (_e, err) => notifyFallback(title,
            `${body} Choose from the Clipwise menu bar icon.`, String(err)));
        n.once('show', () => console.error(`notify: delivered — ${title}`));
        n.on('action', (_e, index) => {
            if (index === 0) answerDetectPrompt(key, 'record');
            else if (index === 1) answerDetectPrompt(key, 'never');
        });
        // Closing, ignoring or letting it time out are all the same answer,
        // and that answer writes nothing. There is no 'close' handler here on
        // purpose: there is nothing to do.
        n.show();
        // Kept so the prompt can be taken down again when it lapses.
        if (detectPending && detectPending.key === key) detectPending.notification = n;
    } catch (err) {
        notifyFallback(title, `${body} Choose from the Clipwise menu bar icon.`, String(err));
    }
}

// The only path that writes durable state, and it is only ever reached from a
// notification button or a tray click.
//
// An answer can arrive after its prompt has lapsed, because withdrawPrompt
// cannot prove the notification left the screen. Discarding it silently is
// what lost a capture: a person clicked a visible button and nothing
// happened, with no way to tell that from a recording that had started.
//
// So a late answer is honoured rather than dropped. Both durable answers are
// about the application rather than about one call, so neither is made wrong
// by arriving three minutes later — "never ask about this app" means the same
// thing whenever it is clicked. What lateness changes is only whether there is
// still a call to record, and that is checked rather than assumed.
//
// This does not alter what the expiry itself does. Expiry is still "not now"
// and still writes nothing; it is a subsequent deliberate click that writes,
// exactly as it would have inside the window.
function answerDetectPrompt(key, choice) {
    const live = !!(detectPending && detectPending.key === key);
    let name;
    if (live) {
        name = detectPending.name;
        clearTimeout(detectPending.timer);
        withdrawPrompt(detectPending);
        detectPending = null;
    } else {
        const known = detectApps && detectApps[key];
        const active = detectActive.get(key);
        name = (active && active.name) || (known && known.name) || key;
        console.error(`detect: answer "${choice}" for ${key} arrived after its prompt lapsed`);
    }
    // name is what gets stored (setAppDecision, below) — the raw process-
    // derived name, matching what detectApps itself carries. displayName is
    // what the user reads: the same label preference as the tray (SAA-135).
    const displayName = displayNameForDetectedKey(key, { name });

    if (choice === 'not_now') {
        console.error(`detect: "not now" for ${key} — nothing written`);
        renderTray();
        return;
    }
    if (choice === 'never') {
        setAppDecision(key, 'never', name);
        // The one line of explanation the design allows, and it belongs here
        // rather than in the prompt: the prompt fires as a call is starting,
        // which is the worst moment to ask anyone to read anything.
        notify('Clipwise: will not ask about this app',
            `${displayName} will no longer offer to record. Turn it back on from the Clipwise menu bar.`);
        return;
    }
    if (choice === 'record') {
        setAppDecision(key, 'record', name);
        if (live) {
            startRecording();
            return;
        }
        // Late. If the application is still holding the microphone the call is
        // still going, so the click means what it said and the capture starts.
        if (detectActive.has(key)) {
            notify('Clipwise: starting now',
                `That prompt had lapsed, but ${displayName} is still using the microphone — recording now.`);
            startRecording();
            return;
        }
        // The call is genuinely over, which is the case the expiry exists for.
        // Nothing is recorded — there is nothing left to record — and the one
        // thing that must not happen is silence about it.
        notify('Clipwise: that prompt had lapsed',
            `${displayName} is no longer using the microphone, so nothing was recorded. `
            + 'Clipwise will record it automatically from now on.');
    }
}

function handleDetectEvent(ev) {
    if (ev.event === 'ready') {
        // A restarted detector has no memory of what was running, and neither
        // should this: anything still holding the microphone reports again on
        // its first poll.
        detectActive.clear();
        console.error(`detect: micwatch ready (poll ${ev.poll_ms}ms)`);
        return;
    }
    if (ev.event === 'in_stop') {
        const stopKey = detectKey(ev);
        if (stopKey) detectActive.delete(stopKey);
        return;
    }
    if (ev.event !== 'in_start') return;
    if (isSelfCapture(ev)) {
        console.error(`detect: ignoring own capture — ${ev.exe || ev.bundle} pid ${ev.pid}`);
        return;
    }
    const key = detectKey(ev);
    if (!key) return;
    const name = detectName(ev);
    detectActive.set(key, { pid: ev.pid, name });

    const decision = appDecision(key);
    // Refresh a stored display name once a better one can be derived. Entries
    // written before the name came from the bundle path still read "Google
    // Chrome Helper", and the tray would go on showing that forever because an
    // application that is not running offers no path to derive from. Display
    // only: the key, the decision and everything matched on are untouched.
    const known = detectApps && detectApps[key];
    if (known && known.name !== name) {
        console.error(`detect: display name for ${key} refreshed "${known.name}" -> "${name}"`);
        known.name = name;
        saveDetectApps();
        renderTray();
    }
    if (decision === 'never') {
        console.error(`detect: ${key} is set to never ask — ignored`);
        return;
    }
    // A capture already running is the answer to "should we record this".
    if (state !== 'stopped' || session) {
        console.error(`detect: ${key} started input while already ${state} — no action`);
        return;
    }
    if (decision === 'record') {
        console.error(`detect: ${key} is allowed — starting capture`);
        // No notification here (SAA-151). This fired, then 'capture starting',
        // then 'recording started' — three for one event, all within about a
        // second. The one fact this carried that the others did not is the
        // application name, which now rides on 'recording started'.
        //
        // Carries the key alongside the name (SAA-170): the name is what a
        // person reads, the key is what the scope mapping matches on — the
        // same distinction detectApps already draws, for the same reason
        // (a display name can be refreshed later; the bundle ID cannot).
        pendingStartTrigger = { key, name: detectName(ev) };
        startRecording();
        return;
    }
    if (detectPending) {
        console.error(`detect: ${key} seen while a prompt for ${detectPending.key} is live — skipped`);
        return;
    }
    const last = detectLastPrompt.get(key);
    if (last && Date.now() - last < DETECT_REPROMPT_MS) {
        console.error(`detect: ${key} asked about ${Math.round((Date.now() - last) / 1000)}s ago — not re-asking`);
        return;
    }
    promptForApp(ev, key);
}

// Long-lived, and restarted if it dies: a detector that quietly stopped is the
// same shape of silent failure this file works to avoid elsewhere. Its death
// never touches a capture in progress.
let detectRestartTimer = null;
function startDetector() {
    if (detectProc || detectRestartTimer) return;
    if (!fs.existsSync(MICWATCH_BIN)) {
        console.error(`detect: ${MICWATCH_BIN} missing — call detection disabled`);
        return;
    }
    let proc;
    try {
        proc = spawn(MICWATCH_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        console.error(`detect: could not spawn micwatch: ${String(err)}`);
        return;
    }
    detectProc = proc;
    console.error(`detect: micwatch spawned pid=${proc.pid}`);
    let buf = '';
    proc.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { console.error(`detect: unparsed line ${line}`); continue; }
            try { handleDetectEvent(ev); } catch (err) { console.error(`detect: handler threw ${String(err)}`); }
        }
    });
    proc.stderr.on('data', d => console.error(`micwatch: ${d.toString('utf8').trim()}`));
    proc.once('error', err => console.error(`detect: micwatch error ${String(err)}`));
    proc.once('exit', (code, signal) => {
        console.error(`detect: micwatch exited code=${code} signal=${signal}`);
        if (detectProc === proc) detectProc = null;
        if (isQuitting) return;
        detectRestartTimer = setTimeout(() => { detectRestartTimer = null; startDetector(); }, 3000);
    });
}

function stopDetector() {
    if (detectRestartTimer) { clearTimeout(detectRestartTimer); detectRestartTimer = null; }
    if (detectProc) { try { detectProc.kill('SIGTERM'); } catch {} detectProc = null; }
}

// --- pipeline -------------------------------------------------------------

// Spawned detached and unref'd so it survives the app quitting: a capture
// that has already ended should still become moments even if the user quits
// while it is being transcribed. The exit listener still fires for as long as
// this process is alive, which is what drives the tray.
function startPipeline(stem, opts = {}) {
    if (!stem) return;
    const logPath = path.join(OUTDIR, `pipeline-${stem}.log`);
    const args = [PIPELINE_ENTRY, OUTDIR, '--stem', stem];
    if (opts.force) args.push('--force-extract');
    let fd;
    try {
        fd = fs.openSync(logPath, 'a');
        fs.writeSync(
            fd,
            `\n[clipwise-recorder] ${new Date().toISOString()} pipeline start ` +
            `stem=${stem}${opts.force ? ' force-extract' : ''}\n`,
        );
    } catch (err) {
        console.error(`pipeline log ${logPath}: ${String(err)}`);
        return;
    }
    const proc = spawn(TSX_BIN, args, {
        cwd: SERVER_DIR,
        env: { ...process.env, PATH: PIPELINE_PATH },
        stdio: ['ignore', fd, fd],
        detached: true,
    });
    fs.closeSync(fd);
    proc.unref();
    pipeline = { stem, state: 'running', proc };
    renderTray();

    proc.once('error', (err) => {
        try {
            fs.appendFileSync(logPath, `[clipwise-recorder] spawn failed: ${String(err)}\n`);
        } catch {}
        if (pipeline && pipeline.proc === proc) {
            pipeline = { stem, state: 'failed', proc: null };
            renderTray();
        }
    });
    proc.once('exit', (code, signal) => {
        if (!pipeline || pipeline.proc !== proc) return;
        if (code === 0) {
            pipeline = null;
        } else {
            try {
                fs.appendFileSync(
                    logPath,
                    `[clipwise-recorder] pipeline exited code=${code} signal=${signal} — ` +
                    `see pipeline-${stem}.json for the failing step\n`,
                );
            } catch {}
            pipeline = { stem, state: 'failed', proc: null };
            // The unattended retry (SAA-136). The tray still shows the failure
            // and still offers Retry, but neither is now the only way back:
            // this capture is outstanding as far as the database is concerned,
            // so the recovery pass will pick it up and finish it. Bounded at
            // three attempts per capture with a cooldown between them, so a
            // capture that fails for a reason retrying cannot fix stops on its
            // own rather than spinning.
            //
            // watchStem is what withdraws the failure once recovery actually
            // lands it (SAA-183) — see startRecovery's own comment for the
            // exact condition. Recovery running, or even completing without
            // reporting this stem complete, changes nothing here.
            startRecovery(`pipeline failed stem=${stem}`, { watchStem: stem });
        }
        renderTray();
    });
}

// --- recovery (SAA-136) ---------------------------------------------------
//
// The unattended half of processing. Runs on launch and after a pipeline run
// fails, works out what is outstanding by asking the database, and finishes
// it. Nothing here touches the tray: the point is that a capture whose
// processing died gets finished without the user learning it ever happened.
//
// Detached and unref'd for the same reason the pipeline is — a recovery that
// started should not be killed by the user quitting a minute later. No exit
// listener: nothing in the UI depends on the outcome, and the pass reports
// itself into recovery.log.
//
// Deliberately never spawned from the recovery pass's own result. It runs the
// pipeline in-process rather than through startPipeline, so a failure inside
// it cannot re-enter here; the only triggers are launch and a foreground
// pipeline run failing.
let recoveryProc = null;

// Only these mean isComplete() is true for a stem right now — see
// recover.ts's own comment on Attempts.last_action, which is what this is
// read against.
const RECOVERY_COMPLETE_ACTIONS = new Set(['complete', 'recovered']);

function startRecovery(reason, opts = {}) {
    // One at a time. The pass is sequential and can take minutes on a backlog;
    // a second one would race it for the same captures and the same API quota.
    if (recoveryProc) {
        console.error(`[clipwise-recorder] recovery already running — skipping trigger (${reason})`);
        return;
    }
    const logPath = path.join(OUTDIR, 'recovery.log');
    let fd;
    try {
        fd = fs.openSync(logPath, 'a');
        fs.writeSync(fd, `\n[clipwise-recorder] ${new Date().toISOString()} recovery start (${reason})\n`);
    } catch (err) {
        console.error(`recovery log ${logPath}: ${String(err)}`);
        return;
    }
    // Recorded here, before spawn, not read from the recovery file's own
    // last_action_at: a pass that aborts before reaching this stem at all
    // (loadDbState throwing on a network error, SAA-156) leaves the file
    // holding whatever a PREVIOUS pass wrote. Comparing against this instant
    // is what stops that stale value from being read as "this pass cleared
    // it" (SAA-183).
    const triggeredAtMs = Date.now();
    // stdout and stderr both go straight to the log fd, as before recovery
    // was ever watched for anything: recovery is spawned detached specifically
    // so it survives the app quitting mid-pass, and a piped stdout would leave
    // it writing to a closed pipe (EPIPE) if that happens — a mid-write crash
    // in exactly the process this exists to make crashes safe from. The
    // withdrawal check below reads a file after the fact instead (SAA-183).
    const proc = spawn(TSX_BIN, [RECOVER_ENTRY, OUTDIR], {
        cwd: SERVER_DIR,
        env: { ...process.env, PATH: PIPELINE_PATH },
        stdio: ['ignore', fd, fd],
        detached: true,
    });
    fs.closeSync(fd);
    proc.unref();
    recoveryProc = proc;
    proc.once('error', (err) => {
        try {
            fs.appendFileSync(logPath, `[clipwise-recorder] recovery spawn failed: ${String(err)}\n`);
        } catch {}
        if (recoveryProc === proc) recoveryProc = null;
    });
    proc.once('exit', (code, signal) => {
        try {
            fs.appendFileSync(
                logPath,
                `[clipwise-recorder] recovery exited code=${code} signal=${signal}\n`,
            );
        } catch {}
        if (recoveryProc === proc) recoveryProc = null;
        // Read after the process is gone, not during — recovery.ts writes
        // recovery-<stem>.json before this exits, so there is no race. Only
        // withdraw a failure that is still this exact stem: Retry, a new
        // capture, or a later recovery pass could have replaced `pipeline`
        // with something else in the meantime.
        if (opts.watchStem && pipeline && pipeline.stem === opts.watchStem && pipeline.state === 'failed') {
            const recoveryFile = path.join(OUTDIR, `recovery-${opts.watchStem}.json`);
            let record = null;
            try {
                record = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
            } catch {}
            const actionAtMs = record && record.last_action_at ? Date.parse(record.last_action_at) : NaN;
            // Stale-read guard: last_action must have been written by THIS
            // pass, not left over from an earlier one this pass never got to
            // (e.g. it aborted in loadDbState before reaching this stem).
            if (
                record &&
                RECOVERY_COMPLETE_ACTIONS.has(record.last_action) &&
                Number.isFinite(actionAtMs) &&
                actionAtMs > triggeredAtMs
            ) {
                pipeline = null;
                renderTray();
            }
        }
    });
}

function retryPipeline() {
    if (!pipeline || pipeline.state !== 'failed') return;
    startPipeline(pipeline.stem);
}

// Clears the tray badge only. The sidecar keeps the failure — dismissing is
// about the menu bar, not about deciding the capture was fine.
function dismissPipelineFailure() {
    if (!pipeline || pipeline.state !== 'failed') return;
    pipeline = null;
    renderTray();
}

// --- identity (SAA-114) ---------------------------------------------------
//
// The prompt is strictly downstream of the audio. It is created from
// teardown's completion callback, after the children are gone, after the
// manifest has been finalised and after the pipeline has been spawned — so
// there is no path by which answering it, ignoring it, or failing to draw it
// can stop, delay, shorten or discard a capture. Dismissed or ignored, the
// recording is unidentified and otherwise intact.
//
// The trigger is the capture stopping, whatever stopped it: the tray item, a
// child dying, the start deadline expiring. All three already funnel through
// stopRecording, and nothing here detects anything on its own.
//
// Quit is the one stop that cannot prompt — the process is on its way out and
// a window cannot outlive it. That capture is unidentified, which is the
// tolerated outcome rather than a special case worth blocking a quit over.

// Writing the answer is identity-answer.js's job — see the note there on why
// the file is where it is and why a rename is what puts it in place. This is
// the reporting half: what was written, for the log a packaged app leaves
// behind.
function writeIdentityAnswer(capture, answer) {
    const doc = buildAnswerDoc({
        stem: capture.stem,
        recordingId: capture.recordingId,
        names: answer.names,
        selfName: answer.selfName,
        scope: answer.scope,
    });
    const finalPath = writeAnswer(OUTDIR, doc);
    console.error(
        `[clipwise-recorder] identity ${capture.stem}: ` +
        `self=${JSON.stringify(answer.selfName)} guests=${JSON.stringify(answer.names)} ` +
        `scope=${JSON.stringify(doc.scope)} -> ${finalPath}`);
    return finalPath;
}

// Spawned on every answer, not only on late ones. Ingest reads the same file
// itself, so the two overlap by design: this process cannot know whether the
// detached pipeline has already passed ingest, and an answer that arrives
// after it would otherwise sit on disk unread. The step no-ops when the
// recording row does not exist yet and inserts only names it does not already
// have, so running it always is the cheap half of the choice.
function startApplyIdentity(stem) {
    const logPath = path.join(OUTDIR, `identity-${stem}.log`);
    let fd;
    try {
        fd = fs.openSync(logPath, 'a');
        fs.writeSync(fd, `\n[clipwise-recorder] ${new Date().toISOString()} apply-identity stem=${stem}\n`);
    } catch (err) {
        console.error(`identity log ${logPath}: ${String(err)}`);
        return;
    }
    try {
        const proc = spawn(TSX_BIN, [APPLY_IDENTITY_ENTRY, OUTDIR, '--stem', stem], {
            cwd: SERVER_DIR,
            env: { ...process.env, PATH: PIPELINE_PATH },
            stdio: ['ignore', fd, fd],
            detached: true,
        });
        proc.unref();
        proc.once('error', (err) => {
            try {
                fs.appendFileSync(logPath, `[clipwise-recorder] spawn failed: ${String(err)}\n`);
            } catch {}
        });
    } catch (err) {
        console.error(`identity: apply spawn failed: ${String(err)}`);
    } finally {
        fs.closeSync(fd);
    }
}

// Asked once, then reused. Kept beside the recordings rather than in the
// capture directory: it is a fact about the person, not about one capture.
function readSelfName() {
    try {
        const doc = JSON.parse(fs.readFileSync(SELF_PATH, 'utf8'));
        return typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : null;
    } catch {
        return null;
    }
}

function writeSelfName(name) {
    if (!name) return;
    try {
        fs.mkdirSync(SUPPORT_DIR, { recursive: true });
        fs.writeFileSync(
            SELF_PATH,
            JSON.stringify({ name, set_at: new Date().toISOString() }, null, 2) + '\n');
    } catch (err) {
        console.error(`identity: could not remember your name: ${String(err)}`);
    }
}

function promptForIdentity(capture) {
    if (!capture || !capture.stem) return;
    identityQueue.push({ ...capture, token: randomUUID() });
    pumpIdentityQueue();
}

function pumpIdentityQueue() {
    if (identityWindow || identityQueue.length === 0) return;
    const capture = identityQueue[0];
    let win;
    try {
        win = new BrowserWindow({
            // Content box, not frame: the page measures its own content and
            // asks for a height (identity:resize), and a frame-sized window
            // would apply that measurement to the wrong box and clip by the
            // height of the title bar.
            useContentSize: true,
            width: IDENTITY_WINDOW.width,
            // Created at the full height from the start, then shrunk once
            // the page reports its real size (SAA-186). Starting small and
            // growing after load — the previous behaviour — corrupted the
            // known-names checklist whenever the grow crossed into territory
            // the hidden window had never painted: created at 220px, resized
            // to a clamped 560px, the newly-exposed 220-560 band showed a
            // stale/torn composite on first show(), reproducibly, on both
            // the dev Electron binary and the signed packaged app. Creating
            // at maxHeight and only ever shrinking from here never exposes
            // unpainted territory — confirmed by the same repro with the
            // creation height flipped and nothing else changed. The window
            // is still hidden until reveal(), so a short dialog never
            // visibly flashes the taller size.
            height: IDENTITY_WINDOW.maxHeight,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            title: 'Who was on this call?',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        // A prompt that cannot be drawn leaves the recording unidentified. The
        // capture is already on disk and already in the pipeline.
        console.error(`identity: could not open the prompt: ${String(err)}`);
        identityQueue.shift();
        return;
    }
    identityWindow = { win, capture, shown: false };
    // Shown once, by whichever comes first: the page's own height message, or
    // a deadline. The deadline is what stops a broken measurement from leaving
    // the prompt invisible — a window nobody can see is worse than one sized
    // to the minimum, and the layout keeps the buttons reachable either way.
    const reveal = () => {
        if (!identityWindow || identityWindow.win !== win || identityWindow.shown) return;
        identityWindow.shown = true;
        win.show();
        // An accessory app's window opens behind whatever is in front. The
        // question is about the call that just ended, so it is asked now or
        // not at all.
        try { app.focus({ steal: true }); } catch {}
    };
    identityWindow.reveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, IDENTITY_REVEAL_GRACE_MS));
    win.once('closed', () => {
        identityWindow = null;
        pumpIdentityQueue();
    });
    win.loadFile(IDENTITY_HTML, {
        query: {
            token: capture.token,
            stem: capture.stem,
            self: readSelfName() || '',
            // SAA-169: names from every previous answer on this machine, so
            // the page can offer them as a pick-list instead of requiring
            // them to be retyped. Small (JSON array of strings) and local —
            // a directory scan, not a network or DB call — so this stays
            // synchronous with the rest of window setup.
            knownNames: JSON.stringify(knownGuestNames(OUTDIR)),
            // SAA-170: which scope the triggering app implies, or '' for no
            // inference (a manual start, or an app with no entry) — the page
            // pre-selects this and nothing else, never defaulting on its own.
            inferredScope: capture.inferredScope === 'work' || capture.inferredScope === 'personal'
                ? capture.inferredScope : '',
            // SAA-187: milliseconds, as a string — '' when unavailable rather
            // than omitted, matching inferredScope's convention so the page
            // can tell "not provided" from "provided as zero".
            duration: Number.isFinite(capture.durationMs) ? String(capture.durationMs) : '',
        },
    }).catch((err) => {
        console.error(`identity: prompt failed to load: ${String(err)}`);
        try { win.close(); } catch {}
    });
}

// Closes the window for `token` if it is the one on screen, and takes that
// capture off the queue. Returns the capture, or null when the message came
// from a window that has already been dealt with.
function claimIdentityPrompt(token) {
    if (!identityWindow || identityWindow.capture.token !== token) return null;
    const capture = identityWindow.capture;
    identityQueue.shift();
    try { identityWindow.win.close(); } catch {}
    return capture;
}

function registerIdentityIpc() {
    // The page reporting how tall it needs to be. Sized before it is shown, so
    // the prompt never appears at one height and jumps to another.
    ipcMain.on('identity:resize', (_event, payload) => {
        if (!identityWindow || !payload || identityWindow.capture.token !== payload.token) return;
        const height = contentHeightFor(payload.height);
        try {
            identityWindow.win.setContentSize(IDENTITY_WINDOW.width, height);
        } catch (err) {
            console.error(`identity: could not size the prompt: ${String(err)}`);
        }
        console.error(
            `[clipwise-recorder] identity ${identityWindow.capture.stem}: ` +
            `prompt content ${IDENTITY_WINDOW.width}x${height} (page asked for ${payload.height})`);
        identityWindow.reveal();
    });

    ipcMain.on('identity:submit', (_event, payload) => {
        const capture = claimIdentityPrompt(payload && payload.token);
        if (!capture) return;
        // SAA-169: guests are known names the person checked off, plus
        // anyone typed into the "someone new" field — merged and deduped in
        // identity-answer.js so a known name checked AND (redundantly)
        // retyped still only counts once.
        const names = mergeGuestNames(payload.selectedNames, payload.newNames);
        const selfName = String(payload.self || '').trim() || null;
        // SAA-170: no default here. 'work' used to be assumed whenever
        // nothing else was chosen — but now that an actual signal exists for
        // the common case (the detected app), assuming a value indistinguishable
        // from a deliberate one is worse than leaving scope unset when there
        // truly is no basis for either. identity.html only sends 'work' or
        // 'personal' when a button is actually active (inferred or clicked);
        // anything else means neither was, and null is the honest answer.
        const scope = payload.scope === 'personal' || payload.scope === 'work' ? payload.scope : null;
        writeSelfName(selfName);
        try {
            writeIdentityAnswer(capture, { names, selfName, scope });
        } catch (err) {
            // The answer is lost; the capture is not. Say so where it can be
            // read rather than pretending it was written.
            console.error(`identity: could not write the answer for ${capture.stem}: ${String(err)}`);
            notify('Clipwise: identity not saved',
                `Who was on ${capture.stem} could not be written — the recording is unidentified.`);
            return;
        }
        startApplyIdentity(capture.stem);
    });

    ipcMain.on('identity:skip', (_event, payload) => {
        const capture = claimIdentityPrompt(payload && payload.token);
        if (!capture) return;
        console.error(`[clipwise-recorder] identity ${capture.stem}: skipped — recording is unidentified`);
    });
}

// --- lifecycle ------------------------------------------------------------

function startRecording() {
    // Consumed before the guard, not after: a trigger describes the start
    // attempt being made now. Leaving it set when this returns early would
    // label some later manual start with an application that had nothing to
    // do with it.
    const trigger = pendingStartTrigger;
    pendingStartTrigger = null;
    // SAA-170: computed once, here, from whichever app (if any) triggered
    // this specific start — never re-derived later from a stale global, for
    // the same reason `trigger` itself is consumed immediately above.
    const inferredScope = trigger ? scopeForDetectedKey(trigger.key) : null;
    if (state !== 'stopped' || session) return;
    fs.mkdirSync(OUTDIR, { recursive: true });
    const stamp = utcStamp();
    const startedAt = new Date().toISOString();
    const paths = {
        tap:      path.join(OUTDIR, `system-${stamp}.f32le.pcm`),
        tapLog:   path.join(OUTDIR, `systemtap-${stamp}.log`),
        mic:      path.join(OUTDIR, `mic-${stamp}.wav`),
        micLog:   path.join(OUTDIR, `mic-${stamp}.log`),
        pollLog:  path.join(OUTDIR, `poller-${stamp}.log`),
        manifest: path.join(OUTDIR, `manifest-${stamp}.json`),
    };
    let dev, manifest;
    try {
        dev = readDevices();
    } catch (err) {
        console.error(String(err));
        notify('Clipwise: capture not started',
            'Could not read the audio devices — see the recorder log.');
        return;
    }

    // Any denied grant refuses the capture.
    //
    // The earlier policy started anyway on one denial, reasoning that half a
    // conversation beats none. A denied microphone cannot produce a half:
    // avfoundation refuses the device outright — "Failed to create AV capture
    // input device" — so no mic file is ever created, the start gate never
    // sees both tracks grow, and the capture is torn down at the timeout
    // having discarded the real system audio it did capture. Measured: 8.9s,
    // 99.3% nonzero, thrown away while the tray said the capture never
    // started. Making that half reachable means changing the start gate, the
    // timeout, the child-death teardown and the transcribe step, for a
    // one-sided track of low standalone value.
    //
    // Start is always a manual click, so someone is present to act: one toggle
    // buys a whole recording rather than half of one. This is only about
    // START — a track dying mid-capture is a different case, and the
    // classifier's keep-with-flag path still exists for it.
    const denied = deniedServices(dev);
    if (denied.length) {
        permissionIssue = {
            denied,
            blocked: true,
            note: denied.length === 2
                ? 'Both audio permissions are off — capture would record nothing'
                : `${denied[0]} permission is off — fix it to record`,
        };
        renderTray();
        console.error(`start refused: denied permissions: ${denied.join(', ')}`);
        notify('Clipwise: capture not started', permissionIssue.note);
        return;
    }
    permissionIssue = null;

    try {
        manifest = buildManifest(stamp, startedAt, dev, paths, trigger);
        // Written before the children spawn, so no audio file can exist
        // without one. OUTDIR was just created, so a failure here means the
        // directory is unwritable and the capture would have been lost
        // anyway — refusing is honest, and leaves nothing half-formed.
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
    } catch (err) {
        console.error(String(err));
        notify('Clipwise: capture not started',
            'Could not write the capture manifest — see the recorder log.');
        return;
    }
    const tapProc = spawnChild(
        SYSTEMTAP_BIN, [],
        { ...process.env, SYSTEMTAP_OUT: paths.tap },
        paths.tapLog,
    );
    // miccap, not ffmpeg (SAA-106). ffmpeg's avfoundation input delivered a
    // rate-independent ~42,000 samples/s ceiling, losing 10.7–12.0% of every
    // built-in-mic capture and silently compressing the mic timeline against
    // the tap. miccap reads the default input device off the Core Audio HAL
    // directly — same API family as systemtap — and measured +0.029% over 60 s
    // against ffmpeg's +11.72% on the same test.
    //
    // It takes the device from kAudioHardwarePropertyDefaultInputDevice itself
    // rather than being handed a name, so dev.inName is no longer passed. The
    // two can only disagree if the default input changes between readDevices()
    // and the spawn, which the poller already watches for.
    const micProc = spawnChild(
        MICCAP_BIN, [paths.mic],
        process.env,
        paths.micLog,
    );
    const pollProc = spawnChild(
        AUDIODEVS_BIN, ['--poll'],
        process.env,
        paths.pollLog,
    );
    session = {
        tap: tapProc, mic: micProc, poller: pollProc,
        paths,
        stem: stamp,
        recordingId: manifest.recording_id,
        // Which application's microphone use started this, or null when a
        // person did. Read by the 'recording started' notification (.name)
        // and, at stop, carried onto the identity prompt (SAA-170).
        trigger,
        inferredScope,
        // Wall clock at spawn, for the elapsed figure the stop notification
        // reports. Separate from the manifest's started_at, which is an ISO
        // string for consumers downstream.
        startedAtMs: Date.now(),
        perms: { mic: dev.micPerm, tap: dev.tapPerm },
        // Set once both tracks have produced bytes. A capture that never got
        // there has nothing worth transcribing, so it does not trigger the
        // pipeline — see stopRecording.
        reachedRecording: false,
        growth: { tap: { size: 0, ts: 0 }, mic: { size: 0, ts: 0 } },
        timers: {},
    };
    // Only capture-child exits drive state. Poller death is not fatal.
    tapProc.once('exit', () => onCaptureChildExit('tap'));
    micProc.once('exit', () => onCaptureChildExit('mic'));
    session.timers.starting = setTimeout(onStartingTimeout, STARTING_TIMEOUT_MS);
    session.timers.poll = setInterval(pollTick, POLL_INTERVAL_MS);
    setState('starting');
}

function onCaptureChildExit(which) {
    if (state === 'stopped' || teardownInFlight) return;
    // Record the unexpected exit in the child's own log — otherwise the
    // teardown that follows leaves no trace of who died.
    if (session) {
        const proc    = which === 'tap' ? session.tap    : session.mic;
        const logPath = which === 'tap' ? session.paths.tapLog : session.paths.micLog;
        const line = `[clipwise-recorder] ${new Date().toISOString()} ` +
                     `recording_id=${session.recordingId} ` +
                     `child=${which} exited unexpectedly ` +
                     `code=${proc.exitCode} signal=${proc.signalCode}\n`;
        try { fs.appendFileSync(logPath, line); } catch {}
    }
    stopRecording();
}

// A capture that never produced a byte on both tracks. SAA-90 already catches
// and tears this down; all that is added here is saying why it probably
// happened. A tap blocked inside Core Audio setup waiting on an unanswered
// prompt looks exactly like this, and the permission state read at start is
// the evidence that distinguishes it from a plain failure to start.
function onStartingTimeout() {
    if (state !== 'starting') return;
    const perms = session ? session.perms : null;
    const pending = perms
        ? ['mic', 'tap'].filter(k => perms[k] === 'notDetermined')
        : [];
    const why = pending.length
        ? `a permission prompt may be waiting (${pending.map(k => `${k}_perm=notDetermined`).join(' ')})`
        : 'no bytes on either track before the deadline';
    if (session) {
        const line = `[clipwise-recorder] ${new Date().toISOString()} ` +
                     `capture never started — ${why}\n`;
        try { fs.appendFileSync(session.paths.tapLog, line); } catch {}
    }
    if (pending.length) {
        permissionIssue = {
            denied: [],
            blocked: false,
            note: 'Capture never started — a permission prompt may be waiting',
        };
    }
    stopRecording();
}

function pollTick() {
    if (!session) return;
    const now = Date.now();
    const s = session;
    const tapSize = fileSize(s.paths.tap);
    const micSize = fileSize(s.paths.mic);
    if (tapSize > s.growth.tap.size) s.growth.tap = { size: tapSize, ts: now };
    if (micSize > s.growth.mic.size) s.growth.mic = { size: micSize, ts: now };

    if (state === 'starting') {
        if (s.growth.tap.size > 0 && s.growth.mic.size > 0) {
            clearTimeout(s.timers.starting);
            s.reachedRecording = true;
            setState('recording');
        }
    } else if (state === 'recording' || state === 'stalled') {
        const tapStale = (now - s.growth.tap.ts) > TAP_STALE_MS;
        const micStale = (now - s.growth.mic.ts) > MIC_STALE_MS;
        const isStalled = tapStale || micStale;
        if (state === 'recording' && isStalled)      setState('stalled');
        else if (state === 'stalled' && !isStalled)  setState('recording');
    }
}

function teardown(cb) {
    if (!session) { if (cb) cb(); return; }
    teardownInFlight = true;
    const s = session;
    session = null;
    if (s.timers.poll) clearInterval(s.timers.poll);
    if (s.timers.starting) clearTimeout(s.timers.starting);
    const kids = [s.tap, s.mic, s.poller].filter(Boolean);
    for (const k of kids) {
        try { k.kill('SIGINT'); } catch {}
    }
    setTimeout(() => {
        for (const k of kids) {
            if (k.exitCode === null && k.signalCode === null) {
                try { k.kill('SIGKILL'); } catch {}
            }
        }
        // After the children are gone and before the callback, which is what
        // starts the pipeline — the pipeline keys off the manifest, so the
        // manifest has to be true by the time it reads it.
        finalizeMicFormat(s.paths);
        finalizeTapFormat(s.paths);
        teardownInFlight = false;
        if (cb) cb();
    }, KILL_GRACE_MS);
}

function stopRecording() {
    if (state === 'stopped') return;
    // Tray flips to Stopped up to KILL_GRACE_MS before children actually
    // exit. Accepted: Stop is user-initiated and nobody is watching the
    // gap. Record the gap here so it isn't rediscovered as a bug later.
    const capture = session && session.reachedRecording
        ? {
            stem: session.stem,
            recordingId: session.recordingId,
            inferredScope: session.inferredScope,
            // SAA-187: computed here, where startedAtMs already lives for the
            // stop notification, and carried through to the identity prompt
            // rather than having the page re-derive it — the page has no
            // access to session state and answering late must not change
            // what a capture's own duration was.
            durationMs: session.startedAtMs ? Date.now() - session.startedAtMs : null,
          }
        : null;
    const stem = capture ? capture.stem : null;
    setState('stopped');
    // The pipeline starts from teardown's completion callback, never from
    // this click. miccap patches the WAV header when it handles SIGINT, so a
    // transcribe kicked off before it exits reads a file whose RIFF and data
    // sizes are still zero — and teardown is also where the manifest gets its
    // mic format, which the pipeline reads.
    //
    // The identity prompt goes last, after the audio is finalised and the
    // pipeline is already running. Everything a capture needs has happened by
    // the time the question is asked, which is what makes the answer optional.
    teardown(() => {
        startPipeline(stem);
        promptForIdentity(capture);
    });
}

function quitApp() {
    // A capture that already happened should still become moments, so quitting
    // mid-recording hands off rather than discards. The child is detached, so
    // it outlives this process.
    //
    // No identity prompt on this path: the window would be destroyed with the
    // process before anyone could type into it, and holding the quit open
    // until it was answered would make the prompt something a person has to
    // get past. That capture is unidentified — the same outcome as dismissing
    // the prompt, and correctable the same way.
    isQuitting = true;
    stopDetector();
    const stem = session && session.reachedRecording ? session.stem : null;
    if (state !== 'stopped') setState('stopped');
    teardown(() => {
        startPipeline(stem);
        app.exit(0);
    });
}

// --- launch sweep (SAA-152) -------------------------------------------------
//
// Parent-death detection in systemtap/miccap/micwatch/audiodevs only protects
// a stray created after that fix ships. Anything orphaned earlier — or by a
// binary built before the fix — is still sitting on disk at the next launch,
// so this finds and ends those too. audiodevs was not one of the three named
// when this issue was written — the three were only the ones observed, and
// the scope is "ending the recorder ends its children," which audiodevs is
// one of (spawned as the --poll stall detector alongside tap/mic — see
// startRecording) and orphans exactly the same way, confirmed 2026-09-24.
//
// Two paths per binary, dev checkout and packaged bundle, because a stray can
// predate a layout switch as easily as a rebuild — RECORDER_DIR/BUNDLED_BIN
// are both already computed above regardless of which layout this instance
// is running under.
//
// PPID 1 is the whole safety property: a child of a currently running
// recorder has that recorder's own live pid as its parent, never 1, so this
// can never reach into a running instance's own children. It runs before
// anything below spawns its own children, so there is no race with those
// either.
const STRAY_BIN_PATHS = new Set([
    path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap'),
    path.join(BUNDLED_BIN, 'systemtap'),
    path.join(RECORDER_DIR, 'miccap', '.build', 'release', 'miccap'),
    path.join(BUNDLED_BIN, 'miccap'),
    path.join(RECORDER_DIR, 'micwatch'),
    path.join(BUNDLED_BIN, 'micwatch'),
    path.join(RECORDER_DIR, 'audiodevs'),
    path.join(BUNDLED_BIN, 'audiodevs'),
]);

function sweepStrayChildren() {
    let out;
    try {
        out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
    } catch (err) {
        console.error(`launch sweep: ps failed: ${String(err)}`);
        return;
    }
    for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        if (ppid !== 1) continue;
        const exe = m[3].split(' ')[0];
        if (!STRAY_BIN_PATHS.has(exe)) continue;
        console.error(`launch sweep: killing stray pid=${pid} ppid=${ppid} exe=${exe}`);
        try { process.kill(pid, 'SIGKILL'); } catch (err) {
            console.error(`launch sweep: kill ${pid} failed: ${String(err)}`);
        }
    }
}

// --- app boot -------------------------------------------------------------

// Credits the CC-BY-4.0 speaker-separation models require (SAA-194 §7) —
// see THIRD_PARTY_NOTICES for the full text this is drawn from. Set once,
// read whenever the tray's "About Clipwise" item opens the standard macOS
// About window.
app.setAboutPanelOptions({
    applicationName: 'Clipwise',
    credits:
        'Speaker separation uses models derived from pyannote\'s speaker-diarization-community-1 ' +
        'pipeline (CC BY 4.0), with embedding components from WeSpeaker and PLDA parameters from ' +
        'Brno University of Technology / BUT Speech@FIT (CC BY 4.0), converted to Core ML by Fluid ' +
        'Inference (github.com/FluidInference/FluidAudio, Apache 2.0). See THIRD_PARTY_NOTICES for ' +
        'full attribution and license text.',
});

app.whenReady().then(() => {
    // SAA-105 EXPERIMENT, 2026-09-01 — the paired half of LSUIElement in
    // build-app.sh. Normally this line is `if (app.dock) app.dock.hide();`
    // and Clipwise is an agent app. Revert to restore it.
    //
    // Removed rather than left in place because it sets the activation policy
    // at runtime: with it here the app returns to accessory whatever the plist
    // declares, and the experiment would report a clean negative without ever
    // having tested anything. The plist decides what the app launches as; this
    // decides what it is a moment later. They only mean something together.
    tray = new Tray(iconFor('stopped'));
    setState('stopped');
    registerIdentityIpc();
    // Before anything spawns its own children (SAA-152) — see
    // sweepStrayChildren's comment for why that ordering matters.
    sweepStrayChildren();
    // Last, and after the tray exists: a launch that has to recover a backlog
    // should still show a working menu bar immediately. Spawning is cheap —
    // the pass itself runs in another process — but ordering it here means a
    // throw from it can never cost the user their tray icon.
    startRecovery('app launch');
    // After the tray, for the same reason: call detection must never be able
    // to cost someone their menu bar icon. A missing or crashing micwatch
    // disables detection and changes nothing else.
    startDetector();
});

app.on('will-quit', () => { isQuitting = true; stopDetector(); });

app.on('window-all-closed', (e) => { e.preventDefault?.(); });
