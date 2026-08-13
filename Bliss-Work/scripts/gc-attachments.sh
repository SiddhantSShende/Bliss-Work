#!/usr/bin/env bash
# Reclaim disk from chat attachments that were uploaded but never sent.
#
#   bash scripts/gc-attachments.sh              # reap
#   GC_DRY_RUN=1 bash scripts/gc-attachments.sh # report only, delete nothing
#
# ── Why this has to exist ────────────────────────────────────────────────────
# A message references its attachments by ids embedded in the message BODY, and
# bodies are encrypted at rest (messages.body_enc). The server therefore cannot
# read a message to learn what it points at, and so can NEVER answer "is this
# blob still reachable?" by inspection.
#
# So uploads are expiring by default: an attachment row is written with
# expires_at = now() + MEDIA_UPLOAD_TTL and only made permanent when the client
# commits it after the message is accepted. A user who attaches a 90 MB video
# and then closes the tab leaves a row that lapses — and without this job, a
# blob that nothing will ever reference again.
#
# The binary ships inside the messaging-svc image (/app/gc-attachments). Running
# it via `compose exec` rather than a one-shot container is deliberate: it
# inherits the service's own env (DB URL, MEDIA_ROOT, the at-rest crypto
# settings) and the same media volume mount, so there is no second copy of that
# configuration to drift.
#
# Deleting a row is not enough on its own — blobs are content-addressed and can
# be shared by several attachments in the same org — so the reaper only unlinks
# a file once no surviving row in that org still points at it. That check lives
# in the store's reaper query, not here.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE
cd "$REPO_DIR"

if docker info >/dev/null 2>&1; then
  USE_SUDO=0
elif sudo -n docker info >/dev/null 2>&1; then
  USE_SUDO=1
else
  echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
  exit 1
fi

# COMPOSE_FILE must reach compose, and SUDO SANITIZES THE ENVIRONMENT — an
# exported COMPOSE_FILE does not survive `sudo docker compose`, which then falls
# back to the DEV docker-compose.yml whose services are not running here. The
# failure reads "service messaging-svc is not running", pointing at the service
# rather than at the missing variable. Same trap as backup-db.sh and the
# IMAGE_TAG one documented in deploy-prod.sh.
compose() {
  if (( USE_SUDO )); then
    sudo env COMPOSE_FILE="$COMPOSE_FILE" GC_DRY_RUN="${GC_DRY_RUN:-}" \
        GC_BATCH_SIZE="${GC_BATCH_SIZE:-}" docker compose "$@"
  else
    docker compose "$@"
  fi
}

# Fail loudly if the service is down. A silent no-op here would let expired rows
# pile up for weeks while the timer reported success every night.
if ! compose ps --status running --services 2>/dev/null | grep -qx messaging-svc; then
  echo "messaging-svc is not running — cannot reap attachments" >&2
  exit 1
fi

# -T: no TTY under systemd. The binary reads its configuration from the
# container's own environment; only the GC_* knobs are passed through.
#
# The output is CAPTURED and re-emitted from this shell rather than inherited
# straight through. The snap Docker CLI re-parents itself into its own transient
# scope (snap.docker.docker-<uuid>.scope), so anything it writes is attributed to
# THAT unit in the journal — `journalctl -u blisswork-gc-attachments.service`
# would show only "Started" and "Finished" and none of the reaper's own log
# lines, which is exactly the output you want when a nightly reap misbehaves.
# Echoing from bash puts the writer back in the service's cgroup.
#
# Cost: the output arrives at the end rather than streaming. This job prints two
# lines and finishes in milliseconds, so that trade is free.
set +e
output="$(compose exec -T \
  -e GC_DRY_RUN="${GC_DRY_RUN:-}" \
  -e GC_BATCH_SIZE="${GC_BATCH_SIZE:-}" \
  messaging-svc /app/gc-attachments 2>&1)"
status=$?
set -e

[ -n "$output" ] && printf '%s\n' "$output"
exit "$status"
