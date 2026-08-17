#!/usr/bin/env bash
# Apply retention to the event-plumbing tables across every service that has one.
#
#   bash scripts/prune-event-tables.sh                     # prune
#   PRUNE_DRY_RUN=1 bash scripts/prune-event-tables.sh     # report, delete nothing
#
# ── Why this exists ──────────────────────────────────────────────────────────
# Nothing in the platform ever deleted a row from the tables that make the event
# pipeline work. A repo-wide search for `DELETE FROM outbox` returned nothing at
# all, in any of the five services that have one. So `outbox` — WITH THE FULL
# JSON PAYLOAD of every event ever produced — plus `consumed_events` and
# `idempotency_keys` grew for the life of the deployment.
#
# `idempotency_keys` is the clearest sign it was an oversight rather than a
# decision: messaging-svc's schema creates an index on `created_at` whose only
# conceivable use is a sweeper by age, and no sweeper was ever written.
#
# The failure is slow and then sudden, and it is not mainly about disk. The hot
# paths stay index probes throughout; what degrades is everything around them —
# indexes outgrowing memory, autovacuum falling behind the churn, the nightly
# pg_dump stretching, and a restore taking hours longer than BACKUPS.md claims.
#
# It also bounds a confidentiality window. `outbox.payload` holds message bodies
# as PLAINTEXT JSON while `messages.body_enc` holds the same text encrypted, so
# an unbounded outbox means the at-rest encryption does not hold for the copy
# that outlives the original.
#
# ── What is deleted, and what is deliberately not ────────────────────────────
# Only rows nothing can still use: PUBLISHED outbox rows past the point where
# replaying them could help, dedup rows past Kafka's retention, and idempotency
# keys past the client-retry window.
#
# UNPUBLISHED and DEAD-LETTERED outbox rows are never touched. An unpublished
# row is pending work; a dead-lettered one is the only surviving copy of an
# event that failed to reach its consumers. Deleting either would be destroying
# data, not reclaiming space.
#
# ── Ordering ─────────────────────────────────────────────────────────────────
# Runs nightly at 02:05, before the backup and well before org-purge, and steps
# through the services one at a time. Each job deletes in bounded batches with a
# commit between them and a short pause after each, so it competes with live
# traffic for milliseconds rather than holding a long transaction. A service
# that is down or fails is reported and does NOT stop the others — one
# unprunable database must not leave the other four growing.
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

args=()
[ -n "${PRUNE_DRY_RUN:-}" ] && args=(--dry-run)

running="$(compose ps --status running --services 2>/dev/null || true)"

# service:command pairs. The two Go services ship a compiled binary; the three
# Python ones run a module. Same job, same retention rules, different runtime.
declare -a JOBS=(
  "messaging-svc:/app/prune-event-tables"
  "notification-svc:/app/prune-event-tables"
  "task-svc:python -m app.jobs.prune_event_tables"
  "auth-svc:python -m app.jobs.prune_event_tables"
  "integrations-svc:python -m app.jobs.prune_event_tables"
)

failures=0
for job in "${JOBS[@]}"; do
  svc="${job%%:*}"
  cmd="${job#*:}"

  if ! grep -qx "$svc" <<<"$running"; then
    echo "skip: $svc is not running"
    continue
  fi

  echo "── $svc ──"
  # Captured and re-emitted so the output lands in THIS unit's journal — the
  # snap Docker CLI re-parents into its own transient scope. See
  # gc-attachments.sh, which hit the same thing.
  set +e
  # shellcheck disable=SC2086 # cmd is a fixed literal above, word-splitting is intended
  output="$(compose exec -T "$svc" $cmd "${args[@]}" 2>&1)"
  status=$?
  set -e

  [ -n "$output" ] && printf '%s\n' "$output"
  if (( status != 0 )); then
    echo "prune failed for $svc (exit $status)" >&2
    failures=$(( failures + 1 ))
  fi
done

if (( failures > 0 )); then
  echo "$failures service(s) failed to prune; their tables are still growing" >&2
  exit 1
fi
