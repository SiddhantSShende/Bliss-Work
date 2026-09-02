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

# ── Force-verify get-windows' native prebuilds for every platform this build
# packages, BEFORE electron-builder runs ─────────────────────────────────────
# get-windows' own install script (`node-pre-gyp install --fallback-to-build`)
# only fetches a prebuild for THIS container's own platform (linux/x64) — never
# win32, since nothing else in this pipeline asks for it — and on ANY fetch
# failure it silently falls back to a local `node-gyp` compile, which run on
# this Linux host produces a Linux .node file. That alone would be harmless
# (get-windows never loads that generic build/Release/ path), except the
# missing win32-specific prebuild is what actually breaks Windows: get-windows'
# own loader (node_modules/get-windows/lib/windows.js) does NOT throw when its
# platform's binding folder is absent — `preGyp.find()` just computes a path
# and returns it whether or not it exists, and `getAddon()` falls back to a
# SILENT no-op stub (`{ getActiveWindow() {}, getOpenWindows() {} }`) rather
# than erroring. So a build missing the win32 prebuild looks and behaves
# exactly like a working one, and the failure is only visible as "task notes
# on Windows never rest on the desktop" — which is precisely the incident this
# guards against. Fetch each target platform's prebuild explicitly, with
# node-pre-gyp's build fallback OFF (the default when --fallback-to-build is
# omitted), so a fetch failure stops the BUILD here with a named error instead
# of silently shipping an installer that only fails for users, months later.
NODE_PRE_GYP="$(pwd)/node_modules/.bin/node-pre-gyp"
GET_WINDOWS_DIR="node_modules/get-windows"
[ -x "$NODE_PRE_GYP" ] || { echo "✗ node_modules/.bin/node-pre-gyp missing after npm ci" >&2; exit 1; }
[ -d "$GET_WINDOWS_DIR" ] || { echo "✗ node_modules/get-windows missing after npm ci" >&2; exit 1; }
for target in "win32 x64 unknown 4d5a" "linux x64 glibc 7f454c46"; do
  read -r plat arch libc magic <<<"$target"
  echo "▶ fetching get-windows prebuild: napi-9-${plat}-${libc}-${arch}"
  ( cd "$GET_WINDOWS_DIR" && "$NODE_PRE_GYP" install \
      --target_platform="$plat" --target_arch="$arch" --target_libc="$libc" )
  node_file="$GET_WINDOWS_DIR/lib/binding/napi-9-${plat}-${libc}-${arch}/node-get-windows.node"
  [ -f "$node_file" ] || { echo "✗ $node_file missing after node-pre-gyp install" >&2; exit 1; }
  # Read exactly as many bytes as the expected magic is long — PE's "MZ" is 2
  # bytes, ELF's is 4. Reading a fixed 4 regardless would pick up two extra,
  # non-constant DOS-header bytes after "MZ" and the comparison would never
  # match a real PE file (caught by actually running this against a freshly
  # fetched win32 binary before trusting it, not just by reading the script).
  magic_bytes=$(( ${#magic} / 2 ))
  got="$(head -c "$magic_bytes" "$node_file" | od -An -tx1 | tr -d ' \n')"
  [ "$got" = "$magic" ] || {
    echo "✗ $node_file has magic bytes $got, expected $magic (wrong-platform binary)" >&2
    exit 1
  }
  echo "  ✓ napi-9-${plat}-${libc}-${arch}/node-get-windows.node verified ($magic)"
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
# version its package.json doesn't have — which then trips deploy-prod.sh's
# clean-tree guard on the next deploy, for a change nobody made on purpose.
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
