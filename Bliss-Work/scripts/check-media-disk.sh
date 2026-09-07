#!/usr/bin/env bash
# Watch free space on the filesystem backing the chat-media volume, and email
# when it gets tight.
#
#   bash scripts/check-media-disk.sh            # check + alert if needed
#   ALERT_FORCE=1 bash scripts/check-media-disk.sh   # send regardless (test the pipe)
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Postgres enforces its own limits; a filesystem does not. MEDIA_ORG_DAILY_BYTES
# caps how fast ONE org can upload, not how much everything adds up to, so media
# growth is bounded only by how many orgs are active. And the volume shares a
# filesystem with the database, the images and the desktop installers — so a
# volume that fills does not merely stop uploads, it takes Postgres down with
# it. This runs early enough to be boring.
#
# ── Why email and not a log line ─────────────────────────────────────────────
# Prometheus and Alertmanager exist in this repo but only under the dev
# `observability` profile; production runs neither. journalctl is not an alert —
# nobody reads it until after the outage. SMTP is already configured and proven
# (it sends the invite mail), so it is the one channel that reaches a human.
#
# ── Why it does not email every hour ─────────────────────────────────────────
# An alert that repeats hourly gets filtered within a day and then the real one
# is missed too. State is kept between runs so mail is sent only when the level
# CHANGES (including recovery), or once per ALERT_REPEAT_HOURS while it stays
# bad.
set -Eeuo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-job.sh"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.prod}"
VOLUME="${MEDIA_VOLUME:-task-board-prod_media_blobs}"
WARN_PCT="${DISK_WARN_PERCENT:-80}"
CRIT_PCT="${DISK_CRIT_PERCENT:-90}"
STATE_FILE="${ALERT_STATE_FILE:-/var/lib/blisswork-alerts/media-disk.state}"
REPEAT_HOURS="${ALERT_REPEAT_HOURS:-24}"
HOSTNAME_S="$(hostname)"

detect_docker_sudo
dkr() { if ((USE_SUDO)); then sudo docker "$@"; else docker "$@"; fi; }

# ── Measure ──────────────────────────────────────────────────────────────────
# Resolve the volume's real path rather than assuming /var/lib/docker: the
# daemon's data-root is configurable, and a wrong path would silently report the
# root filesystem instead of the one that actually matters.
MOUNT="$(dkr volume inspect "$VOLUME" --format '{{.Mountpoint}}' 2>/dev/null || true)"
if [ -z "$MOUNT" ]; then
  echo "volume '$VOLUME' not found — is the stack up?" >&2
  exit 1
fi

read -r FS_SIZE FS_USED FS_AVAIL FS_PCT <<<"$(
  dkr run --rm -v "$VOLUME:/v" --entrypoint sh alpine:3.20 -c \
    "df -P /v | awk 'NR==2 {gsub(/%/,\"\",\$5); print \$2, \$3, \$4, \$5}'" 2>/dev/null
)"
[ -n "${FS_PCT:-}" ] || { echo "could not read disk usage for $VOLUME" >&2; exit 1; }

# Media's own footprint — context for "is media the reason we are full, or is
# something else?". Best-effort and time-boxed: du over a large blob tree can be
# slow, and a slow answer must not delay the alert.
MEDIA_H="$(timeout 60 bash -c "$(declare -f dkr); USE_SUDO=$USE_SUDO dkr run --rm -v '$VOLUME:/v' --entrypoint sh alpine:3.20 -c 'du -sh /v 2>/dev/null | cut -f1'" 2>/dev/null || echo "unknown")"

human() { awk -v k="$1" 'BEGIN{ split("K,M,G,T",u,","); i=1; while(k>=1024 && i<4){k/=1024;i++} printf "%.1f%s", k, u[i] }'; }
AVAIL_H="$(human "$FS_AVAIL")"
SIZE_H="$(human "$FS_SIZE")"

if   [ "$FS_PCT" -ge "$CRIT_PCT" ]; then LEVEL=CRIT
elif [ "$FS_PCT" -ge "$WARN_PCT" ]; then LEVEL=WARN
else                                     LEVEL=OK
fi

echo "media disk: ${FS_PCT}% used, ${AVAIL_H} free of ${SIZE_H} (media dir: ${MEDIA_H}) -> $LEVEL"

