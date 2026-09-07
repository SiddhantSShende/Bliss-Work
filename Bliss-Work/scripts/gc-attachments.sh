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

source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-job.sh"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE
cd "$REPO_DIR"

detect_docker_sudo
# GC_DRY_RUN/GC_BATCH_SIZE must also survive `sudo docker compose`, same as
# COMPOSE_FILE — see compose() in lib/compose-job.sh.
COMPOSE_SUDO_ENV_VARS="GC_DRY_RUN GC_BATCH_SIZE"

# Fail loudly if the service is down. A silent no-op here would let expired rows
# pile up for weeks while the timer reported success every night.
if ! compose ps --status running --services 2>/dev/null | grep -qx messaging-svc; then
  echo "messaging-svc is not running — cannot reap attachments" >&2
  exit 1
fi

# -T: no TTY under systemd. The binary reads its configuration from the
# container's own environment; only the GC_* knobs are passed through.
#
# Output capture/re-emit: see run_and_capture_for_journald() in
# lib/compose-job.sh — the snap Docker CLI re-parents into its own transient
# scope, so output inherited straight through would land in the wrong
# journal unit ("Started"/"Finished" only, none of the reaper's own lines),
# which is exactly the output you want when a nightly reap misbehaves.
run_and_capture_for_journald compose exec -T \
  -e GC_DRY_RUN="${GC_DRY_RUN:-}" \
  -e GC_BATCH_SIZE="${GC_BATCH_SIZE:-}" \
  messaging-svc /app/gc-attachments
exit $?
