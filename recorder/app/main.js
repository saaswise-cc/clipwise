// Clipwise recorder — Electron menu bar shell.
// Main process only. Spawns tap + mic + poller directly (no bash wrapper),
// tracks a four-label state machine, and tears everything down on Stop or
// Quit. Filenames, timestamp format and output directory match the
// existing recorder/run.sh (which will be removed in a follow-up commit).

const { app, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- constants ------------------------------------------------------------
// All measurements come from 5-second captures on 2026-08-09. A long
// recording may tear down or flush differently — these are provisional.

// SIGINT to all children, wait, then SIGKILL survivors. Observed exit:
// tap 5–15 ms, ffmpeg 10–30 ms. 750 ms is ~25× the observed max.
const KILL_GRACE_MS = 750;

// Starting → Recording deadline. First-byte observed: tap ~100 ms,
// mic ~1700 ms (mic is the binding constraint). Generous deliberately —
// failing early refuses a recording that would have worked.
const STARTING_TIMEOUT_MS = 9000;

// File-size poll interval and per-child staleness windows.
// Observed growth cadence: tap ~50 ms, ffmpeg flushes every ~1550 ms —
// per-tick growth cannot be the test. A child counts as growing if it
// grew within its own window. Staleness switches the tray label to
// "Recording (stalled)" but does not kill children — losing the rest of
// a call to a possibly-wrong constant is worse than a misleading label.
const POLL_INTERVAL_MS = 250;
const TAP_STALE_MS = 1000;
const MIC_STALE_MS = 3200;

// --- paths ----------------------------------------------------------------

const RECORDER_DIR = path.resolve(__dirname, '..');
const SYSTEMTAP_BIN = path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap');
const AUDIODEVS_BIN = path.join(RECORDER_DIR, 'audiodevs');
const OUTDIR = path.join(os.homedir(), 'Library', 'Application Support', 'clipwise', 'recordings');

// --- state ----------------------------------------------------------------

let tray = null;
// 'stopped' | 'starting' | 'recording' | 'stalled'
let state = 'stopped';
let session = null;
let teardownInFlight = false;

const LABEL = {
    stopped:   'Stopped',
    starting:  'Starting',
    recording: 'Recording',
    stalled:   'Recording (stalled)',
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

function readMicName() {
    const out = execFileSync(AUDIODEVS_BIN, ['--once'], { encoding: 'utf8' });
    const m = out.match(/in_name="([^"]+)"/);
    if (!m) throw new Error(`audiodevs --once: could not parse in_name from: ${out}`);
    return m[1];
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

// --- tray -----------------------------------------------------------------

function renderTray() {
    const label = LABEL[state];
    tray.setTitle(label);
    const active = state !== 'stopped';
    const menu = Menu.buildFromTemplate([
        { label: `Status: ${label}`, enabled: false },
        { type: 'separator' },
        { label: 'Start', enabled: !active, click: startRecording },
        { label: 'Stop',  enabled:  active, click: stopRecording },
        { type: 'separator' },
        { label: 'Quit', click: quitApp },
    ]);
    tray.setContextMenu(menu);
}

function setState(next) {
    state = next;
    renderTray();
}

// --- lifecycle ------------------------------------------------------------

function startRecording() {
    if (state !== 'stopped' || session) return;
    fs.mkdirSync(OUTDIR, { recursive: true });
    const stamp = utcStamp();
    const paths = {
        tap:     path.join(OUTDIR, `system-${stamp}.f32le.pcm`),
        tapLog:  path.join(OUTDIR, `systemtap-${stamp}.log`),
        mic:     path.join(OUTDIR, `mic-${stamp}.wav`),
        micLog:  path.join(OUTDIR, `mic-${stamp}.log`),
        pollLog: path.join(OUTDIR, `poller-${stamp}.log`),
    };
    let micName;
    try {
        micName = readMicName();
    } catch (err) {
        console.error(String(err));
        return;
    }
    const tapProc = spawnChild(
        SYSTEMTAP_BIN, [],
        { ...process.env, SYSTEMTAP_OUT: paths.tap },
        paths.tapLog,
    );
    const micProc = spawnChild(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-y',
         '-f', 'avfoundation', '-i', `:${micName}`,
         '-c:a', 'pcm_f32le', paths.mic],
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
                     `child=${which} exited unexpectedly ` +
                     `code=${proc.exitCode} signal=${proc.signalCode}\n`;
        try { fs.appendFileSync(logPath, line); } catch {}
    }
    stopRecording();
}

function onStartingTimeout() {
    if (state !== 'starting') return;
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
        teardownInFlight = false;
        if (cb) cb();
    }, KILL_GRACE_MS);
}

function stopRecording() {
    if (state === 'stopped') return;
    // Tray flips to Stopped up to KILL_GRACE_MS before children actually
    // exit. Accepted: Stop is user-initiated and nobody is watching the
    // gap. Record the gap here so it isn't rediscovered as a bug later.
    setState('stopped');
    teardown();
}

function quitApp() {
    if (state !== 'stopped') setState('stopped');
    teardown(() => app.exit(0));
}

// --- app boot -------------------------------------------------------------

app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    tray = new Tray(nativeImage.createEmpty());
    setState('stopped');
});

app.on('window-all-closed', (e) => { e.preventDefault?.(); });
