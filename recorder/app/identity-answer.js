// The identity answer: what the prompt collects, and how it reaches disk.
//
// Split out of main.js because it is the half of SAA-114 with no Electron in
// it — parsing what someone typed, and writing the file that carries it to
// ingest. Kept here it can be exercised directly, without a window and without
// a person to type into one; inside main.js it could only ever be verified by
// re-implementing it somewhere else, which verifies the re-implementation.
//
// The reader is server/src/ingest/identity.ts. IDENTITY_VERSION is shared
// between them by hand, so bump both or neither.

const fs = require('fs');
const path = require('path');

// Bumped 1 -> 2 for `scope` (SAA-153) and the selection-vs-typing split
// (SAA-169) — the shape this writes changed. Nothing reads this number to
// gate behavior; it is a shared marker so identity.ts's copy gets bumped in
// the same change rather than drifting.
const IDENTITY_VERSION = 2;

// The prompt window's content box. Height is not a constant: the page measures
// itself and asks to be resized, because a fixed height is a bet that the copy
// will never change and 7dae4a9 lost that bet — a hint added to the names
// field pushed Save and Skip below the bottom edge of a 460×320 window with no
// way to scroll to them.
//
// The clamp is what keeps a measurement bug from producing a 3-pixel or a
// full-screen prompt. Between the two bounds the window fits its content; past
// the upper one the page scrolls internally and the buttons stay pinned, so
// they are reachable at every height either way.
const IDENTITY_WINDOW = { width: 460, minHeight: 220, maxHeight: 560 };

function contentHeightFor(measured) {
    const h = Math.ceil(Number(measured));
    if (!Number.isFinite(h)) return IDENTITY_WINDOW.minHeight;
    return Math.min(IDENTITY_WINDOW.maxHeight, Math.max(IDENTITY_WINDOW.minHeight, h));
}

