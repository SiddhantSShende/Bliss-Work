#!/usr/bin/env bash
# Copy the attachment volume into an S3-compatible bucket, then verify.
#
#   bash scripts/migrate-blobs-to-s3.sh              # copy + verify
#   MIGRATE_DRY_RUN=1 bash scripts/migrate-blobs-to-s3.sh
#
# ── Why this is a copy and not a move ────────────────────────────────────────
# Nothing is deleted from the volume. The cutover is a config flip
# (MEDIA_BACKEND=s3) and the rollback is flipping it back — which only works if
# the disk still holds everything. Delete the volume weeks later, once you are
# sure, and not as part of this.
#
# ── Why no database change is needed ─────────────────────────────────────────
# attachments.storage_path is RELATIVE (`blobs/{orgID}/{ab}/{cd}/{sha}`) and the
# S3 backend uses byte-for-byte the same layout, so every existing row resolves
# against the bucket unchanged. That is a deliberate property of the S3
# implementation, asserted by
# TestS3IntegrationRelPathMatchesFilesystemLayout — not a happy accident.
#
# ── Order of operations ──────────────────────────────────────────────────────
#   1. Run this while still on MEDIA_BACKEND=fs. Uploads keep working.
#   2. Verify the object count matches.
#   3. Re-run it immediately before the cutover to catch anything uploaded in
#      between. It is idempotent — `mc mirror` skips objects already present.
#   4. Flip MEDIA_BACKEND=s3 and restart messaging-svc.
#
# Step 3 matters: between the first copy and the cutover, users keep attaching
# files to the disk. Without a second pass those become the only attachments
# that 404 after the switch, which is a maddening bug to chase.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE
cd "$REPO_DIR"

: "${MEDIA_S3_ENDPOINT:?set MEDIA_S3_ENDPOINT (host:port, no scheme)}"
: "${MEDIA_S3_BUCKET:?set MEDIA_S3_BUCKET}"
: "${MEDIA_S3_ACCESS_KEY:?set MEDIA_S3_ACCESS_KEY}"
: "${MEDIA_S3_SECRET_KEY:?set MEDIA_S3_SECRET_KEY}"
MEDIA_S3_USE_SSL="${MEDIA_S3_USE_SSL:-true}"
MEDIA_S3_PREFIX="${MEDIA_S3_PREFIX:-}"
MEDIA_VOLUME="${MEDIA_VOLUME:-task-board-prod_media_blobs}"

scheme="https"; [ "$MEDIA_S3_USE_SSL" = "false" ] && scheme="http"
dest="tb/${MEDIA_S3_BUCKET}"
[ -n "$MEDIA_S3_PREFIX" ] && dest="${dest}/${MEDIA_S3_PREFIX}"

if docker info >/dev/null 2>&1; then SUDO=""; else SUDO="sudo -n"; fi

# `mc` in a throwaway container: no host install, and it never touches the repo.
# The media volume is mounted READ-ONLY — this script must be incapable of
# damaging the thing it is copying.
mc() {
  $SUDO docker run --rm \
    -v "${MEDIA_VOLUME}:/media:ro" \
    --network host \
    --entrypoint /bin/sh \
    minio/mc:latest -c "mc --quiet alias set tb ${scheme}://${MEDIA_S3_ENDPOINT} '${MEDIA_S3_ACCESS_KEY}' '${MEDIA_S3_SECRET_KEY}' >/dev/null && $*"
}

echo "→ source volume : ${MEDIA_VOLUME} (read-only)"
echo "→ destination   : ${scheme}://${MEDIA_S3_ENDPOINT}/${dest}"

if [ -n "${MIGRATE_DRY_RUN:-}" ]; then
  echo "→ DRY RUN — nothing will be written"
  mc "mc mirror --dry-run /media/blobs ${dest}/blobs" | tail -20
  exit 0
fi

mc "mc mb --ignore-existing ${dest%%/*}" >/dev/null 2>&1 || true
echo "→ copying blobs…"
mc "mc mirror --overwrite /media/blobs ${dest}/blobs"

# Verify by count. Not a checksum comparison: mc mirror already verifies each
# object's ETag on write, and a full re-hash of a large volume would take hours
# for a weaker guarantee than "every file arrived".
echo "→ verifying…"
src_count="$(mc 'find /media/blobs -type f | wc -l' | tr -d '[:space:]')"
dst_count="$(mc "mc ls --recursive ${dest}/blobs | wc -l" | tr -d '[:space:]')"
echo "   source objects: ${src_count}"
echo "   bucket objects: ${dst_count}"

if [ "$src_count" != "$dst_count" ]; then
  echo "MISMATCH — do NOT cut over. Re-run, then investigate the difference." >&2
  exit 1
fi

cat <<EOF

✓ ${dst_count} objects copied and verified.

Nothing was deleted from ${MEDIA_VOLUME}; it is still the live store.
To cut over:
  1. Re-run this script (catches anything uploaded since — it is idempotent).
  2. Set MEDIA_BACKEND=s3 plus the MEDIA_S3_* vars in .env.prod.
  3. docker compose -f docker-compose.prod.yml up -d messaging-svc
  4. Send an attachment, reload it, and scrub a video (Range requests).

To roll back, set MEDIA_BACKEND=fs and restart. Keep the volume until you are
certain — deleting it is what makes the rollback impossible.
EOF
