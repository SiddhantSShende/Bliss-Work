#!/usr/bin/env bash
# Strip the raw secret URL from outbox rows once their token has expired.
#
#   bash scripts/redact-expired-secrets.sh                     # redact
#   PRUNE_DRY_RUN=1 bash scripts/redact-expired-secrets.sh     # report, redact nothing
#
# ── Why this runs every 15 minutes ───────────────────────────────────────────
# The three secret-bearing event types (password-reset / email-verify /
# invite) have their raw URL stripped before Kafka publish (the outbox
# poller), but the STORED outbox row is untouched by that step — the whole
# point of this job is to bound how long the raw secret sits there once the
# token itself is useless. Password-reset/email-verify tokens expire in
# 30-60 minutes; running every 15 minutes keeps the row's exposure window
# close to the token's own lifetime instead of the outbox's multi-day
# retention (prune_event_tables.py, which still owns when the row is deleted
# entirely — this job only redacts, never deletes).
#
# ── Ordering ─────────────────────────────────────────────────────────────────
# Independent of the nightly maintenance jobs — this is a security-hygiene
# step, not disk cleanup, so it runs on its own frequent schedule rather than
# being folded into the 02:xx nightly batch.
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

compose() {
  if (( USE_SUDO )); then
    sudo env COMPOSE_FILE="$COMPOSE_FILE" docker compose "$@"
  else
    docker compose "$@"
  fi
}

if ! compose ps --status running --services 2>/dev/null | grep -qx auth-svc; then
  echo "auth-svc is not running — cannot redact expired secrets" >&2
  exit 1
fi

args=()
[ -n "${PRUNE_DRY_RUN:-}" ] && args=(--dry-run)

# Captured and re-emitted so the output lands in THIS unit's journal — the snap
# Docker CLI re-parents into its own transient scope. See gc-attachments.sh.
set +e
output="$(compose exec -T auth-svc python -m app.jobs.redact_expired_secrets "${args[@]}" 2>&1)"
status=$?
set -e

[ -n "$output" ] && printf '%s\n' "$output"
exit "$status"