// Newlines and commas both separate, because both are what people type.
// Duplicates are dropped case-insensitively; the first spelling wins.
function parseNames(raw) {
    const seen = new Set();
    const names = [];
    for (const part of String(raw || '').split(/[\n,]/)) {
        const name = part.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

// SAA-169: every previously-written identity-<stem>.json in `dir` is a
// record of a name someone typed at this exact prompt before. Scanning them
// is the "known names" roster the picker offers, so the same person is
// selected rather than retyped — no server round trip, no new local cache
// to keep in sync, just the answers already sitting on disk. Self is not
// included: it is one person, already remembered separately via
// identity-self.json (readSelfName in main.js).
//
// Same dedup rule as parseNames: case-insensitive, first spelling kept.
// Sorted for a stable, scannable list rather than insertion/file order,
// which is filesystem-dependent and not meaningful here.
function knownGuestNames(dir) {
    const seen = new Set();
    const names = [];
    let files;
    try {
        files = fs.readdirSync(dir).filter((f) => /^identity-.*\.json$/.test(f));
    } catch {
        return names;
    }
    for (const file of files) {
        let doc;
        try {
            doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
            continue;
        }
        for (const guest of (doc && doc.guests) || []) {
            const name = typeof guest?.name === 'string' ? guest.name.trim() : '';
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            names.push(name);
        }
    }
    names.sort((a, b) => a.localeCompare(b));
    return names;
}

// The submitted guest list is two sources merged: names picked from the
// known-names list (selection, SAA-169's fix) and names typed into the
// "someone new" field (parseNames, unchanged — this is still exactly how a
// first meeting with anyone works). Selected names win the case-insensitive
// dedup on overlap, since they are already the canonical on-disk spelling
// rather than freshly typed text.
function mergeGuestNames(selected, typedRaw) {
    const seen = new Set();
    const names = [];
    for (const raw of selected || []) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    for (const name of parseNames(typedRaw)) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

// `self` is the person answering: the prompt asks who the call was *with*, so
// their own row is implied by the question rather than typed into it. A null
// name is a real answer — attendance without a claim about who — and is what
// this carries until they say what they are called. It is never derived from
// the OS account: `id -F` on the machine this was written on answers "JD".
// `scope` (SAA-153) is the same "one more choice on a prompt already being
// answered" the issue settled on — personal vs. work, asked once per call
// rather than inferred. Anything other than the literal 'work' or
// 'personal' is written as null: an unrecognised value is not a scope
// server-side (recordings_scope_valid only permits those two), and null is
// the honest "not answered" rather than a guess at which one was meant.
function buildAnswerDoc({ stem, recordingId, names, selfName, scope, answeredAt }) {
    return {
        identity_version: IDENTITY_VERSION,
        recording_id: recordingId,
        stem,
        answered_at: answeredAt || new Date().toISOString(),
        self: {
            name: selfName || null,
            source: selfName ? 'recorder_identity_prompt' : null,
        },
        guests: (names || []).map(name => ({ name })),
        scope: scope === 'work' || scope === 'personal' ? scope : null,
    };
}

// Where the answer lives until there is a row to attach it to.
//
// A capture stops minutes before its recording row exists: the pipeline
// transcribes first and ingest inserts the row after that. So the answer goes
// to identity-<stem>.json in the capture directory, beside the manifest and
// the audio it describes. Nothing is held in the recorder's memory and nothing
// is handed to the running pipeline, which is why a crash, a quit or a reboot
// between the answer and the ingest costs nothing — the file is still there,
// and ingest reads it whenever it gets there.
//
// Written to a temporary file in the same directory and renamed, so an
// interrupted write leaves either the old state or the new one, never half a
// JSON document for ingest to guess about.
function writeAnswer(dir, doc) {
    const finalPath = path.join(dir, `identity-${doc.stem}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

// --- step 2: naming the voices (SAA-195) -----------------------------------

const VOICE_NAMES_VERSION = 1;

// `voices` is [{ voiceIndex, name }], name null/absent for "Not sure" —
// SAA-165's correct-or-absent rule again, same as guests above: never a
// fallback name of any kind. `rename` is set only by the "Rename voices…"
// reopen (the most recent named call only) — server/src/ingest/voice-
// names.ts's applyVoiceNames reads it to decide whether an already-named
// voice may be overwritten or cleared; ordinary first-time naming never
// sets it.
function buildVoiceNamesDoc({ stem, recordingId, voices, answeredAt, rename }) {
    return {
        voice_names_version: VOICE_NAMES_VERSION,
        recording_id: recordingId,
        stem,
        answered_at: answeredAt || new Date().toISOString(),
        voices: (voices || []).map(v => ({
            voiceIndex: v.voiceIndex,
            name: v.name || null,
        })),
        ...(rename ? { rename: true } : {}),
    };
}

// Same write-to-temp-then-rename durability as writeAnswer above, and a
// different filename (voice-names-<stem>.json, not identity-<stem>.json) so
// the two answers — who was on the call, and who's speaking — never collide
// and either can arrive without the other existing yet.
function writeVoiceNamesAnswer(dir, doc) {
    const finalPath = path.join(dir, `voice-names-${doc.stem}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
    return finalPath;
}

// The naming-data file the server writes (voice-clips.ts) once diarize
// splits a recording — clip paths and longest lines per voice. Read here,
// not derived: main.js has no database access, the same reason
// identity-<stem>.json exists as a file rather than a query.
function readNamingData(dir, stem) {
    const p = path.join(dir, `voices-${stem}.json`);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// The answer already on file for a capture, if any — read here so the
// "Rename voices…" reopen can pre-select each voice's current name rather
// than starting from "Not sure" again.
function readVoiceNamesAnswer(dir, stem) {
    const p = path.join(dir, `voice-names-${stem}.json`);
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

// A capture has voices waiting to be named when the server produced naming
// data for it and nobody has answered yet. Both facts are files on disk —
// main.js has no other way to know either one.
function pendingVoiceNamingStems(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const stems = [];
    for (const file of files) {
        const m = /^voices-(.+)\.json$/.exec(file);
        if (!m) continue;
        const stem = m[1];
        if (files.includes(`voice-names-${stem}.json`)) continue; // already answered
        stems.push(stem);
    }
    stems.sort();
    return stems;
}

// The newest capture that already has a saved voice-names answer — the one
// and only "Rename voices…" candidate (SAA-195: only one call gets this
// item, never a list of past calls).
function mostRecentNamedStem(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const stems = [];
    for (const file of files) {
        const m = /^voice-names-(.+)\.json$/.exec(file);
        if (m) stems.push(m[1]);
    }
    if (stems.length === 0) return null;
    stems.sort();
    return stems[stems.length - 1];
}

// The newest capture on disk, named or not — every capture writes a
// manifest, so this is "the most recent recording" independent of voice
// naming state. Used to decide whether the "Rename voices…" item's
// recording is still the latest one (SAA-195): stems sort lexicographically
// in chronological order, same convention as mostRecentNamedStem above.
function mostRecentCaptureStem(dir) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const stems = [];
    for (const file of files) {
        const m = /^manifest-(.+)\.json$/.exec(file);
        if (m) stems.push(m[1]);
    }
    if (stems.length === 0) return null;
    stems.sort();
    return stems[stems.length - 1];
}

module.exports = {
    IDENTITY_VERSION,
    IDENTITY_WINDOW,
    contentHeightFor,
    parseNames,
    knownGuestNames,
    mergeGuestNames,
    buildAnswerDoc,
    writeAnswer,
    VOICE_NAMES_VERSION,
    buildVoiceNamesDoc,
    writeVoiceNamesAnswer,
    readNamingData,
    pendingVoiceNamingStems,
    readVoiceNamesAnswer,
    mostRecentNamedStem,
    mostRecentCaptureStem,
};
