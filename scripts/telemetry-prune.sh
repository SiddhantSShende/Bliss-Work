#!/usr/bin/env bash
# Drop raw activity partitions past the retention window. Rollups are kept.
#
#   bash scripts/telemetry-prune.sh                     # prune
#   PRUNE_DRY_RUN=1 bash scripts/telemetry-prune.sh     # report, delete nothing
#
# ── Ordering ─────────────────────────────────────────────────────────────────
# 04:30, deliberately AFTER the 02:30 backup and after the 04:00 attachment GC.
# The backup ordering is the point: this job DELETES data, so the most recent
# dump predates it. If it ever removed something it shouldn't, there is a dump
# from before it ran rather than one taken afterwards that faithfully records
# the loss.
#
# ── The safety property ──────────────────────────────────────────────────────
# The job REFUSES to drop a day whose aggregates were never computed, and exits
# non-zero so the unit goes red. Rollups are the only thing that survives the
# prune, so dropping an unrolled day destroys it permanently and silently — and
# a swallowed failure here is indistinguishable from a healthy system right up
# until someone asks for a report covering the month we quietly deleted.
#
# If this fires, run the rollup for the named day first:
#   ROLLUP_DAY=YYYY-MM-DD bash scripts/telemetry-rollup.sh
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

if ! compose ps --status running --services 2>/dev/null | grep -qx telemetry-svc; then
  echo "telemetry-svc is not running — cannot prune activity" >&2
  exit 1
fi

args=()
[ -n "${PRUNE_DRY_RUN:-}" ] && args=(--dry-run)

# Captured and re-emitted so the output lands in THIS unit's journal — the snap
# Docker CLI re-parents into its own transient scope. See gc-attachments.sh.
set +e
output="$(compose exec -T telemetry-svc python -m app.jobs.prune "${args[@]}" 2>&1)"
status=$?
set -e

[ -n "$output" ] && printf '%s\n' "$output"
exit "$status"
