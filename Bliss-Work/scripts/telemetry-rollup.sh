#!/usr/bin/env bash
# Roll yesterday's raw activity into the daily aggregates that outlive it.
#
#   bash scripts/telemetry-rollup.sh                    # yesterday
#   ROLLUP_DAY=2026-07-14 bash scripts/telemetry-rollup.sh
#   ROLLUP_FROM=2026-07-01 ROLLUP_TO=2026-07-31 bash scripts/telemetry-rollup.sh
#
# ── Why this has to exist ────────────────────────────────────────────────────
# Raw activity events are kept for 90 days and then dropped. These rollups are
# NOT — they are the only reason a chart can still show last winter after the
# events behind it are gone. If this job stops running, the prune notices and
# refuses to delete anything (see telemetry-prune.sh), so the failure mode is a
# growing database rather than a silently missing year of history.
#
# Scheduled at 01:30, BEFORE the 02:30 backup, so each night's dump contains the
# day's aggregates rather than trailing them by 24 hours.
#
# Runs INSIDE telemetry-svc via `compose exec` rather than as a one-shot
# container: it inherits the service's own DB URL and at-rest crypto settings, so
# there is no second copy of that configuration to drift out of sync. Same
# reasoning as gc-attachments.sh.
#
# Idempotent — every write is an upsert keyed on (org, user, day), so re-running
# a day produces the same rows rather than doubled ones.
set -Eeuo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-job.sh"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE
cd "$REPO_DIR"

detect_docker_sudo

if ! compose ps --status running --services 2>/dev/null | grep -qx telemetry-svc; then
  echo "telemetry-svc is not running — cannot roll up activity" >&2
  exit 1
fi

args=()
if [ -n "${ROLLUP_FROM:-}" ] && [ -n "${ROLLUP_TO:-}" ]; then
  args=(--from="$ROLLUP_FROM" --to="$ROLLUP_TO")
else
  args=(--day="${ROLLUP_DAY:-yesterday}")
fi

# Output is CAPTURED and re-emitted from this shell — see
# run_and_capture_for_journald() in lib/compose-job.sh. The snap Docker CLI
# re-parents into its own transient scope, so anything it writes would
# otherwise land in THAT unit's journal — `journalctl -u
# blisswork-telemetry-rollup.service` would show only "Started" and
# "Finished" and none of the job's own lines.
run_and_capture_for_journald compose exec -T telemetry-svc python -m app.jobs.rollup "${args[@]}"
exit $?
