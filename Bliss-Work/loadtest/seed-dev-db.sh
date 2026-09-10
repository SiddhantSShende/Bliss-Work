#!/usr/bin/env bash
# Guarded wrapper for seed.sql + seed2.sql — see those files for exactly what
# they insert.
#
# Both are copy-paste-executable raw SQL with no idea what database they are
# about to run against, unlike every other mutating script in scripts/
# (wipe-dev-db.sh, purge-orgs.sh, backup-db.sh, restore-db.sh), which all
# hardcode their target compose project explicitly. Neither is destructive —
# they mostly INSERT — but running them against prod would seed thousands of
# fake seed-ch-*/"Seed User *" rows with no undo, so this wrapper applies the
# same container-identity check the destructive scripts already use.
#
#   bash loadtest/seed-dev-db.sh
set -Eeuo pipefail

CONTAINER="task-board-postgres-1"
# docker-compose.yml's `name:` — deliberately NOT task-board-prod
# (docker-compose.prod.yml's `name:`). This script must never be able to
# target the prod project even if someone renames/relocates the dev one.
EXPECTED_PROJECT="task-board"

# Docker may need sudo depending on the invoking user's groups. Detect
# rather than assume — same pattern as wipe-dev-db.sh/restore-test.sh.
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
echo "Seeding (seed.sql)..."
$DOCKER exec -i "$CONTAINER" psql -U taskboard -d messagingdb -v ON_ERROR_STOP=1 -f - < "$SCRIPT_DIR/seed.sql"
echo "Seeding (seed2.sql)..."
$DOCKER exec -i "$CONTAINER" psql -U taskboard -d messagingdb -v ON_ERROR_STOP=1 -f - < "$SCRIPT_DIR/seed2.sql"
echo "done."
