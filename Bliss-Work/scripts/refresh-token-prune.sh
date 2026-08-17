#!/usr/bin/env bash
# Delete refresh-token rows past their expiry.
#
#   bash scripts/refresh-token-prune.sh                     # prune
#   PRUNE_DRY_RUN=1 bash scripts/refresh-token-prune.sh     # report, delete nothing
#
# ── Why this runs HOURLY and not nightly ─────────────────────────────────────
# Every other maintenance job here is nightly, because the data they clear
# accumulates with USE. This one accumulates with EXISTENCE: refresh_tokens
# gains a row every time an access token expires, for every logged-in session,
# whether or not anyone touched the product. Rotation inserts a new row and
# revokes the old one, and until this job existed nothing ever deleted either.
#
# Nightly would mean the table carrying the login path spends most of every day
# at its largest. Hourly keeps it flat, and each run is small enough to be
# uninteresting.
#
# ── Why it deletes on EXPIRY and not on "revoked" ────────────────────────────
# A revoked row is evidence, not litter. Rotation revokes a token when it is
# exchanged; if that same token turns up again, finding the revoked row is what
# identifies the replay and tears down the whole family. That is the theft
# detection. Deleting revoked rows early would make an identical replay look
# like an unknown token — still refused, but no longer recognised as theft, so
# the rest of the attacker's stolen family keeps working.
#
# Past expires_at the replay is refused on expiry grounds regardless, so the row
# has nothing left to prove. The job deletes on that line and nothing looser.
#
# ── Ordering ─────────────────────────────────────────────────────────────────
# :17 past the hour, which keeps it clear of every nightly job's start. It
# deletes in bounded batches with a commit between them, so it competes with
# live login traffic for milliseconds at a time rather than holding a long
# transaction on the table /auth/refresh depends on.
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
  echo "auth-svc is not running — cannot prune refresh tokens" >&2
  exit 1
fi

args=()
[ -n "${PRUNE_DRY_RUN:-}" ] && args=(--dry-run)

# Captured and re-emitted so the output lands in THIS unit's journal — the snap
# Docker CLI re-parents into its own transient scope. See gc-attachments.sh.
set +e
output="$(compose exec -T auth-svc python -m app.jobs.prune_refresh_tokens "${args[@]}" 2>&1)"
status=$?
set -e

[ -n "$output" ] && printf '%s\n' "$output"
exit "$status"
