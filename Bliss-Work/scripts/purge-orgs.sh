#!/usr/bin/env bash
# Destroy organizations whose deletion grace period has elapsed.
#
#   bash scripts/purge-orgs.sh                    # purge
#   PURGE_DRY_RUN=1 bash scripts/purge-orgs.sh    # report, delete nothing
#
# ── Ordering ─────────────────────────────────────────────────────────────────
# 05:00, deliberately LAST among the nightly jobs: after the 02:30 backup, after
# the 03:00 attachment GC, and after the 04:30 telemetry prune. The backup
# ordering is the point. This job destroys data across seven databases and a
# blob volume, so the most recent dump must predate it — if a deletion was
# requested in error and nobody cancelled it in time, there is a dump from
# before it ran rather than one taken afterwards that faithfully records the
# loss.
#
# ── What it actually does ────────────────────────────────────────────────────
# Only the auth-svc half runs here: the crypto-shred (deleting the org's
# org_keys row, which makes every encrypted column in every service unreadable
# in O(1)) and the auth-side row deletion. The other services erase themselves
# when they consume the org.deleted event this emits. That asynchrony is
# deliberate — the guarantee is the shred, which does not depend on any consumer
# being up.
#
# ── If it fails ──────────────────────────────────────────────────────────────
# Non-zero exit turns the unit red, and it should stay red until someone looks.
# A swallowed failure here is indistinguishable from "nothing was due", and the
# difference matters: one means an erasure request was honoured and the other
# means it silently was not.
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
  echo "auth-svc is not running — cannot purge organizations" >&2
  exit 1
fi

args=()
[ -n "${PURGE_DRY_RUN:-}" ] && args=(--dry-run)

# Captured and re-emitted so the output lands in THIS unit's journal — the snap
# Docker CLI re-parents into its own transient scope. See gc-attachments.sh.
set +e
output="$(compose exec -T auth-svc python -m app.jobs.purge_orgs "${args[@]}" 2>&1)"
status=$?
set -e

[ -n "$output" ] && printf '%s\n' "$output"
exit "$status"
