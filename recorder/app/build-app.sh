#!/bin/bash
# Build Clipwise.app — a double-clickable menu bar app, signed with the
# Developer ID from SAA-88, that can be added to Login Items by hand.
#
# What this replaces. Nothing: there was no build script. The steps it
# automates were done by hand from the README, which had drifted (it builds
# audiodevs and systemtap and never mentions miccap, which replaced ffmpeg on
# the mic in SAA-106). This is the first script that produces a runnable
# artifact rather than measuring one — baseline.sh is a capture harness and
# fix-electron-signature.sh is an install hook.
#
# What it deliberately does not do. No notarization, no stapling, no DMG, no
# auto-update, and no login-item registration — the app never asks to launch
# itself, it is added in System Settings by hand. Those are Phase 4.
#
# No hardened runtime. `--options runtime` is not passed, and that is a choice
# rather than an oversight: it would extend to the tap, mic and whisper.cpp
# binaries this app spawns, and library validation is what makes that a
# notarization-shaped problem. The signature here is a real Developer ID
# signature without it.

set -euo pipefail

IDENTITY="${CLIPWISE_SIGN_IDENTITY:-Developer ID Application: Clipwise LLC (94U8UWWFSL)}"
BUNDLE_ID="com.clipwise.recorder"
APP_NAME="Clipwise"

APP_SRC="$(cd "$(dirname "$0")" && pwd)"
RECORDER_DIR="$(cd "$APP_SRC/.." && pwd)"
REPO_DIR="$(cd "$RECORDER_DIR/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
ELECTRON_APP="$APP_SRC/node_modules/electron/dist/Electron.app"

# Fixed output path, and that is load-bearing rather than tidiness. A TCC grant
# may key on the bundle path; Architecture Decision #9 leaves path and signing
# identity explicitly unruled-out as what a grant actually attaches to. A build
# that landed somewhere new each time would make "did the grant survive?"
# uninterpretable, and it is also the path Login Items records.
OUT_DIR="$APP_SRC/dist"
APP="$OUT_DIR/$APP_NAME.app"

step() { printf '\n=== %s\n' "$*"; }

# --- 1. helper binaries ---------------------------------------------------
# All three are gitignored build outputs, so a fresh clone has none of them.

step "building helper binaries"
(cd "$RECORDER_DIR" && swiftc -O audiodevs.swift -o audiodevs)
swift build -c release --package-path "$RECORDER_DIR/systemtap"
swift build -c release --package-path "$RECORDER_DIR/miccap"

SYSTEMTAP_BIN="$RECORDER_DIR/systemtap/.build/release/systemtap"
MICCAP_BIN="$RECORDER_DIR/miccap/.build/release/miccap"
AUDIODEVS_BIN="$RECORDER_DIR/audiodevs"

for b in "$SYSTEMTAP_BIN" "$MICCAP_BIN" "$AUDIODEVS_BIN"; do
    [ -x "$b" ] || { echo "build-app: missing $b after build" >&2; exit 1; }
done

# --- 2. the Electron runtime ----------------------------------------------
#
# Not fetched by `npm install`: Electron 43's package manifest has no `scripts`
# key, so the install exits clean while leaving no runtime on disk. `npx
# install-electron` is what downloads it. Checked rather than assumed, because
# the failure is silent in exactly that way.

if [ ! -d "$ELECTRON_APP" ]; then
    echo "build-app: no Electron runtime at $ELECTRON_APP" >&2
    echo "           run: (cd $APP_SRC && npm install && npx install-electron)" >&2
    exit 1
fi

step "assembling $APP"
rm -rf "$APP"
mkdir -p "$OUT_DIR"
# ditto rather than cp -R: the Electron framework is built out of symlinks and
# a copy that flattens them is not a loadable framework.
ditto "$ELECTRON_APP" "$APP"

C="$APP/Contents"

# The executable's name is what `ps` and Activity Monitor show, and it is also
# what Electron's own app.isPackaged reads. Nothing in main.js depends on that
# getter — see BUILD_INFO there — but leaving three "Electron" processes in the
# process list of a machine that also runs Electron apps is its own confusion.
mv "$C/MacOS/Electron" "$C/MacOS/$APP_NAME"

# Electron loads Resources/app before Resources/default_app.asar. Removing the
# default app removes any question of which one ran, and takes the asar
# integrity hash in Info.plist with it — a stale hash against a missing file is
# a launch failure waiting for a fuse to be flipped.
rm -f "$C/Resources/default_app.asar"
# Shipping electron.icns would put the Electron icon in Login Items next to the
# name Clipwise. A generic icon is not worse than a wrong one.
rm -f "$C/Resources/electron.icns"

