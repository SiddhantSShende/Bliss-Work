#!/bin/sh
# Encrypted logical backups of every service database.
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
set -e

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY (the dump encryption passphrase)}"
PG_USER="${POSTGRES_USER:-taskboard}"
OUT_DIR="${BACKUP_DIR:-backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

for db in authdb taskdb messagingdb notificationdb emaildb; do
  out="$OUT_DIR/${db}-${TS}.sql.enc"
  echo "backing up $db -> $out"
  docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$db" \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
    > "$out"
done
echo "done: encrypted dumps written to $OUT_DIR/ (ts=$TS)"
