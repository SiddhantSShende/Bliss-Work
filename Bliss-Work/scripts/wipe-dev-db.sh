#!/usr/bin/env bash
# Guarded wrapper for wipe.sql — see that file for exactly what it deletes.
#
# wipe.sql itself is destructive, unconfirmed, copy-paste-executable raw SQL
# with no idea what database it's about to run against. Every OTHER
# destructive script in this repo (purge-orgs.sh, backup-db.sh,
# restore-db.sh) hardcodes its target compose project explicitly and
# requires deliberate opt-in; this one had neither, and pasting its old
# one-line "how to run this" from memory (or from a stale doc) on the wrong
# host would run it against whatever Postgres that host happens to have.
#
# This wrapper is the guard: it refuses without explicit confirmation, and
# it refuses again unless the target container genuinely belongs to the DEV
# compose project — never anything that could be production.
#
#   WIPE_CONFIRM=I-understand-this-deletes-data bash scripts/wipe-dev-db.sh
#
# THERE IS NO UNDO. This keeps two hardcoded dev accounts and deletes every
# other chat, task, notification, conversation, and inbox row in the target
# database.
set -Eeuo pipefail

CONTAINER="task-board-postgres-1"
# docker-compose.yml's `name:` — deliberately NOT task-board-prod
# (docker-compose.prod.yml's `name:`). This script must never be able to
# target the prod project even if someone renames/relocates the dev one.
EXPECTED_PROJECT="task-board"

if [ "${WIPE_CONFIRM:-}" != "I-understand-this-deletes-data" ]; then
  echo "Refusing: set WIPE_CONFIRM=I-understand-this-deletes-data to run this." >&2
  echo "This deletes every chat/task/notification/conversation/inbox row in the" >&2
  echo "target database, keeping only two hardcoded dev accounts. No undo." >&2
  exit 1
fi

# Docker may need sudo depending on the invoking user's groups. Detect
# rather than assume — same pattern as restore-test.sh.
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
  exit 1
fi

if ! $DOCKER inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "no such container: $CONTAINER" >&2
  echo "This must run against the DEV stack (docker compose up from" >&2
  echo "docker-compose.yml) — never a host that could be production." >&2
  exit 1
fi

project=$($DOCKER inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$CONTAINER")
if [ "$project" != "$EXPECTED_PROJECT" ]; then
  echo "Refusing: $CONTAINER belongs to compose project '$project', not '$EXPECTED_PROJECT'." >&2
  echo "This script is hardcoded to the dev stack only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Confirmed target: $CONTAINER (compose project '$project')."
echo "Wiping..."
$DOCKER exec -i "$CONTAINER" psql -U taskboard -v ON_ERROR_STOP=1 < "$SCRIPT_DIR/wipe.sql"
echo "done."
