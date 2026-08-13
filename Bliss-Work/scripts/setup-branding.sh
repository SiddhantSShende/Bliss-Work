#!/usr/bin/env bash
#
# Propagate the BlissWork brand mark to every app that renders it.
#
# The SOURCE OF TRUTH is apps/desktop/build/icon.svg — vector, square, and the
# same artwork as the website favicon. Everything raster is DERIVED from it.
#
# History / why this matters: this script used to do
#     cp assets/logo.png apps/desktop/build/icon.png
# which quietly broke packaging. assets/logo.png is 257x237 — NOT square and
# under 256px on one axis — and electron-builder requires a square icon of at
# least 256x256 to generate the Windows .ico and macOS .icns. Running the old
# script replaced a good 1024x1024 icon with an unusable one, and the packaged
# app fell back to the stock Electron icon. Derive, never copy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$REPO_ROOT/apps/desktop/build"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[0;33m'; NC='\033[0m'

echo -e "${BLUE}Propagating BlissWork branding from build/icon.svg…${NC}"

if [[ ! -f "$BUILD_DIR/icon.svg" ]]; then
  echo "❌ $BUILD_DIR/icon.svg not found — that file is the source of truth."
  exit 1
fi

# 1. Desktop raster assets (icon.png + every Store tile), rendered from the SVG.
echo -e "${BLUE}→ desktop icon + Store tiles${NC}"
bash "$BUILD_DIR/gen-appx-assets.sh"

# 2. Windows .ico / macOS .icns, if the optional tooling is available.
#    electron-builder can convert icon.png on the fly, but a hand-built multi
#    resolution .ico controls how the mark looks at 16/24/32px — exactly the
#    sizes where this mark's thin details (bubble tail, three dots) suffer most
#    from a naive downscale of a 1024px source.
echo -e "${BLUE}→ multi-resolution .ico / .icns${NC}"
bash "$BUILD_DIR/gen-desktop-icons.sh" || \
  echo -e "${YELLOW}  (skipped — see the note printed above)${NC}"

# 3. Web + desktop-renderer favicons track the same SVG.
echo -e "${BLUE}→ favicons${NC}"
cp "$BUILD_DIR/icon.svg" "$REPO_ROOT/apps/web/public/favicon.svg"
echo -e "${GREEN}  ✓ apps/web/public/favicon.svg${NC}"
mkdir -p "$REPO_ROOT/apps/desktop/src/renderer/public"
cp "$BUILD_DIR/icon.svg" "$REPO_ROOT/apps/desktop/src/renderer/public/favicon.svg"
echo -e "${GREEN}  ✓ apps/desktop/src/renderer/public/favicon.svg${NC}"

# 4. The shared /assets copy, for docs and any non-app consumer. Derived from
#    the SVG so it is square — never the other way around.
cp "$BUILD_DIR/icon.png" "$REPO_ROOT/assets/logo.png"
echo -e "${GREEN}  ✓ assets/logo.png (square, derived from icon.svg)${NC}"

echo
echo -e "${BLUE}Done.${NC} If icon.svg changed, commit the regenerated assets:"
echo "  git add apps/desktop/build apps/web/public/favicon.svg \\"
echo "          apps/desktop/src/renderer/public/favicon.svg assets/logo.png"
