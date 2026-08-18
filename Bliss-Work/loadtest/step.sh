#!/usr/bin/env bash
# Step through arrival rates and record the throughput/latency curve.
#
# The knee in that curve is the capacity number. A single ramp cannot give it:
# its aggregate p99 blends every rate it passed through.
#
# ── Safety ───────────────────────────────────────────────────────────────────
# This box also runs a LIVE PRODUCTION STACK. Before every step it checks that
# no `*-prod-*` container has left `(healthy)` and that the 1-minute load average
# is under ABORT_LOAD; if either fails it stops rather than continuing to push.
# Never point this at the production ports.
set -uo pipefail

cd "$(dirname "$0")"

# One of these is required. LT_USERS is the one to use: rate limits are keyed on
# the verified USER, so a single LT_EMAIL caps the whole curve at ~10 rps of 429s
# and measures the limiter rather than the system (see provision.sh).
USERS_FILE="${LT_USERS:-}"
EMAIL="${LT_EMAIL:-}"
CHANNEL="${LT_CHANNEL:-}"
if [ -z "$USERS_FILE" ] && [ -z "$EMAIL" ]; then
  echo "set LT_USERS=users.json (preferred) or LT_EMAIL" >&2
  exit 1
fi
if [ -n "$USERS_FILE" ] && [ ! -r "$USERS_FILE" ]; then
  echo "LT_USERS=$USERS_FILE is not readable" >&2
  exit 1
fi
RATES="${RATES:-50 100 200 400 800}"
HOLD="${HOLD:-25s}"
ABORT_LOAD="${ABORT_LOAD:-14}"
OUT="${OUT:-results}"

mkdir -p "$OUT"

prod_unhealthy() {
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null \
    | grep -- '-prod-' | grep -c 'unhealthy' || true
}

load1() { awk '{print $1}' /proc/loadavg; }

# p90/p95, not p99: k6's --summary-export emits only avg/min/med/max/p(90)/p(95),
# so a p99 column here is structurally always 0.00 — which reads as "the tail is
# perfect" at exactly the rates where the tail is what breaks.
printf "%-8s %-10s %-10s %-10s %-10s %-8s\n" RPS achieved p50 p90 p95 fail%
printf "%s\n" "----------------------------------------------------------------------"

for rate in $RATES; do
  bad=$(prod_unhealthy)
  if [ "${bad:-0}" -gt 0 ]; then
    echo "ABORT: $bad production container(s) unhealthy before ${rate} rps" >&2
    exit 1
  fi
  l=$(load1)
  if awk -v l="$l" -v m="$ABORT_LOAD" 'BEGIN{exit !(l>m)}'; then
    echo "ABORT: load average ${l} exceeds ${ABORT_LOAD} before ${rate} rps" >&2
    exit 1
  fi

  json="$OUT/rate-${rate}.json"
  # The pool has to be MOUNTED as well as named: LT_USERS is a path the k6
  # script `open()`s from inside the container, so exporting it on the host
  # without the bind mount leaves blisswork.js falling back to LT_EMAIL.
  sudo -n docker run --rm --network host \
    -v "$PWD/k6:/scripts:ro" -v "$PWD/$OUT:/out" \
    ${USERS_FILE:+-v "$PWD/$USERS_FILE:/users.json:ro"} \
    ${USERS_FILE:+-e LT_USERS=/users.json} \
    ${EMAIL:+-e LT_EMAIL="$EMAIL"} -e LT_CHANNEL="$CHANNEL" \
    ${SKIP_TASK:+-e SKIP_TASK="$SKIP_TASK"} \
    -e CONST_RPS="$rate" -e HOLD="$HOLD" \
    grafana/k6:latest run --quiet --summary-export="/out/rate-${rate}.json" \
    /scripts/blisswork.js >"$OUT/rate-${rate}.log" 2>&1

  # k6 writes the summary as the container user; $OUT has to be writable by it
  # or the run succeeds and silently exports nothing. Keep the full k6 output so
  # a failed step is diagnosable instead of just absent.
  if [ ! -s "$json" ]; then
    echo "step ${rate}: no summary written — see $OUT/rate-${rate}.log" >&2
    continue
  fi

  python3 - "$json" "$rate" "$HOLD" <<'PY'
import json, sys, re
path, rate, hold = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
m = d.get("metrics", {})
dur = m.get("http_req_duration", {})
secs = float(re.sub(r"[^0-9.]", "", hold) or 1)
reqs = m.get("http_reqs", {}).get("count", 0)
failrate = m.get("http_req_failed", {}).get("value", 0) * 100
print("%-8s %-10.1f %-10.2f %-10.2f %-10.2f %-8.2f" % (
    rate, reqs / secs, dur.get("med", 0), dur.get("p(90)", 0),
    dur.get("p(95)", 0), failrate))
PY
done

echo
echo "raw summaries in $OUT/"