mkdir -p "$C/Resources/app" "$C/Resources/bin"
cp "$APP_SRC/main.js" "$C/Resources/app/main.js"
# The identity prompt's page (SAA-114). main.js loads it by path relative to
# itself, so a bundle without it has a stop that silently identifies nothing.
cp "$APP_SRC/identity.html" "$C/Resources/app/identity.html"
cp "$APP_SRC/identity-answer.js" "$C/Resources/app/identity-answer.js"
install -m 755 "$SYSTEMTAP_BIN" "$C/Resources/bin/systemtap"
install -m 755 "$MICCAP_BIN"    "$C/Resources/bin/miccap"
install -m 755 "$AUDIODEVS_BIN" "$C/Resources/bin/audiodevs"

VERSION="$(/usr/bin/sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_SRC/package.json" | head -1)"
ELECTRON_VERSION="$(cat "$APP_SRC/node_modules/electron/dist/version")"

# A trimmed manifest rather than a copy. The source package.json carries the
# postinstall hook and the electron devDependency, neither of which means
# anything inside a bundle that has already been built.
cat > "$C/Resources/app/package.json" <<JSON
{
  "name": "clipwise-recorder",
  "version": "$VERSION",
  "private": true,
  "description": "Clipwise recorder menu bar app (packaged).",
  "main": "main.js"
}
JSON

COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
DIRTY=false
git -C "$REPO_DIR" diff --quiet HEAD -- || DIRTY=true
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# This file is three things at once: the flag that tells main.js it is running
# from a bundle, the only way the bundle can find the server checkout, and —
# because built_at changes every run — the thing that guarantees two builds of
# identical source still hash differently. That last one is what makes "does
# the grant survive a rebuild?" a real question rather than a tautology about
# an unchanged binary.
cat > "$C/Resources/app/build-info.json" <<JSON
{
  "built_at": "$BUILT_AT",
  "commit": "$COMMIT",
  "dirty": $DIRTY,
  "server_dir": "$SERVER_DIR",
  "recorder_dir": "$RECORDER_DIR",
  "electron_version": "$ELECTRON_VERSION"
}
JSON

# --- 3. Info.plist --------------------------------------------------------
#
# Edited in place rather than written from scratch: Electron needs keys here
# that have nothing to do with Clipwise (NSPrincipalClass, NSMainNibFile, the
# MallocNanoZone environment) and a hand-written plist would drop them.

step "Info.plist"
PLIST="$C/Info.plist"
PB=/usr/libexec/PlistBuddy
set_key() { $PB -c "Delete :$1" "$PLIST" >/dev/null 2>&1 || true; $PB -c "Add :$1 $2 $3" "$PLIST"; }

set_key CFBundleName            string "$APP_NAME"
set_key CFBundleDisplayName     string "$APP_NAME"
set_key CFBundleExecutable      string "$APP_NAME"
set_key CFBundleIdentifier      string "$BUNDLE_ID"
set_key CFBundleShortVersionString string "$VERSION"
set_key CFBundleVersion         string "$VERSION"
# Menu bar only. main.js already calls app.dock.hide(), but that runs after the
# app is up: without this key a login launch flashes a Dock icon and steals
# focus from whatever the user is doing.
set_key LSUIElement             bool   true
# Core Audio Taps floor, not Electron's 12.0.
set_key LSMinimumSystemVersion  string "14.2"
# The text macOS puts in the permission prompt. The capture runs in spawned
# children with no bundle of their own, so TCC reads these off the responsible
# app — this bundle.
set_key NSMicrophoneUsageDescription string "Clipwise records your microphone as one track of the meetings you capture."
set_key NSAudioCaptureUsageDescription string "Clipwise records system audio as the other track of the meetings you capture."
$PB -c "Delete :ElectronAsarIntegrity" "$PLIST" >/dev/null 2>&1 || true
$PB -c "Delete :CFBundleIconFile" "$PLIST" >/dev/null 2>&1 || true
$PB -c "Delete :LSApplicationCategoryType" "$PLIST" >/dev/null 2>&1 || true

# --- 4. sign --------------------------------------------------------------
#
# --deep signs inside-out: the framework, its helper apps and the three helper
# binaries in Resources/bin all get the same identity before the outer bundle
# is sealed. No --options runtime, no entitlements — see the header.

step "signing as: $IDENTITY"
codesign --force --deep --sign "$IDENTITY" "$APP"

step "codesign --verify --deep --strict --verbose=2 $APP"
codesign --verify --deep --strict --verbose=2 "$APP"

step "codesign -dvvv $APP"
codesign -dvvv "$APP" 2>&1 | grep -E "^(Identifier|Format|CodeDirectory|CDHash|Signature|Authority|TeamIdentifier|Info\.plist|Sealed Resources|Timestamp)"

printf '\nbuilt %s\n  commit %s%s\n  built_at %s\n' \
    "$APP" "$COMMIT" "$([ "$DIRTY" = true ] && echo ' (dirty)')" "$BUILT_AT"
