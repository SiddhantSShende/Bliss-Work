#!/usr/bin/env bash
# Ship the encrypted dumps AND the chat-media archive to a second machine over SSH.
#
#   BACKUP_REMOTE=user@host:/path/to/blisswork ./scripts/backup-offsite.sh
#
# Runs straight after backup-db.sh in blisswork-backup.service, so it only ever
# ships dumps that were already verified locally. The files are AES-256-CBC
# ciphertext before they leave this host — the target never sees plaintext and
# does not need to be trusted with the data, only with storing it.
#
# Env:
#   BACKUP_REMOTE   rsync destination, e.g. backup@10.0.0.5:/srv/blisswork  (REQUIRED)
#   BACKUP_DIR      source directory (default /var/backups/blisswork)
#   BACKUP_SSH_KEY  identity file (default /root/.ssh/blisswork-backup)
#   OFFSITE_REQUIRED  1 (default) = an unconfigured/unreachable target fails the
#                     unit. Set 0 only if you deliberately want local-only.
#
# NO --delete. The remote is not a mirror of the local directory: if this host
# is compromised or its disk wipes, a mirroring rsync would faithfully propagate
# that and destroy the only surviving copy. The remote grows instead. Prune it
# there, on its own schedule. Size it for the media archive, not just the dumps:
# media-<ts>.tar.enc is a FULL tar of the media volume every run (encrypted with a
# fresh salt, so rsync cannot delta it), and it is the part that grows with usage.
#
# The media archive has to be in this set. The databases hold only attachment
# METADATA; without the blobs a restored workspace has every message and every
# attachment 404s. It used to be excluded by the include list below, so it never
# left this host and the loss of the host lost every attachment.
set -Eeuo pipefail

SRC="${BACKUP_DIR:-/var/backups/blisswork}"
KEY="${BACKUP_SSH_KEY:-/root/.ssh/blisswork-backup}"
REQUIRED="${OFFSITE_REQUIRED:-1}"

if [ -z "${BACKUP_REMOTE:-}" ]; then
  echo "OFFSITE NOT CONFIGURED: BACKUP_REMOTE is unset." >&2
  echo "  Set it in /etc/blisswork-backup.env, e.g." >&2
  echo "    BACKUP_REMOTE=backup@your-host:/srv/blisswork" >&2
  # Fail by default. Off-host backup was asked for; quietly not doing it is the
  # exact failure mode this whole change exists to eliminate. A red unit is a
  # reminder, silence is not.
  [ "$REQUIRED" = "1" ] && exit 1
  echo "  OFFSITE_REQUIRED=0, continuing local-only." >&2
  exit 0
fi

if [ ! -r "$KEY" ]; then
  echo "OFFSITE FAILED: ssh key $KEY is missing or unreadable" >&2
  exit 1
fi

SSH_CMD="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

echo "shipping $SRC -> $BACKUP_REMOTE"
if ! rsync -a --human-readable --stats \
      --include='*.sql.enc' --include='*.tar.enc' --exclude='*' \
      -e "$SSH_CMD" "$SRC"/ "$BACKUP_REMOTE"/ 2>&1 | tail -6; then
  echo "OFFSITE FAILED: rsync returned non-zero" >&2
  exit 1
fi

# Don't trust rsync's exit code alone — confirm today's dumps are actually
# readable on the far end. A backup you haven't confirmed landed is a guess.
TODAY_LOCAL=$(find "$SRC" -maxdepth 1 \( -name '*.sql.enc' -o -name '*.tar.enc' \) -mtime -1 -printf '%f\n' | sort)
if [ -z "$TODAY_LOCAL" ]; then
  echo "OFFSITE FAILED: no archives from the last 24h to verify" >&2
  exit 1
fi

REMOTE_HOST="${BACKUP_REMOTE%%:*}"
REMOTE_PATH="${BACKUP_REMOTE#*:}"
missing=0
while read -r f; do
  [ -z "$f" ] && continue
  local_size=$(stat -c%s "$SRC/$f")
  remote_size=$($SSH_CMD "$REMOTE_HOST" "stat -c%s '$REMOTE_PATH/$f' 2>/dev/null" || echo "")
  if [ "$remote_size" != "$local_size" ]; then
    echo "  MISSING/TRUNCATED on remote: $f (local=$local_size remote=${remote_size:-absent})" >&2
    missing=1
  fi
done <<< "$TODAY_LOCAL"

if [ "$missing" -ne 0 ]; then
  echo "OFFSITE FAILED: at least one dump did not land intact" >&2
  exit 1
fi

echo "offsite ok: $(echo "$TODAY_LOCAL" | wc -l) archive(s) verified on $REMOTE_HOST"
