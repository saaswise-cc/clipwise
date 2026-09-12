// App -> scope inference (SAA-170). Configuration data, not branching: kept
// as a plain user-editable file rather than an if/else in the capture path,
// because a future user has to be able to see and change the assumption
// (Jon, 2026-09-12), and because scope already has a third value foreseen
// (school) that a two-way branch would have to be unpicked to add.
//
// Split out of main.js for the same reason identity-answer.js is: no
// Electron in it, so it can be exercised directly rather than only ever
// verified by clicking through a packaged app.
//
// Keyed the same way detectApps is — bundle ID where there is one, else
// `exe:<name>` (detectKey, in main.js) — because that is the stable
// identity; the display name can be refreshed later (detectName, on a
// better path) and must not be what a saved mapping silently stops
// matching.
//
// Seeded once, on first read, with the mapping stated by the only user
// there is (FaceTime personal, Chrome work) — not asserted for anyone else,
// which is the whole reason this lives in an editable file next to the
// recordings rather than a constant compiled into the app.

const fs = require('fs');
const path = require('path');

// FaceTime's audio runs in a system daemon with no enclosing .app, so
// detectName (main.js) falls back to the executable name — the stored
// `name` in detected-apps.json is "avconferenced", not "FaceTime". `label`
// here is the human-recognisable name for this same key, shown instead.
const DEFAULT_APP_SCOPE = {
    'com.apple.avconferenced': { scope: 'personal', label: 'FaceTime' },
    'com.google.Chrome.helper': { scope: 'work', label: 'Google Chrome' },
};

function appScopePath(supportDir) {
    return path.join(supportDir, 'app-scope.json');
}

// Reads the store, seeding it with DEFAULT_APP_SCOPE on first run or an
// unreadable file. Written immediately on seeding so the seed is itself
// visible and editable right away, matching the "configuration a user can
// see and change" requirement — not just a fallback held in memory.
function loadAppScope(supportDir) {
    const storePath = appScopePath(supportDir);
    try {
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        if (raw && typeof raw === 'object' && raw.apps && typeof raw.apps === 'object') {
            return raw.apps;
        }
        console.error('app-scope: store has no apps object — reseeding defaults');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`app-scope: store unreadable (${String(err)}) — reseeding defaults`);
        }
    }
    try {
        fs.mkdirSync(supportDir, { recursive: true });
        fs.writeFileSync(
            storePath,
            JSON.stringify({ version: 1, apps: DEFAULT_APP_SCOPE }, null, 2) + '\n');
    } catch (writeErr) {
        console.error(`app-scope: could not write seed file: ${String(writeErr)}`);
    }
    return { ...DEFAULT_APP_SCOPE };
}

// null means no inference — an app `appScope` has no entry for, or no app
// at all (a manual start, key === null). Never guessed at and never
// defaulted; the caller decides what "no inference" means (identity.html:
// nothing pre-selected, main.js: scope written as null rather than 'work').
function scopeForKey(key, appScope) {
    if (!key) return null;
    const entry = appScope[key];
    return (entry && (entry.scope === 'work' || entry.scope === 'personal')) ? entry.scope : null;
}

module.exports = {
    DEFAULT_APP_SCOPE,
    appScopePath,
    loadAppScope,
    scopeForKey,
};
