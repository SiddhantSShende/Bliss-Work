#!/usr/bin/env bash
# Decrypt + restore an encrypted dump produced by backup-db.sh.
#   BACKUP_ENCRYPTION_KEY=<passphrase> ./scripts/restore-db.sh <file.sql.enc> <targetdb>
#
# bash + pipefail for the same reason as backup-db.sh: under `sh -e` a failed
# decrypt is masked by psql's exit status, so a wrong passphrase looked like a
# successful restore of nothing.
set -Eeuo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-job.sh"

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY}"
FILE="${1:?usage: restore-db.sh <file.sql.enc> <targetdb>}"
DB="${2:?usage: restore-db.sh <file.sql.enc> <targetdb>}"
PG_USER="${POSTGRES_USER:-taskboard}"

# Same as backup-db.sh: a bare `docker compose` is the DEV stack, so restoring
# would silently target the wrong (or a nonexistent) postgres.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE

detect_docker_sudo

# --single-transaction wraps the whole restore in one BEGIN/COMMIT: without
# it, an error partway through (very much the disaster-recovery case this
# script exists for — restoring onto an existing, possibly-corrupted
# database, not a pristine empty one) leaves the target neither in its old
# state nor the new one, with ON_ERROR_STOP=1 having already aborted midway.
# A single transaction rolls back cleanly on any failure instead, so a
# failed restore is a clean no-op to retry, not a database in an unknown
# partial state mid-incident.
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$FILE" \
  | $DOCKER compose exec -T postgres psql -U "$PG_USER" -d "$DB" -v ON_ERROR_STOP=1 --single-transaction
echo "restored $FILE -> $DB"
