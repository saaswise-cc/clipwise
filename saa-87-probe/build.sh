#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAP_PROJ="$REPO_ROOT/recorder/systemtap"

BUNDLE_ID="io.quorom.clipwise.saa87-tccprobe-20260809"
PRODUCT_NAME="Clipwise-TCC-Probe"

if [ ! -d "$SCRIPT_DIR/node_modules/@electron/packager" ]; then
  echo "!! @electron/packager not installed."
  echo "   Run: cd $SCRIPT_DIR && npm install --save-exact @electron/packager"
  exit 1
fi

echo "==> Building systemtap (release)"
( cd "$TAP_PROJ" && swift build -c release )
TAP_BIN="$TAP_PROJ/.build/release/systemtap"
test -x "$TAP_BIN" || { echo "!! tap binary not built at $TAP_BIN"; exit 1; }

echo "==> Packaging Electron app"
rm -rf "$SCRIPT_DIR/out" "$SCRIPT_DIR/$PRODUCT_NAME-darwin-arm64"
cd "$SCRIPT_DIR"
npx @electron/packager . "$PRODUCT_NAME" \
  --platform=darwin \
  --arch=arm64 \
  --out=out \
  --app-bundle-id="$BUNDLE_ID" \
  --extend-info=info-plist-extras.plist \
  --extra-resource="$TAP_BIN" \
  --overwrite

APP_PATH="$SCRIPT_DIR/out/$PRODUCT_NAME-darwin-arm64/$PRODUCT_NAME.app"
test -d "$APP_PATH" || { echo "!! packaged app missing at $APP_PATH"; exit 1; }

INFO_PLIST="$APP_PATH/Contents/Info.plist"
echo "==> Verifying Info.plist merge (silent merge failure is the symptom under test)"
echo "--- plutil -p output (relevant keys) ---"
plutil -p "$INFO_PLIST" | grep -E 'LSUIElement|NSAudioCaptureUsageDescription|CFBundleIdentifier' || true
echo "--- assertions ---"
LSUI=$(plutil -extract LSUIElement raw "$INFO_PLIST") || { echo "!! LSUIElement key MISSING"; exit 2; }
NSAUD=$(plutil -extract NSAudioCaptureUsageDescription raw "$INFO_PLIST") || { echo "!! NSAudioCaptureUsageDescription key MISSING"; exit 2; }
BID=$(plutil -extract CFBundleIdentifier raw "$INFO_PLIST") || { echo "!! CFBundleIdentifier MISSING"; exit 2; }
echo "  LSUIElement = $LSUI"
echo "  NSAudioCaptureUsageDescription = $NSAUD"
echo "  CFBundleIdentifier = $BID"
[ "$LSUI" = "true" ] || { echo "!! LSUIElement present but not true: $LSUI"; exit 2; }
[ -n "$NSAUD" ] || { echo "!! NSAudioCaptureUsageDescription empty"; exit 2; }
[ "$BID" = "$BUNDLE_ID" ] || { echo "!! CFBundleIdentifier mismatch: got $BID expected $BUNDLE_ID"; exit 3; }

BUNDLED_TAP="$APP_PATH/Contents/Resources/systemtap"
test -x "$BUNDLED_TAP" || { echo "!! bundled tap not found/executable at $BUNDLED_TAP"; exit 4; }
echo "  bundled tap: $BUNDLED_TAP"

echo "==> Ad-hoc signing (no Developer ID — SAA-88)"
codesign --force --deep --sign - "$APP_PATH"
echo "==> Verifying signature"
codesign --verify --verbose "$APP_PATH"

echo ""
echo "READY."
echo "  APP: $APP_PATH"
echo "  BUNDLE_ID: $BUNDLE_ID"
