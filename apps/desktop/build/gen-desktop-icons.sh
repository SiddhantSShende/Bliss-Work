#!/usr/bin/env bash
#
# Build the multi-resolution Windows .ico and macOS .icns from build/icon.svg.
#
# electron-builder WILL convert icon.png for you, but that gives no control over
# the small end of the ladder. This mark has thin details — the chat bubble's
# tail and the three dots — that turn to mush when a 1024px raster is naively
# downscaled to 16px. Rendering each size directly from the vector keeps them
# legible in the taskbar, Explorer and the Start menu.
#
# Optional tooling; the build still works without it (electron-builder falls
# back to icon.png), so this exits 0 with a note when the tools are missing.
#
# Requires: rsvg-convert (librsvg2-bin) + icotool (icoutils)
#           png2icns (icnsutils) — macOS assets only, skipped if absent
set -euo pipefail

cd "$(dirname "$0")"
SRC="icon.svg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v rsvg-convert >/dev/null; then
  echo "  rsvg-convert not found — 'sudo apt install librsvg2-bin'. Skipping."
  exit 0
fi

# The ICO ladder Windows actually asks for.
SIZES=(16 24 32 48 64 128 256)
PNGS=()
for s in "${SIZES[@]}"; do
  rsvg-convert -w "$s" -h "$s" "$SRC" -o "$WORK/icon-$s.png"
  PNGS+=("$WORK/icon-$s.png")
done

if command -v icotool >/dev/null; then
  icotool -c -o icon.ico "${PNGS[@]}"
  echo "  ✓ icon.ico ($(IFS=,; echo "${SIZES[*]}"))"
else
  echo "  icotool not found — 'sudo apt install icoutils'. Skipping icon.ico."
fi

if command -v png2icns >/dev/null; then
  # png2icns only accepts a fixed set of square sizes.
  png2icns icon.icns "$WORK/icon-16.png" "$WORK/icon-32.png" \
    "$WORK/icon-128.png" "$WORK/icon-256.png" >/dev/null
  echo "  ✓ icon.icns (16,32,128,256)"
else
  echo "  png2icns not found — 'sudo apt install icnsutils'. Skipping icon.icns."
fi