# ── Decide whether to speak ──────────────────────────────────────────────────
# The canonical state lives under /var/lib and is written by the systemd unit
# (root). A hand-run by an unprivileged user must still work, so fall back to a
# private state file rather than dying after having done all the useful work —
# it just means a manual run does not share dedup state with the timer.
if ! mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || ! touch "$STATE_FILE" 2>/dev/null; then
  STATE_FILE="${TMPDIR:-/tmp}/blisswork-media-disk.$(id -u).state"
  echo "note: no write access to the shared state file; using $STATE_FILE" >&2
fi
PREV_LEVEL=OK; PREV_AT=0
if [ -f "$STATE_FILE" ]; then
  read -r PREV_LEVEL PREV_AT < "$STATE_FILE" 2>/dev/null || true
  PREV_LEVEL="${PREV_LEVEL:-OK}"; PREV_AT="${PREV_AT:-0}"
fi
NOW="$(date +%s)"
AGE_H=$(( (NOW - PREV_AT) / 3600 ))

SEND=0; SUBJECT=""
if [ -n "${ALERT_FORCE:-}" ]; then
  SEND=1; SUBJECT="[BlissWork] media disk test — ${FS_PCT}% used on ${HOSTNAME_S}"
elif [ "$LEVEL" != "$PREV_LEVEL" ]; then
  SEND=1
  if [ "$LEVEL" = "OK" ]; then
    SUBJECT="[BlissWork] RESOLVED: media disk back to ${FS_PCT}% on ${HOSTNAME_S}"
  else
    SUBJECT="[BlissWork] ${LEVEL}: media disk ${FS_PCT}% used on ${HOSTNAME_S}"
  fi
elif [ "$LEVEL" != "OK" ] && [ "$AGE_H" -ge "$REPEAT_HOURS" ]; then
  SEND=1
  SUBJECT="[BlissWork] ${LEVEL} (still): media disk ${FS_PCT}% used on ${HOSTNAME_S}"
fi

if [ "$SEND" -eq 1 ]; then
  BODY="Filesystem backing the chat-media volume is ${FS_PCT}% full.

  host        : ${HOSTNAME_S}
  volume      : ${VOLUME}
  mountpoint  : ${MOUNT}
  capacity    : ${SIZE_H}
  free        : ${AVAIL_H}
  media dir   : ${MEDIA_H}
  thresholds  : warn ${WARN_PCT}%, critical ${CRIT_PCT}%

This filesystem also holds Postgres, so filling it takes the whole stack down,
not just uploads.

If media is the cause:
  sudo systemctl start blisswork-gc-attachments   # reap uncommitted uploads
  docker system prune -f                          # reclaim old images/layers

Backups are separate (see scripts/backup-db.sh); pruning media does not touch
them."
  if SMTP_HOST="$(envval "$ENV_FILE" SMTP_HOST)" \
     SMTP_PORT="$(envval "$ENV_FILE" SMTP_PORT)" \
     SMTP_USERNAME="$(envval "$ENV_FILE" SMTP_USERNAME)" \
     SMTP_PASSWORD="$(envval "$ENV_FILE" SMTP_PASSWORD)" \
     SMTP_FROM="$(envval "$ENV_FILE" SMTP_FROM)" \
     ALERT_TO="${ALERT_EMAIL_TO:-$(envval "$ENV_FILE" SMTP_FROM)}" \
     SUBJECT="$SUBJECT" BODY="$BODY" python3 "$REPO_DIR/scripts/send-alert.py"; then
    echo "$LEVEL $NOW" > "$STATE_FILE"
    echo "alert sent: $SUBJECT"
  else
    # Do NOT record the state: a send that failed must be retried next run
    # rather than suppressed as "already told them".
    echo "ALERT DELIVERY FAILED — level $LEVEL not recorded, will retry next run" >&2
    exit 1
  fi
else
  # Keep the level current so a later transition is detected correctly, but
  # preserve the original alert timestamp so the repeat window is measured from
  # when we last actually spoke.
  echo "$LEVEL $PREV_AT" > "$STATE_FILE"
fi

# Only a genuine emergency fails the unit, so `systemctl --failed` stays a list
# of things that need hands rather than a list of warnings.
[ "$LEVEL" = "CRIT" ] && exit 1
exit 0
