#!/usr/bin/env bash
#
# Builds the BlissWork .appx package for Microsoft Store submission.
#
# electron-builder's `appx` target only runs where Node reports
# process.platform win32 or darwin (it shells out to Windows Kits'
# makeappx.exe/makepri.exe, fetched automatically) — it will NOT run on
# Linux, even under WSL. Use a Windows or macOS machine, or the
# `store-release.yml` GitHub Actions workflow (runs on windows-latest).
#
# Unlike the direct-download installers (see SIGNING.md), Store packages do
# NOT need to be code-signed by you — Microsoft signs the package during
# Store certification. No CSC_LINK/eSigner cert needed here.
#
# identityName + publisher are assigned by Partner Center when you reserve
# the app name (Partner Center → your app → App identity) and are NOT
# guessable — this script requires them as env vars rather than baking in a
# placeholder that would silently build a wrong-but-valid package.
#
# Usage:
#   export STORE_IDENTITY_NAME="PublisherName.BlissWork"   # from Partner Center → App identity
#   export STORE_PUBLISHER_ID="CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"  # ditto
#   bash build/build-appx.sh
#
# See STORE.md for the full walkthrough.
set -euo pipefail

cd "$(dirname "$0")/.."   # apps/desktop

: "${STORE_IDENTITY_NAME:?Set STORE_IDENTITY_NAME to the value from Partner Center → App identity (see STORE.md)}"
: "${STORE_PUBLISHER_ID:?Set STORE_PUBLISHER_ID to the Publisher ID (CN=...) from Partner Center → App identity (see STORE.md)}"

PLATFORM="$(node -e 'process.stdout.write(process.platform)')"
if [[ "$PLATFORM" != "win32" && "$PLATFORM" != "darwin" ]]; then
  echo "✗ AppX packaging requires Node to report win32 or darwin (got: $PLATFORM)." >&2
  echo "  Build on a real Windows or macOS machine, or use .github/workflows/store-release.yml." >&2
  exit 1
fi

echo "▸ building desktop bundle…"
npm run build

echo "▸ packaging .appx (identityName=$STORE_IDENTITY_NAME)…"
npx --no-install electron-builder \
  --win \
  --config.win.target=appx \
  --config.appx.identityName="$STORE_IDENTITY_NAME" \
  --config.appx.publisher="$STORE_PUBLISHER_ID" \
  --publish never

echo ""
echo "✓ done — .appx is in release/. Upload it to Partner Center:"
echo "  Partner Center → your app → Packages → drag in the .appx → Submit for certification."
ls -la release/*.appx 2>/dev/null || true
