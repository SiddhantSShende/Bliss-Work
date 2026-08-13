#!/usr/bin/env bash
# Publish desktop installers to the live download host — without GitHub Actions.
#
#   bash scripts/publish-desktop.sh <dir-with-installers> [--dry-run]
#
# The release workflow is the normal path. This exists because that path has two
# hard dependencies that fail independently of the app: GitHub-hosted runners
# (the only place Windows and macOS can be built and signed) and repository
# secrets. When either is broken, working installers still can't reach users —
# which is how /downloads sat on a Jul 27 build while the app itself packaged
# fine the whole time.
#
# Use it with either:
#   * a local build      — `cd apps/desktop && npx electron-builder --linux`
#   * workflow artifacts — download "installers-*" from a Release Desktop run
#                          and unzip them into one directory
#
# THIS HOST IS the download server, so publishing is a copy, not an upload.
#
# What it will NOT do:
#   * publish a file that isn't a real installer (magic bytes + size checked)
#   * publish a manifest before its binaries (an app polling mid-publish must
#     never read a manifest pointing at a file that isn't there yet)
#   * touch a platform you didn't build — each platform has its own feed, so
#     shipping Linux leaves Windows and macOS users exactly where they were
set -Eeuo pipefail

SRC="${1:?usage: publish-desktop.sh <dir-with-installers> [--dry-run]}"
DRY="${2:-}"
DEST="${DEST:-/home/ubuntu/BlissWork/downloads}"
BACKUP="${BACKUP:-/home/ubuntu/BlissWork/downloads-backup}"

[ -d "$SRC" ] || { echo "no such directory: $SRC" >&2; exit 1; }
[ -d "$DEST" ] || { echo "destination missing: $DEST" >&2; exit 1; }

# ── Collect what's actually here ────────────────────────────────────────────
installers=()
while IFS= read -r f; do installers+=("$f"); done < <(
  find "$SRC" -maxdepth 1 -type f \( -name 'BlissWork-*.exe' -o -name 'BlissWork-*.dmg' \
    -o -name 'BlissWork-*.AppImage' -o -name 'BlissWork-*.deb' -o -name 'BlissWork-*.blockmap' \) | sort
)
manifests=()
while IFS= read -r f; do manifests+=("$f"); done < <(
  find "$SRC" -maxdepth 1 -type f -name 'latest*.yml' | sort
)

[ ${#installers[@]} -gt 0 ] || { echo "no installers found in $SRC" >&2; exit 1; }

# ── Verify before touching anything live ────────────────────────────────────
# A size floor alone is too blunt: a truncated download or an HTML error page
# saved under the right name can still be large. Check what the file IS.
echo "Verifying ${#installers[@]} file(s):"
for f in "${installers[@]}"; do
  name=$(basename "$f")
  size=$(stat -c%s "$f")
  case "$name" in
    *.blockmap) min=1024 ;;
    *)          min=$((5 * 1024 * 1024)) ;;
  esac
  if [ "$size" -lt "$min" ]; then
    echo "  ✗ $name is only $size bytes — refusing to publish" >&2
    exit 1
  fi
  magic=$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')
  case "$name" in
    *.exe)      [ "${magic:0:4}" = "4d5a" ] || { echo "  ✗ $name is not a PE binary" >&2; exit 1; } ;;
    *.deb)      [ "${magic:0:8}" = "213c6172" ] || { echo "  ✗ $name is not a .deb archive" >&2; exit 1; } ;;
    *.AppImage) [ "${magic:0:4}" = "7f45" ] || { echo "  ✗ $name is not an ELF binary" >&2; exit 1; } ;;
  esac
  printf '  ✓ %-40s %s bytes\n' "$name" "$size"
done

for m in "${manifests[@]}"; do
  grep -q '^version:' "$m" || { echo "  ✗ $(basename "$m") has no version: key" >&2; exit 1; }
  printf '  ✓ %-40s %s\n' "$(basename "$m")" "$(grep '^version:' "$m")"
done

if [ "$DRY" = "--dry-run" ]; then
  echo "dry run — nothing copied."
  exit 0
fi

# ── Back up what's live, so a bad publish is one command to undo ────────────
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP/$stamp"
cp -a "$DEST"/. "$BACKUP/$stamp/" 2>/dev/null || true
echo "backed up current /downloads -> $BACKUP/$stamp"

# ── Installers FIRST, manifests LAST ────────────────────────────────────────
# An app that polls mid-publish then reads the OLD manifest, which points at
# files that still exist — rather than a new manifest pointing at a binary that
# is still copying, which would fail its hash check and dead-end the updater.
for f in "${installers[@]}"; do
  cp -f "$f" "$DEST/"
  echo "  published $(basename "$f")"
done

# Checksums cover only what is now live, recomputed here rather than trusted
# from the build, so they always describe the bytes actually being served.
( cd "$DEST" && sha256sum BlissWork-* > SHA256SUMS.txt )
echo "  regenerated SHA256SUMS.txt"

for m in "${manifests[@]}"; do
  cp -f "$m" "$DEST/"
  echo "  published $(basename "$m")  <- feed updated"
done

chmod 644 "$DEST"/* 2>/dev/null || true
echo
echo "Done. Live now:"
ls -l --time-style=+"%m-%d %H:%M" "$DEST" | tail -n +2 | awk '{printf "  %-42s %10s  %s %s\n", $7, $5, $6, $7}' | sort -u | head -20
