#!/bin/bash
# Populates recorder/diarize/models/speaker-diarization/ with the pinned
# FluidAudio community-1 model files (SAA-194 §3). Not committed to git —
# 21 MiB of binary model weights don't belong in the repo, and the pinned
# revision (baked into FluidAudio itself, not chosen by us — see
# ModelNames.swift's Repo.revision) is a better provenance record than a
# git blob would be.
#
# Run by build-app.sh before it copies the models into Clipwise.app, and by
# hand once per dev machine before running `swift run diarize` locally.
#
# Verifies every file against CHECKSUMS.sha256, checked into git, generated
# from a known-good fetch (SAA-194, 2026-09-24). A mismatch fails loudly and
# removes the bad directory rather than letting a corrupt or tampered fetch
# get bundled into a build.

set -euo pipefail

DIARIZE_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$DIARIZE_DIR/models"
LEAF_DIR="$MODELS_DIR/speaker-diarization"
CHECKSUMS="$MODELS_DIR/CHECKSUMS.sha256"

verify() {
    (cd "$MODELS_DIR" && shasum -a 256 -c "$CHECKSUMS" --status)
}

if [ -d "$LEAF_DIR" ] && verify; then
    echo "fetch-models: $LEAF_DIR already present and verified"
    exit 0
fi

echo "fetch-models: fetching pinned FluidAudio community-1 models into $MODELS_DIR"
rm -rf "$LEAF_DIR"

# This is the one command in the whole SAA-194 pipeline allowed to touch the
# network — diarize's own runtime path always sets ModelHub.offlineMode.
swift run --package-path "$DIARIZE_DIR" -c release diarize --fetch-models "$MODELS_DIR"

if ! [ -d "$LEAF_DIR" ]; then
    echo "fetch-models: fetch reported success but $LEAF_DIR is missing" >&2
    exit 1
fi

if ! verify; then
    echo "fetch-models: checksum mismatch after fetch — removing $LEAF_DIR" >&2
    echo "              either CHECKSUMS.sha256 is stale (the pinned revision moved)" >&2
    echo "              or the download is corrupt/tampered. Do not bundle this." >&2
    rm -rf "$LEAF_DIR"
    exit 1
fi

echo "fetch-models: verified $(find "$LEAF_DIR" -type f | wc -l | tr -d ' ') files against CHECKSUMS.sha256"
