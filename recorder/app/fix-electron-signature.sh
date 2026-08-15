#!/bin/bash
# Re-sign the Electron.app that npm just unpacked, so macOS will deliver the
# recorder's notifications.
#
# Why this is needed. SAA-105 makes a notification the only readout of capture
# state when the menu bar icon has been evicted, so a notification that does not
# appear is the whole feature failing. Measured on macOS 15 / Electron 43.3.0,
# 2026-08-15: every Notification.show() from the stock package failed with
#
#     UNErrorDomain error 1   (notifications not allowed)
#
# and nothing was displayed. The cause is the signature the package ships:
#
#     $ codesign -dv node_modules/electron/dist/Electron.app
#     Identifier=Electron
#     flags=0x20002(adhoc,linker-signed)
#     Info.plist=not bound
#     Sealed Resources=none
#
# A linker-signed binary with an unbound Info.plist is not a bundle macOS will
# grant notification authorization to. Re-signing ad-hoc over the whole bundle
# binds the Info.plist and seals the resources:
#
#     Identifier=com.github.Electron
#     Info.plist entries=31
#     Sealed Resources version=2 rules=13 files=10
#
# after which the same probe reports the Notification 'show' event instead of
# 'failed'. No developer certificate is involved — the signature stays ad-hoc,
# it is only a complete one.
#
# Runs from postinstall because npm install replaces the whole dist directory
# and would silently undo it. Idempotent: it checks first and re-signs only an
# unbound bundle, so repeat runs cost a codesign -dv and nothing else.
#
# Failure here is not fatal. The recorder detects undelivered notifications at
# runtime and falls back to osascript — see notify() in main.js. This script is
# what makes the good path available, not what makes the feature safe.

set -uo pipefail

APP="$(cd "$(dirname "$0")" && pwd)/node_modules/electron/dist/Electron.app"

if [ ! -d "$APP" ]; then
    echo "fix-electron-signature: no Electron.app at $APP — nothing to do"
    exit 0
fi

# Read the description once into a variable rather than piping it. Under
# `pipefail` a `codesign -dv | grep -q` pipeline reports failure even on a
# match: grep -q exits at the first hit, codesign takes SIGPIPE on its next
# write, and the pipeline inherits that status — so the check said "not bound"
# every time and the script re-signed an already-bound bundle on every run.
DESC="$(codesign -dv "$APP" 2>&1)"

if printf '%s\n' "$DESC" | grep -q "^Info.plist entries="; then
    echo "fix-electron-signature: Info.plist already bound — leaving signature alone"
    exit 0
fi

echo "fix-electron-signature: re-signing $APP so notifications can be delivered"
if ! codesign --force --deep --sign - "$APP" 2>&1; then
    echo "fix-electron-signature: codesign failed — notifications will fall back to osascript" >&2
    exit 0
fi

# Report the readback rather than the exit status, for the same reason the
# manifest re-reads the WAV's fmt chunk: what the bundle now says about itself
# is the fact, and the command succeeding is only a claim about it.
printf '%s\n' "$(codesign -dv "$APP" 2>&1)" \
    | grep -E "^(Identifier|Info\.plist|Sealed Resources)" || true
