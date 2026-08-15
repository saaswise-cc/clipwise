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

const { app, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// The tap is created with isMono=true, so its stream is one channel whatever
// the output device carries. Recorded here because the tap track is headerless
// PCM: a consumer cannot recover channel count from the file.
const TAP_CHANNELS = 1;

// --- paths ----------------------------------------------------------------

const RECORDER_DIR = path.resolve(__dirname, '..');
const SYSTEMTAP_BIN = path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap');
const MICCAP_BIN = path.join(RECORDER_DIR, 'miccap', '.build', 'release', 'miccap');
const AUDIODEVS_BIN = path.join(RECORDER_DIR, 'audiodevs');
const OUTDIR = path.join(os.homedir(), 'Library', 'Application Support', 'clipwise', 'recordings');

// The capture→moments pipeline. Run through the server's own tsx so the seam
// always executes current source — a built dist would silently run whatever
// it was last compiled from. cwd is the server directory so dotenv/config
// finds server/.env; the recorder never handles a secret itself.
const SERVER_DIR = path.resolve(RECORDER_DIR, '..', 'server');
const TSX_BIN = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
const PIPELINE_ENTRY = path.join(SERVER_DIR, 'src', 'pipeline', 'cli.ts');

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
// 'stopped' | 'starting' | 'recording' | 'stalled'
let state = 'stopped';
let session = null;
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

const LABEL = {
    stopped:   'Stopped',
    starting:  'Starting',
    recording: 'Recording',
    stalled:   'Recording (stalled)',
};

// Menu-item text, not title text — see renderTray. These were tray-title
// suffixes and were the same overflow hazard as the permission suffix that
// actually triggered it.
const PIPELINE_NOTE = {
    running: 'Processing capture…',
    failed:  'Processing failed — see pipeline-<stem>.json',
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
function buildManifest(stamp, startedAt, dev, paths) {
    return {
        manifest_version: MANIFEST_VERSION,
        recording_id: randomUUID().toUpperCase(),
        started_at: startedAt,
        // The filename stem stays the human-readable handle. It is recorded,
        // not derived from — recording_id is the identifier.
        stem: stamp,
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

const DOT = {
    stopped:   '#8E8E93',
    starting:  '#FF9F0A',
    recording: '#FF453A',
    stalled:   '#FFD60A',
};

const ICON = {};
function iconFor(s) {
    if (!ICON[s]) ICON[s] = dotIcon(DOT[s]);
    return ICON[s];
}

// --- tray -----------------------------------------------------------------

function renderTray() {
    const label = LABEL[state];
    const pipelineNote = pipeline ? PIPELINE_NOTE[pipeline.state] : null;
    const permNote = permissionIssue ? permissionIssue.note : null;

    // Title stays down to a few characters whatever the state vocabulary
    // grows into: a word for capture, and single glyphs for anything wanting
    // attention. Everything wordy is a menu item, which has room for it.
    const attention = permissionIssue || (pipeline && pipeline.state === 'failed');
    const title = [
        state === 'stopped' ? '' : 'Rec',
        pipeline && pipeline.state === 'running' ? '⚙' : '',
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
    items.push(
        { type: 'separator' },
        { label: 'Start', enabled: !active, click: startRecording },
        { label: 'Stop',  enabled:  active, click: stopRecording },
    );
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
    items.push({ type: 'separator' }, { label: 'Quit', click: quitApp });
    tray.setContextMenu(Menu.buildFromTemplate(items));
}

function setState(next) {
    state = next;
    renderTray();
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
        }
        renderTray();
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

// --- lifecycle ------------------------------------------------------------

function startRecording() {
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
        return;
    }
    permissionIssue = null;

    try {
        manifest = buildManifest(stamp, startedAt, dev, paths);
        // Written before the children spawn, so no audio file can exist
        // without one. OUTDIR was just created, so a failure here means the
        // directory is unwritable and the capture would have been lost
        // anyway — refusing is honest, and leaves nothing half-formed.
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
    } catch (err) {
        console.error(String(err));
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
        teardownInFlight = false;
        if (cb) cb();
    }, KILL_GRACE_MS);
}

function stopRecording() {
    if (state === 'stopped') return;
    // Tray flips to Stopped up to KILL_GRACE_MS before children actually
    // exit. Accepted: Stop is user-initiated and nobody is watching the
    // gap. Record the gap here so it isn't rediscovered as a bug later.
    const stem = session && session.reachedRecording ? session.stem : null;
    setState('stopped');
    // The pipeline starts from teardown's completion callback, never from
    // this click. miccap patches the WAV header when it handles SIGINT, so a
    // transcribe kicked off before it exits reads a file whose RIFF and data
    // sizes are still zero — and teardown is also where the manifest gets its
    // mic format, which the pipeline reads.
    teardown(() => startPipeline(stem));
}

function quitApp() {
    // A capture that already happened should still become moments, so quitting
    // mid-recording hands off rather than discards. The child is detached, so
    // it outlives this process.
    const stem = session && session.reachedRecording ? session.stem : null;
    if (state !== 'stopped') setState('stopped');
    teardown(() => {
        startPipeline(stem);
        app.exit(0);
    });
}

// --- app boot -------------------------------------------------------------

app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    tray = new Tray(iconFor('stopped'));
    setState('stopped');
});

app.on('window-all-closed', (e) => { e.preventDefault?.(); });
