#!/bin/sh
# Decrypt + restore an encrypted dump produced by backup-db.sh.
#   BACKUP_ENCRYPTION_KEY=<passphrase> ./scripts/restore-db.sh <file.sql.enc> <targetdb>
set -e

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY}"
FILE="${1:?usage: restore-db.sh <file.sql.enc> <targetdb>}"
DB="${2:?usage: restore-db.sh <file.sql.enc> <targetdb>}"
PG_USER="${POSTGRES_USER:-taskboard}"

openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$FILE" \
  | docker compose exec -T postgres psql -U "$PG_USER" -d "$DB"
echo "restored $FILE -> $DB"
