#!/usr/bin/env bash
#
# Renders the BlissWork brand mark (build/icon.svg — same artwork as the
# website favicon) into every raster asset the app needs:
#   - build/icon.png              — main app icon (NSIS/mac/Linux/taskbar)
#   - build/appx/*.png            — Microsoft Store (AppX/MSIX) package tile
#                                    assets, picked up automatically by
#                                    electron-builder's `appx` target
#                                    (see package.json → build.appx and
#                                    https://www.electron.build/configuration/appx)
#
# Re-run this whenever build/icon.svg changes — the PNGs are committed so
# CI doesn't need rsvg-convert installed.
#
# Requires: rsvg-convert (Debian/Ubuntu: `sudo apt install librsvg2-bin`)
set -euo pipefail

cd "$(dirname "$0")"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found — 'sudo apt install librsvg2-bin'"; exit 1; }

SRC="icon.svg"
BRAND_COLOR="#6D5BF0"   # apps/web + Bliss-Website theme-color / logo gradient midpoint

render_square() {
  local size="$1" out="$2"
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$out"
  echo "  ✓ $out (${size}x${size})"
}

# A transparent canvas of ($w x $h) with the brand mark centered and scaled to
# $logo px — used for the non-square Store tile/splash assets. Windows draws
# the tile's own backgroundColor (see package.json → build.appx.backgroundColor)
# behind whatever the asset doesn't cover, so we keep these transparent instead
# of baking in a second background.
render_padded() {
  local w="$1" h="$2" logo="$3" out="$4"
  local x y
  x=$(awk "BEGIN{printf \"%.2f\", ($w-$logo)/2}")
  y=$(awk "BEGIN{printf \"%.2f\", ($h-$logo)/2}")
  local inner
  inner="$(sed -e '1d' -e '$d' "$SRC")"
  cat > "/tmp/blisswork-padded-$$.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="$w" height="$h" viewBox="0 0 $w $h">
  <svg x="$x" y="$y" width="$logo" height="$logo" viewBox="0 0 48 48">
$inner
  </svg>
</svg>
EOF
  rsvg-convert -w "$w" -h "$h" "/tmp/blisswork-padded-$$.svg" -o "$out"
  rm -f "/tmp/blisswork-padded-$$.svg"
  echo "  ✓ $out (${w}x${h}, logo ${logo}px)"
}

echo "▸ main app icon"
render_square 1024 icon.png

echo "▸ AppX/Store package tile assets (build/appx/)"
render_square 50  appx/StoreLogo.png
render_square 44  appx/Square44x44Logo.png
render_square 150 appx/Square150x150Logo.png
render_square 310 appx/LargeTile.png        # → Square310x310Logo in the manifest
render_square 71  appx/SmallTile.png
render_padded 310 150 120 appx/Wide310x150Logo.png
render_padded 620 300 220 appx/SplashScreen.png

echo ""
echo "Done. Brand color for the AppX tile background: $BRAND_COLOR (already set in"
echo "package.json → build.appx.backgroundColor — keep them in sync if it changes)."
