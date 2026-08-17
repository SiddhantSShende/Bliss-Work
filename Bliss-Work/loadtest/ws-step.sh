#!/usr/bin/env bash
# Hold N WebSockets and measure what they cost.
#
# The numbers that matter are not inside k6. A held socket issues no requests,
# so what has to be sampled is the SERVER: `ws_connections` on the gateway, the
# gateway's RSS, and Redis `used_memory`. This runs k6 in the background and
# samples those while the sockets are held, then reports the marginal cost per
# connection against the idle baseline.
#
# Why Redis matters more than the gateway: dev Redis has no maxmemory, but
# production caps it at 2gb with noeviction, and INFRASTRUCTURE.md's Stage 11
# audit found that ceiling — not CPU and not the gateway's own memory — to be
# what actually binds. Bytes-per-connection here is what turns that 2gb into a
# user count.
set -uo pipefail
cd "$(dirname "$0")"

GW="${GW:-http://127.0.0.1:8090}"
GW_CONTAINER="${GW_CONTAINER:-task-board-ws-gateway-1}"
REDIS_CONTAINER="${REDIS_CONTAINER:-task-board-redis-1}"
STEPS="${STEPS:-500 2000 5000}"
PER_VU="${PER_VU:-100}"
HOLD="${HOLD:-45}"
ABORT_LOAD="${ABORT_LOAD:-16}"

gw_conns() { curl -s --max-time 5 "$GW/metrics" 2>/dev/null | awk '/^ws_connections /{print $2}'; }
gw_rss_mb() { sudo -n docker stats --no-stream --format '{{.MemUsage}}' "$GW_CONTAINER" 2>/dev/null \
                | awk '{print $1}' | sed 's/MiB//;s/GiB/*1024/' | bc -l 2>/dev/null; }
redis_mb()  { sudo -n docker exec "$REDIS_CONTAINER" redis-cli INFO memory 2>/dev/null \
                | awk -F: '/^used_memory:/{printf "%.2f", $2/1048576}'; }
rejects()   { curl -s --max-time 5 "$GW/metrics" 2>/dev/null \
                | awk '/^ws_connections_rejected_total/{s+=$2} END{print s+0}'; }

base_rss=$(gw_rss_mb); base_redis=$(redis_mb); base_rej=$(rejects)
echo "baseline: gateway ${base_rss}MB, redis ${base_redis}MB, conns $(gw_conns), rejects ${base_rej}"
echo
printf "%-8s %-8s %-11s %-11s %-11s %-11s %-9s\n" target held gw_MB redis_MB B/conn_gw B/conn_redis rejects
printf "%s\n" "--------------------------------------------------------------------------------"

for target in $STEPS; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$l" -v m="$ABORT_LOAD" 'BEGIN{exit !(l>m)}'; then
    echo "ABORT: load ${l} over ${ABORT_LOAD}" >&2; break
  fi
  if sudo -n docker ps --format '{{.Names}}\t{{.Status}}' | grep -- '-prod-' | grep -q unhealthy; then
    echo "ABORT: a production container is unhealthy" >&2; break
  fi

  vus=$(( (target + PER_VU - 1) / PER_VU ))
  sudo -n docker run --rm --network host -v "$PWD/k6:/scripts:ro" -v "$PWD/tokens.json:/tokens.json:ro" \
    -e LT_TOKENS=/tokens.json -e VUS="$vus" -e SOCKETS_PER_VU="$PER_VU" -e HOLD_SEC="$HOLD" \
    grafana/k6:latest run --quiet /scripts/websockets.js >/dev/null 2>&1 &
  k6pid=$!

  # Let every socket finish opening (staggered at 5ms) before sampling.
  sleep $(( PER_VU / 100 + 12 ))

  peak=0; peak_rss=0; peak_redis=0
  for _ in 1 2 3; do
    c=$(gw_conns); r=$(gw_rss_mb); m=$(redis_mb)
    [ -n "${c:-}" ] && awk -v a="$c" -v b="$peak" 'BEGIN{exit !(a>b)}' && peak=$c
    [ -n "${r:-}" ] && awk -v a="$r" -v b="$peak_rss" 'BEGIN{exit !(a>b)}' && peak_rss=$r
    [ -n "${m:-}" ] && awk -v a="$m" -v b="$peak_redis" 'BEGIN{exit !(a>b)}' && peak_redis=$m
    sleep 5
  done
  rej=$(rejects)

  wait $k6pid 2>/dev/null
  sleep 8   # let the gateway reap the closed sockets before the next step

  awk -v t="$target" -v h="$peak" -v g="$peak_rss" -v m="$peak_redis" \
      -v bg="$base_rss" -v bm="$base_redis" -v rj="$rej" -v brj="$base_rej" 'BEGIN{
    bpc_g = (h>0) ? (g-bg)*1048576/h : 0;
    bpc_m = (h>0) ? (m-bm)*1048576/h : 0;
    printf "%-8s %-8s %-11.1f %-11.2f %-11.0f %-11.0f %-9s\n", t, h, g, m, bpc_g, bpc_m, rj-brj;
  }'
done
