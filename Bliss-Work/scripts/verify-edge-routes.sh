#!/usr/bin/env bash
# Does the DEPLOYED task-svc have the routes the client calls?
#
# A browser console full of 404s on /api/tasks/api/v1/tasks/<x> is almost never the URL: Caddy
# strips /api/tasks and the client's /api/v1/... reaches task-svc intact (that is what
# services/task-svc/tests/test_client_route_contract.py proves from source). It is a task-svc
# image OLDER than the client. This probes the live edge to tell the two apart without a token.
#
#   ./scripts/verify-edge-routes.sh https://app.example.com
#   ./scripts/verify-edge-routes.sh https://app.example.com --resolve app.example.com:443:127.0.0.1
#
# task-svc authenticates per route, so an unauthenticated request answers 401 where the route
# EXISTS and 404 {"detail":"Not Found"} where it does not. Exit 1 if any route the client needs
# is missing.
#
# notification-svc cannot be probed this way: it authenticates before routing, so every path
# under /api/v1 answers 401. Compare its image build date with its source instead:
#   docker inspect <container> --format '{{.Created}}'
#   git log -1 --format=%cd -- services/notification-svc
set -Eeuo pipefail

base="${1:?usage: $0 https://host [curl args, e.g. --resolve host:443:127.0.0.1]}"
shift || true
base="${base%/}"
uuid="018f0000-0000-7000-8000-0000000000a1"

# method path — a control that has existed for a long time first, then the newer ones.
routes=(
  "GET  /api/v1/tasks/availability"
  "GET  /api/v1/tasks/schedules"
  "POST /api/v1/tasks/${uuid}/reassign"
  "POST /api/v1/tasks/${uuid}/assignees"
)

missing=0
for r in "${routes[@]}"; do
  read -r method path <<<"$r"
  body=()
  [ "$method" = "POST" ] && body=(-H 'Content-Type: application/json' -d '{}')
  code=$(curl -sk -o /dev/null -w '%{http_code}' -X "$method" "${body[@]}" "$@" "${base}/api/tasks${path}" || true)
  if [ "$code" = "404" ]; then
    printf 'MISSING  %-5s %s  (404: this task-svc build has no such route)\n' "$method" "$path"
    missing=1
  else
    printf 'ok       %-5s %s  (%s: route exists)\n' "$method" "$path" "$code"
  fi
done
exit "$missing"
