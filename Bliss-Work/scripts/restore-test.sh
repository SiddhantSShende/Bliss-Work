#!/usr/bin/env bash
# Prove the most recent backup set actually restores, automatically, on a
# schedule — not by someone remembering to try it after an incident.
#
# `scripts/backup-db.sh` already verifies each dump decrypts and looks like a
# real pg_dump/tar at BACKUP TIME. That is necessary but not sufficient: it
# proves the encryption round-trips, not that the dump loads cleanly into a
# real Postgres and produces a database with data in it. Nothing in this repo
# exercised that until this script — an untested backup is not a backup, and
# there was no evidence a restore had ever actually been run (see
# docs/BACKUPS.md and Part A.8 of the scaling roadmap).
#
# Runs entirely against a disposable, unpublished scratch Postgres container —
# never the real stack, never a live volume. Restores every service database
# from the latest same-timestamp backup set, checks each one has tables and
# rows (not just "psql exited 0" — a schema-only restore of an empty dump
# would also exit 0), extracts the media tar and counts what came out, then
# tears the scratch container down unconditionally.
#
# bash + pipefail for the same reason as backup-db.sh/restore-db.sh: under
# `sh -e` a failed decrypt is masked by psql's exit status.
set -Eeuo pipefail

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY (the dump encryption passphrase)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/blisswork}"
PG_USER="${POSTGRES_USER:-taskboard}"
PG_IMAGE="${RESTORE_TEST_PG_IMAGE:-postgres:17-alpine}"
SCRATCH_PASSWORD="${RESTORE_TEST_PG_PASSWORD:-restore-test-scratch-only}"
CONTAINER="blisswork-restore-test-$$"
TMPDIR_MEDIA="$(mktemp -d)"

if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
  exit 1
fi

# Always tear down the scratch container and temp dir, success or failure —
# this must never leave a stray container or an unencrypted media extract
# behind on the host.
cleanup() {
  $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMPDIR_MEDIA"
}
trap cleanup EXIT

fail() {
  echo "RESTORE-TEST FAILED: $1" >&2
  if [ -n "${SMTP_HOST:-}" ] && [ -n "${SMTP_FROM:-}" ]; then
    SUBJECT="[BlissWork] restore-test FAILED: $1" \
      BODY="The nightly restore-test job failed: $1

This means the most recent backup set has NOT been proven to restore. Check:
  sudo journalctl -u blisswork-restore-test.service
before assuming last night's backup is usable." \
      ALERT_TO="${ALERT_EMAIL_TO:-$SMTP_FROM}" \
      python3 "$REPO_DIR/scripts/send-alert.py" || \
      echo "  (also failed to send the failure alert email — see SMTP_* env)" >&2
  fi
  exit 1
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Find the latest complete backup set ─────────────────────────────────────
#
# backup-db.sh stamps one TS at the top of its run and reuses it for every
# db and the media archive, so "latest" is the newest authdb-*.sql.enc's
# timestamp, and every other file for that same run shares it.
latest_authdb=$(find "$BACKUP_DIR" -maxdepth 1 -name 'authdb-*.sql.enc' -type f | sort | tail -1)
if [ -z "$latest_authdb" ]; then
  fail "no authdb-*.sql.enc found under $BACKUP_DIR"
fi
ts="${latest_authdb#*authdb-}"
ts="${ts%.sql.enc}"
echo "testing backup set ts=${ts}"

DBS="authdb taskdb messagingdb notificationdb emaildb integrationsdb telemetrydb"
for db in $DBS; do
  f="$BACKUP_DIR/${db}-${ts}.sql.enc"
  [ -f "$f" ] || fail "missing $f — backup set is incomplete for ts=${ts}"
done

# ── Scratch Postgres, fully disposable, no published port ──────────────────
$DOCKER run -d --rm --name "$CONTAINER" \
  -e "POSTGRES_PASSWORD=${SCRATCH_PASSWORD}" \
  -e "POSTGRES_USER=${PG_USER}" \
  "$PG_IMAGE" >/dev/null

echo "waiting for scratch postgres..."
for i in $(seq 1 60); do
  if $DOCKER exec "$CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    fail "scratch postgres never became ready"
  fi
done

# ── Restore each database and check it isn't an empty shell ────────────────
total_tables=0
total_rows=0
for db in $DBS; do
  f="$BACKUP_DIR/${db}-${ts}.sql.enc"
  echo "restoring $db..."
  $DOCKER exec "$CONTAINER" createdb -U "$PG_USER" "$db"

  if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$f" \
      | $DOCKER exec -i "$CONTAINER" psql -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1 -q \
      >/dev/null; then
    fail "$db did not restore cleanly (psql/decrypt pipeline failed)"
  fi

  tables=$($DOCKER exec "$CONTAINER" psql -U "$PG_USER" -d "$db" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
  if [ "${tables:-0}" -eq 0 ]; then
    fail "$db restored with ZERO tables — this is a schema-only or empty dump, not a real backup"
  fi

  # Sum of every user table's row estimate. Cheap (reads planner stats, not a
  # full scan of every table) and only needs to distinguish "has data" from
  # "restored an empty database" — not to be exact.
  rows=$($DOCKER exec "$CONTAINER" psql -U "$PG_USER" -d "$db" -tAc \
    "SELECT COALESCE(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables")
  echo "  ok: $db — ${tables} tables, ~${rows} rows"
  total_tables=$((total_tables + tables))
  total_rows=$((total_rows + rows))
done

if [ "$total_rows" -eq 0 ]; then
  fail "every restored database has zero rows across all seven — the backup set restored structurally but carries no data"
fi

# ── Media blob archive: extract and count, don't fail on a legitimately
# empty deployment (same reasoning as backup-db.sh's own media handling) ───
media_file="$BACKUP_DIR/media-${ts}.tar.enc"
if [ -f "$media_file" ]; then
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$media_file" \
      | tar -xf - -C "$TMPDIR_MEDIA"; then
    fail "media-${ts}.tar.enc did not decrypt/extract cleanly"
  fi
  blob_count=$(find "$TMPDIR_MEDIA" -type f | wc -l)
  echo "  ok: media archive — ${blob_count} blob(s) extracted"
else
  echo "  skipping media: no media-${ts}.tar.enc for this backup set (pre-media deployment, or media backup failed to produce a file — check the backup run itself)"
fi

echo "RESTORE-TEST PASSED: ts=${ts}, ${total_tables} tables, ${total_rows} total rows across ${DBS// /, }"
