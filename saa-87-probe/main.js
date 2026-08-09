const { app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const OUTDIR = getArg('outdir');
if (!OUTDIR) {
  process.stderr.write('missing --outdir\n');
  app.exit(2);
}

const STDERR_LOG = path.join(OUTDIR, 'stderr.log');
const STATUS_JSON = path.join(OUTDIR, 'status.json');
const PCM_OUT = path.join(OUTDIR, 'system.f32le.pcm');
const TAP_BIN = path.join(process.resourcesPath, 'systemtap');
const secArg = getArg('seconds');
let CAPTURE_SECONDS = 10;
if (secArg !== null) {
  const n = Number(secArg);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid --seconds value: ${JSON.stringify(secArg)}`);
  }
  CAPTURE_SECONDS = n;
}

function writeStatus(obj) {
  try {
    fs.writeFileSync(STATUS_JSON, JSON.stringify(obj, null, 2) + '\n');
  } catch (_) {}
}

app.whenReady().then(() => {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const stderrStream = fs.createWriteStream(STDERR_LOG, { flags: 'a' });
  const startedAt = Date.now();

  const tap = spawn(TAP_BIN, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, SYSTEMTAP_OUT: PCM_OUT },
  });

  tap.stderr.pipe(stderrStream);

  let sigintSent = false;
  const sigintTimer = setTimeout(() => {
    sigintSent = true;
    try { tap.kill('SIGINT'); } catch (_) {}
  }, CAPTURE_SECONDS * 1000);

  tap.on('exit', (code, signal) => {
    clearTimeout(sigintTimer);
    const stoppedAt = Date.now();
    writeStatus({
      tap_binary: TAP_BIN,
      capture_seconds_arg: secArg,
      capture_seconds_requested: CAPTURE_SECONDS,
      sigint_sent_by_main: sigintSent,
      exit_code: code,
      terminating_signal: signal,
      wall_started_ms: startedAt,
      wall_stopped_ms: stoppedAt,
      wall_duration_ms: stoppedAt - startedAt,
    });
    stderrStream.end(() => app.quit());
  });

  tap.on('error', (err) => {
    clearTimeout(sigintTimer);
    writeStatus({
      tap_binary: TAP_BIN,
      capture_seconds_arg: secArg,
      capture_seconds_requested: CAPTURE_SECONDS,
      spawn_error: String(err),
      spawn_errno: err.code || null,
      exit_code: null,
      terminating_signal: null,
    });
    stderrStream.end(() => app.exit(1));
  });
});
