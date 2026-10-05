#!/usr/bin/env bash
# Builds the BlissWork Android debug APK with a single command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"
OUT_DIR="$SCRIPT_DIR/build/apk"

echo "========================================"
echo " BlissWork Android APK Build"
echo "========================================"

if ! command -v java >/dev/null 2>&1 && [ -z "${JAVA_HOME:-}" ]; then
  echo "ERROR: No Java found. Install a JDK (17+) or set JAVA_HOME." >&2
  exit 1
fi
echo "OK Environment validated"

cd "$ANDROID_DIR"
./gradlew assembleDebug --console=plain
echo "OK Gradle build completed"

APK_SRC="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "ERROR: Expected APK not found at $APK_SRC" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
APK_DEST="$OUT_DIR/BlissWork-debug.apk"
cp "$APK_SRC" "$APK_DEST"
echo "OK APK generated"

echo ""
echo "APK:"
echo "$(realpath --relative-to="$SCRIPT_DIR" "$APK_DEST" 2>/dev/null || echo "$APK_DEST")"
