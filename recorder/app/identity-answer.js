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

const IDENTITY_VERSION = 1;

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

// `self` is the person answering: the prompt asks who the call was *with*, so
// their own row is implied by the question rather than typed into it. A null
// name is a real answer — attendance without a claim about who — and is what
// this carries until they say what they are called. It is never derived from
// the OS account: `id -F` on the machine this was written on answers "JD".
function buildAnswerDoc({ stem, recordingId, names, selfName, answeredAt }) {
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

module.exports = { IDENTITY_VERSION, parseNames, buildAnswerDoc, writeAnswer };
