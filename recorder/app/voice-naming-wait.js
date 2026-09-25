// Step 2's stop conditions (SAA-195, 2026-09-25 fix), pulled out of main.js
// so this decision can be exercised directly against fixture data — no
// Electron, no window, no timer — rather than only through the live poll.
//
// Reads exactly two facts off the pipeline record (run-capture.ts's
// pipeline-<stem>.json): steps.diarize.state and, only when that is
// "skipped", steps.diarize.detail.model_revision, plus steps.transcribe.state
// and steps.ingest.state. No text parsing of any `reason` string anywhere
// here.
//
// steps.diarize.state is "skipped" for every non-split outcome alike, benign
// or not (run-capture.ts's finish() call uses that one state either way).
// model_revision is what tells them apart: it is only ever non-null when the
// diarize tool actually ran and produced a real sidecar — the two-party gate
// and the identity-already-named skip both pass it through from that real
// result. Every other skip (Apple Silicon, a missing binary or audio file, a
// timeout, a tool error) leaves it null, because skip()'s own default
// (server/src/pipeline/diarize.ts) is never overridden in those paths.
function stopMessageFor(sidecar) {
    const diarizeStep = sidecar && sidecar.steps && sidecar.steps.diarize;
    const transcribeState = sidecar && sidecar.steps && sidecar.steps.transcribe && sidecar.steps.transcribe.state;
    const ingestState = sidecar && sidecar.steps && sidecar.steps.ingest && sidecar.steps.ingest.state;

    if (diarizeStep && diarizeStep.state === 'skipped') {
        const modelRevision = diarizeStep.detail && diarizeStep.detail.model_revision;
        return modelRevision != null
            ? 'Only one other voice on this call — nothing to name.'
            : "Couldn't separate the voices on this call.";
    }
    if ((!diarizeStep || diarizeStep.state === 'pending')
        && (transcribeState === 'failed' || ingestState === 'failed')) {
        // The pipeline died before ever reaching diarize.
        return "Couldn't separate the voices on this call.";
    }
    return null;
}

module.exports = { stopMessageFor };
