#!/usr/bin/env bash
# Block until the whole stack is ready: every service /healthz is 200, all Kafka
# topics exist. Used by `make up` before seeding/demo so first events aren't lost.
set -uo pipefail

AUTH=${AUTH_URL:-http://localhost:8001}
TASK=${TASK_URL:-http://localhost:8002}
NOTIF=${NOTIF_URL:-http://localhost:8003}
MSG=${MSG_URL:-http://localhost:8004}
WS=${WS_URL:-http://localhost:8090}
MAILPIT=${MAILPIT_URL:-http://localhost:8025}

wait_http() {
  local name="$1" url="$2"
  printf "waiting for %-16s %s " "$name" "$url"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "OK"; return 0; fi
    printf "."; sleep 2
  done
  echo " TIMEOUT"; return 1
}

rc=0
wait_http "auth-svc"        "$AUTH/healthz"        || rc=1
wait_http "task-svc"        "$TASK/healthz"        || rc=1
wait_http "notification"    "$NOTIF/healthz"       || rc=1
wait_http "messaging-svc"   "$MSG/healthz"         || rc=1
wait_http "ws-gateway"      "$WS/healthz"          || rc=1
wait_http "mailpit"         "$MAILPIT/readyz"      || rc=1

if [ "$rc" -ne 0 ]; then
  echo "Some services failed to become healthy. Check 'docker compose logs'." >&2
  exit 1
fi
echo "All services healthy."
