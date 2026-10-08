#!/usr/bin/env bash
# Real end-to-end: the REAL messaging-svc binary + REAL Postgres (RLS enforcing) +
# the REAL doc-converter container, driven over HTTP exactly as the app does
# (upload → mint link → GET /media/{id}/preview). Nothing in the path is faked.
#
#   FIXTURE_DIR=… LARGE_FIXTURE_DIR=… services/doc-converter/tests/e2e/run.sh
#
# Scratch only: everything lives under $WORK, containers are named bw-e2e-*, ports are
# high, and the dev and prod stacks are untouched. See the repo's recipe notes:
# JWKS BEFORE the service, ledger pre-filled, non-superuser role, no pkill -f.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"          # Bliss-Work/
WORK="${WORK:-/home/ubuntu/scratch/e2e-run}"
DOCKER="${DOCKER:-sudo -n docker}"
GO="${GO:-/usr/local/go/bin/go}"
export FIXTURE_DIR="${FIXTURE_DIR:-/home/ubuntu/scratch/fx}"
export LARGE_FIXTURE_DIR="${LARGE_FIXTURE_DIR:-/home/ubuntu/scratch/fxl}"
PGPORT=55441; MSGPORT=58004; JWKSPORT=59801; CONVPORT=19020
# The harness origin must equal WEB_ORIGIN below, or the browser's CORS check refuses the fetches.
export HARNESS_PORT="${HARNESS_PORT:-5197}"
export MSG="http://127.0.0.1:$MSGPORT" JWKS_PORT=$JWKSPORT WORK
export MEDIA_ROOT="$WORK/media" PGCONTAINER=bw-e2e-pg CONVCONTAINER=bw-e2e-conv

cleanup() {
  [ -f "$WORK/msg.pid" ] && kill "$(cat "$WORK/msg.pid")" 2>/dev/null
  [ -f "$WORK/jwks.pid" ] && kill "$(cat "$WORK/jwks.pid")" 2>/dev/null
  [ -f "$WORK/vite.pid" ] && kill "$(cat "$WORK/vite.pid")" 2>/dev/null
  $DOCKER rm -f bw-e2e-pg bw-e2e-conv >/dev/null 2>&1
}
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK/media"; cleanup

echo "▶ Postgres (scratch, non-superuser owner)"
$DOCKER run --rm -d --name bw-e2e-pg -p 127.0.0.1:$PGPORT:5432 -e POSTGRES_PASSWORD=scratch postgres:17-alpine >/dev/null
$DOCKER exec bw-e2e-pg bash -c 'until pg_isready -q -U postgres; do sleep 0.3; done'
$DOCKER exec bw-e2e-pg psql -q -U postgres -c "CREATE ROLE messaging_user LOGIN PASSWORD 'pw' NOSUPERUSER NOBYPASSRLS" -c "CREATE DATABASE e2e OWNER messaging_user" >/dev/null
PSQL="$DOCKER exec -i bw-e2e-pg psql -q -v ON_ERROR_STOP=1 -U messaging_user -d e2e"
$PSQL -c "CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
for f in $(ls "$REPO"/services/messaging-svc/migrations/*.sql | sort); do
  $PSQL -1 -c "SELECT set_config('app.bypass_rls','on',true)" -f - < "$f" >/dev/null || { echo "migration failed: $f"; exit 1; }
  sum=$(sha256sum "$f" | cut -d' ' -f1)
  $PSQL -c "INSERT INTO schema_migrations(filename, checksum) VALUES ('$(basename "$f")', '$sum')"
done
echo "  migrated $(ls "$REPO"/services/messaging-svc/migrations/*.sql | wc -l) files"

echo "▶ Office Document Sandbox (production flags)"
$DOCKER run -d --name bw-e2e-conv --read-only --tmpfs /tmp:size=512m --cap-drop ALL --pids-limit 256 \
  --memory 1280m --cpus 2 -p 127.0.0.1:$CONVPORT:9000 -e CONVERT_CONCURRENCY=2 doc-converter:dev >/dev/null

echo "▶ JWKS, then messaging-svc (real binary)"
node "$HERE/jwks.mjs" > "$WORK/jwks.log" 2>&1 & echo $! > "$WORK/jwks.pid"
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$JWKSPORT/jwks.json" >/dev/null && break; sleep 0.2; done
( cd "$REPO/services/messaging-svc" && $GO build -o "$WORK/messaging" ./cmd/server ) || exit 1
MESSAGING_PORT=$MSGPORT \
MESSAGING_DATABASE_URL="postgres://messaging_user:pw@127.0.0.1:$PGPORT/e2e?sslmode=disable" \
JWKS_URL="http://127.0.0.1:$JWKSPORT/jwks.json" JWT_ISSUER=task-board KAFKA_BROKERS=127.0.0.1:1 \
MEDIA_ROOT="$MEDIA_ROOT" MEDIA_URL_SECRET="e2e-secret-0123456789-0123456789-0123456789" \
WEB_ORIGIN="http://localhost:$HARNESS_PORT" CONVERTER_URL="http://127.0.0.1:$CONVPORT" \
PREVIEW_WAIT_SECONDS=${PREVIEW_WAIT_SECONDS:-5} \
  "$WORK/messaging" > "$WORK/msg.log" 2>&1 & echo $! > "$WORK/msg.pid"
for i in $(seq 1 100); do curl -sf "$MSG/readyz" >/dev/null && break; sleep 0.3; done
curl -sf "$MSG/readyz" >/dev/null || { echo "messaging-svc never became ready"; tail -20 "$WORK/msg.log"; exit 1; }

if [ "${BROWSER:-0}" = "1" ]; then
  # The REAL AttachmentViewer in a scratch Vite harness (scratch copy of packages/app, synced first),
  # on the origin the server's CORS allows (WEB_ORIGIN above).
  HARNESS_DIR="${HARNESS_DIR:-/home/ubuntu/scratch/bw}"
  echo "▶ Viewer harness (Vite dev server, scratch copy)"
  mkdir -p "$HARNESS_DIR/harness" && cp "$HERE"/harness/index.html "$HERE"/harness/main.tsx "$HERE"/harness/vite.config.mjs "$HARNESS_DIR/harness/"
  ( cd "$HARNESS_DIR" && HARNESS_PORT=$HARNESS_PORT node_modules/.bin/vite --config harness/vite.config.mjs ) > "$WORK/vite.log" 2>&1 & echo $! > "$WORK/vite.pid"
  for i in $(seq 1 60); do curl -sf http://localhost:$HARNESS_PORT/ >/dev/null && break; sleep 0.5; done
fi

echo "▶ Driving it"
node "$HERE/e2e.mjs"
rc=$?
echo "▶ messaging-svc preview log lines:"; grep -c '"preview"\|msg=preview' "$WORK/msg.log" | sed 's/^/  /'
exit $rc
