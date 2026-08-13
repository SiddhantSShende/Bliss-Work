#!/usr/bin/env bash
# Encrypted logical backups of every service database, plus the chat media volume.
#
# Each pg_dump is streamed through AES-256-CBC (openssl, PBKDF2) so plaintext
# never touches disk. Encrypted columns stay ciphertext inside the dump; the
# org_keys rows (also dumped) are what make them readable on restore — so a
# crypto-shredded org stays unreadable even from a backup.
#
#   BACKUP_ENCRYPTION_KEY=<strong-passphrase> ./scripts/backup-db.sh
#   # restore: ./scripts/restore-db.sh backups/<db>-<ts>.sql.enc <targetdb>
#
# Runs against the running compose stack (pg_dump inside the postgres container).
#
# Env: BACKUP_DIR (default ./backups), BACKUP_KEEP_DAYS (default 14, 0 = keep
# everything), COMPOSE_FILE, POSTGRES_USER.
#
# bash, not sh, and `pipefail` specifically: under `sh -e` a failing pg_dump in
# `pg_dump | openssl > out` is INVISIBLE — the pipeline's status is openssl's,
# which succeeds at encrypting nothing. That wrote a valid-looking 0-byte
# backup and reported success. A backup that fails loudly is worth something; a
# backup that fails silently is worse than none, because you stop looking.
set -Eeuo pipefail

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY (the dump encryption passphrase)}"
PG_USER="${POSTGRES_USER:-taskboard}"
OUT_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# Production is the `task-board-prod` project in docker-compose.prod.yml. A bare
# `docker compose` picks up the DEV docker-compose.yml, whose postgres isn't
# running here — so the default has to be explicit or every scheduled run fails.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE

# Docker may need sudo depending on the invoking user's groups; under systemd
# this runs as root and needs neither. Detect rather than assume.
if docker info >/dev/null 2>&1; then
  USE_SUDO=0
elif sudo -n docker info >/dev/null 2>&1; then
  USE_SUDO=1
else
  echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
  exit 1
fi

# COMPOSE_FILE must reach compose, and SUDO SANITIZES THE ENVIRONMENT — an
# exported COMPOSE_FILE does NOT survive `sudo docker compose`. Compose then
# falls back to ./docker-compose.yml, i.e. the DEV stack, whose postgres is not
# running on this host. The failure reads "service postgres is not running",
# which points at the database rather than at the missing variable, so it costs
# real time to diagnose. (deploy-prod.sh documents the identical trap for
# IMAGE_TAG.) Under systemd this runs as root, takes the no-sudo branch and the
# bug is invisible — it only bites a human running the script by hand.
compose() {
  if (( USE_SUDO )); then
    sudo env COMPOSE_FILE="$COMPOSE_FILE" docker compose "$@"
  else
    docker compose "$@"
  fi
}

# A dump smaller than this is not a real database — it's a connection error that
# got encrypted. Even an empty schema-only dump is several KB of DDL.
MIN_BYTES=2048

mkdir -p "$OUT_DIR"
failed=0

for db in authdb taskdb messagingdb notificationdb emaildb integrationsdb telemetrydb; do
  out="$OUT_DIR/${db}-${TS}.sql.enc"
  part="$out.part"
  echo "backing up $db -> $out"

  # Write to .part and rename only after verification, so an interrupted or
  # failed run never leaves something that looks like a usable backup.
  if ! compose exec -T postgres pg_dump -U "$PG_USER" -d "$db" \
      | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
      > "$part"; then
    echo "  FAILED: pg_dump/openssl pipeline returned non-zero" >&2
    rm -f "$part"
    failed=1
    continue
  fi

  size=$(wc -c < "$part")
  if [ "$size" -lt "$MIN_BYTES" ]; then
    echo "  FAILED: only ${size} bytes — treating as a failed dump, not a small one" >&2
    rm -f "$part"
    failed=1
    continue
  fi

  # Prove it decrypts and that what comes out is actually a pg_dump, not
  # ciphertext of an error message. Cheap: only the first lines are decrypted.
  #
  # Capture first, match second. Matching inside the pipeline lets `grep -q`
  # exit early, SIGPIPE openssl, and — under pipefail — report a perfectly good
  # backup as failed. That raced on dump size: small DBs passed, large ones
  # didn't. `|| true` on both stages keeps the expected SIGPIPE from failing it.
  header=$( { openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY \
                -in "$part" 2>/dev/null || true; } | head -c 4096 || true )
  if ! printf '%s' "$header" | grep -q "PostgreSQL database dump"; then
    echo "  FAILED: decrypted output is not a PostgreSQL dump" >&2
    rm -f "$part"
    failed=1
    continue
  fi

  mv "$part" "$out"
  echo "  ok (${size} bytes, verified)"
done

# ── Chat attachment blobs ─────────────────────────────────────────────────────
#
# NOT in any pg_dump: attachment BYTES live on the `media_blobs` volume, and only
# their metadata is in messagingdb. Restoring the databases alone would bring
# back every chat message with its attachments 404ing — history that looks
# intact and isn't. So the volume gets its own leg through the same encryption
# pipeline.
#
# Streamed as a tar, so this scales with however much media the workspace holds
# rather than with anything we can bound here. Unlike the dumps there is no
# minimum size: a deployment that has never had an upload legitimately produces
# an almost-empty archive, and failing the whole backup over that would be wrong.
media_out="$OUT_DIR/media-${TS}.tar.enc"
media_part="$media_out.part"

# A deployment from before chat media existed has no volume to archive, and
# failing every backup over that would be wrong. Probe first and skip loudly.
# Note this only skips when the path is genuinely ABSENT — an empty but present
# blobs/ still gets archived, so "media vanished" is not silently tolerated.
if ! compose exec -T messaging-svc test -d /var/lib/blisswork/media/blobs 2>/dev/null; then
  echo "skipping chat media: /var/lib/blisswork/media/blobs not present (pre-media deployment?)"
elif ! compose exec -T messaging-svc \
      tar -C /var/lib/blisswork/media -cf - blobs \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
    > "$media_part"; then
  echo "  FAILED: media tar/openssl pipeline returned non-zero" >&2
  rm -f "$media_part"
  failed=1
else
  # Prove it decrypts into a real tar. `tar -t` on the first blocks is enough;
  # as with the dumps, the expected SIGPIPE must not fail the run under pipefail.
  if { openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY \
         -in "$media_part" 2>/dev/null || true; } | tar -tf - >/dev/null 2>&1; then
    mv "$media_part" "$media_out"
    echo "  ok ($(wc -c < "$media_out") bytes, verified)"
  else
    echo "  FAILED: decrypted output is not a readable tar archive" >&2
    rm -f "$media_part"
    failed=1
  fi
fi

if [ "$failed" -ne 0 ]; then
  echo "BACKUP FAILED — at least one database or the media volume did not produce a verified archive (ts=$TS)" >&2
  exit 1
fi

# Prune only AFTER a fully successful run: never delete the last known-good
# backups because today's attempt failed.
if [ "$KEEP_DAYS" -gt 0 ]; then
  pruned=$(find "$OUT_DIR" -maxdepth 1 \( -name '*.sql.enc' -o -name '*.tar.enc' \) -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)
  [ "$pruned" -gt 0 ] && echo "pruned $pruned dump(s) older than ${KEEP_DAYS} days"
fi

echo "done: encrypted dumps written to $OUT_DIR/ (ts=$TS)"
