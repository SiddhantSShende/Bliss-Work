#!/usr/bin/env bash
# Build and publish the desktop installers. Runs INSIDE the desktop-builder
# container (electronuserland/builder:wine), invoked by docker compose.
#
# Lives in a file rather than inline in docker-compose.prod.yml because compose
# word-splits an inline string command — `bash -lc "a; b; c"` arrives as argv
# ["bash","-lc","a;","b;","c"] and silently runs only the first fragment — and
# because $ escaping inside YAML folded scalars is its own trap. A script is
# also runnable by hand, which is what you want when a build fails.
#
#   Linux  → AppImage + deb, native.
#   Windows→ nsis .exe, built under Wine. Unsigned: signing needs the SSL.com
#            eSigner credentials, and an unsigned .exe still installs, it just
#            shows a SmartScreen warning.
#   macOS  → NOT possible here. Apple requires a .dmg to be produced and signed
#            on macOS. Its feed is left untouched, so mac users stay exactly
#            where they are instead of being pointed at something missing.
set -Eeuo pipefail

DOWNLOADS="${DOWNLOADS:-/downloads}"
BACKUP_DIR="${BACKUP_DIR:-/downloads-backup}"

VER="$(node scripts/next-desktop-version.mjs "$DOWNLOADS")"
echo "▶ building desktop $VER (linux + windows/wine)"

npm ci

# Build-time only. Restored at the end: a committed version bump would be a
# source change made by a build, and the version that matters lives in the
# published feed, not in package.json.
#
# Restore by copying back a snapshot, NOT `git checkout`. Git runs as root here
# against a bind-mounted repo owned by another uid and refuses with "dubious
# ownership" — which, behind the `|| true` this used to have, failed silently and
# left the bumped version in the working tree.
PKG=apps/desktop/package.json
PKG_SNAPSHOT="$(mktemp)"
cp "$PKG" "$PKG_SNAPSHOT"
cleanup() { cp "$PKG_SNAPSHOT" "$PKG" && rm -f "$PKG_SNAPSHOT"; }
trap cleanup EXIT

node scripts/set-desktop-version.mjs "$VER"

npm run build -w @taskboard/desktop
( cd apps/desktop && npx --no-install electron-builder --linux --win --publish never )

# Magic bytes, sizes, and the app-update.yml provider baked into the package —
# the check that catches a build shipping a feed it can't reach, which is what
# froze every 0.1.0 install permanently.
node scripts/check-release-artifacts.mjs apps/desktop/release

# Verifies again, backs up what's live, then copies binaries FIRST and manifests
# LAST so an app polling mid-publish can't read a manifest pointing at a
# half-copied file.
DEST="$DOWNLOADS" BACKUP="$BACKUP_DIR" bash scripts/publish-desktop.sh apps/desktop/release

echo "▶ desktop $VER published to $DOWNLOADS"
