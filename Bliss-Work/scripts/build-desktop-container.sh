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

# ── Verify koffi's bundled native binaries for every platform this build
# packages, BEFORE electron-builder runs ─────────────────────────────────────
# koffi (apps/desktop/src/main/desktop-layer.ts) replaced the old get-windows
# dependency this check used to verify — see git history of this file. Unlike
# get-windows, koffi ships every platform's prebuilt .node file bundled
# directly inside its own npm package; nothing is fetched or compiled at
# install time, so there is no fallback-to-the-wrong-platform failure mode
# here. The risk this check now guards against instead: apps/desktop/
# package.json's `files` list explicitly EXCLUDES every koffi platform this
# build does not ship, to keep the installer small, and a mistake in that
# glob (or a koffi upgrade that changes its layout) could just as easily
# exclude, or omit, a platform this build DOES need. Verify both required
# binaries exist and are genuinely the right format right after npm ci, before
# spending 10 minutes on an electron-builder run that would otherwise package
# a missing or corrupt native module and only fail for users, months later.
for target in "win32_x64 4d5a" "linux_x64 7f454c46"; do
  read -r plat magic <<<"$target"
  node_file="node_modules/koffi/build/koffi/${plat}/koffi.node"
  [ -f "$node_file" ] || { echo "✗ $node_file missing after npm ci" >&2; exit 1; }
  # Read exactly as many bytes as the expected magic is long — PE's "MZ" is 2
  # bytes, ELF's is 4. Reading a fixed 4 regardless would pick up two extra,
  # non-constant DOS-header bytes after "MZ" and the comparison would never
  # match a real PE file (caught by actually running this against the real
  # bundled win32 binary before trusting it, not just by reading the script).
  magic_bytes=$(( ${#magic} / 2 ))
  got="$(head -c "$magic_bytes" "$node_file" | od -An -tx1 | tr -d ' \n')"
  [ "$got" = "$magic" ] || {
    echo "✗ $node_file has magic bytes $got, expected $magic (wrong-platform binary)" >&2
    exit 1
  }
  echo "  ✓ koffi/${plat}/koffi.node verified ($magic)"
done

# Build-time only. Restored at the end: a committed version bump would be a
# source change made by a build, and the version that matters lives in the
# published feed, not in package.json.
#
# Restore by copying back a snapshot, NOT `git checkout`. Git runs as root here
# against a bind-mounted repo owned by another uid and refuses with "dubious
# ownership" — which, behind the `|| true` this used to have, failed silently and
# left the bumped version in the working tree.
#
# package-lock.json needs the same treatment: set-desktop-version.mjs writes the
# bump into BOTH files (npm keeps the workspace version mirrored in the lock),
# so restoring only package.json left the tree dirty with a lock claiming a
# version its package.json doesn't have — which then trips `make prod-deploy`'s
# clean-tree guard (prod-guard, in the Makefile) on the next deploy, for a
# change nobody made on purpose.
PKG=apps/desktop/package.json
LOCK=package-lock.json
PKG_SNAPSHOT="$(mktemp)"
LOCK_SNAPSHOT="$(mktemp)"
cp "$PKG" "$PKG_SNAPSHOT"
cp "$LOCK" "$LOCK_SNAPSHOT"
cleanup() {
    cp "$PKG_SNAPSHOT" "$PKG"
    cp "$LOCK_SNAPSHOT" "$LOCK"
    rm -f "$PKG_SNAPSHOT" "$LOCK_SNAPSHOT"
}
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
