#!/usr/bin/env bash
#
# Setup script to ensure all app logos are properly linked to the centralized
# brand logo at /assets/logo.png.
#
# Run this after updating /assets/logo.png to propagate the change to all apps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ASSETS_DIR="$REPO_ROOT/assets"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Setting up centralized branding assets...${NC}"

# Check if logo.png exists in assets
if [[ ! -f "$ASSETS_DIR/logo.png" ]]; then
    echo "❌ Error: $ASSETS_DIR/logo.png not found"
    echo "   Please save your logo.png to the /assets directory first"
    exit 1
fi

echo -e "${GREEN}✓ Found logo at $ASSETS_DIR/logo.png${NC}"

# Copy logo to desktop build directory
DESKTOP_ICON="$REPO_ROOT/apps/desktop/build/icon.png"
cp "$ASSETS_DIR/logo.png" "$DESKTOP_ICON"
echo -e "${GREEN}✓ Copied logo to apps/desktop/build/icon.png${NC}"

# Copy to web public favicon if needed
WEB_FAVICON="$REPO_ROOT/apps/web/public/favicon.png"
if [[ -f "$WEB_FAVICON" ]]; then
    cp "$ASSETS_DIR/logo.png" "$WEB_FAVICON"
    echo -e "${GREEN}✓ Copied logo to apps/web/public/favicon.png${NC}"
fi

echo ""
echo -e "${BLUE}Branding setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. If needed, regenerate Windows Store tiles:"
echo "   cd apps/desktop && npm run icon"
echo ""
echo "2. Rebuild desktop app:"
echo "   cd apps/desktop && npm run build"
echo ""
echo "3. Rebuild web app:"
echo "   cd apps/web && npm run build"
