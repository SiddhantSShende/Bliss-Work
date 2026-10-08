#!/usr/bin/env bash
# Container-level checks for the production topology (plan §6.0).
#
#   FIXTURE_DIR=/path/to/fixtures tests/security_check.sh
#
# Needs: docker (use `sudo -n` if the plain command is denied), python3, an
# image named doc-converter:dev. Uses throwaway containers and networks only.
set -u
DOCKER=${DOCKER:-"sudo -n docker"}
FX=${FIXTURE_DIR:-/home/ubuntu/scratch/fx}
IMG=${IMAGE:-doc-converter:dev}
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

cleanup() { $DOCKER rm -f dc-sec dc-sec-oom dc-sec-peer >/dev/null 2>&1; $DOCKER network rm dc-sec-internal dc-sec-other >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
$DOCKER network create --internal dc-sec-internal >/dev/null
$DOCKER network create dc-sec-other >/dev/null

# The production flags, verbatim from docker-compose.prod.yml's doc-converter.
PROD_FLAGS="--read-only --tmpfs /tmp:size=512m --cap-drop ALL --pids-limit 256 --memory 1g --cpus 1"
$DOCKER run -d --name dc-sec $PROD_FLAGS --network dc-sec-internal $IMG >/dev/null
# A listener on a DIFFERENT network, standing in for Postgres/Kafka/anything internal.
$DOCKER run -d --name dc-sec-peer --network dc-sec-other python:3.13-slim python -m http.server 5432 >/dev/null
sleep 4
PEER_IP=$($DOCKER inspect -f '{{(index .NetworkSettings.Networks "dc-sec-other").IPAddress}}' dc-sec-peer)
EX() { $DOCKER exec dc-sec "$@"; }

echo "identity and filesystem"
check "runs as uid 10001"                 '[ "$(EX id -u)" = 10001 ]'
check "root filesystem is read-only"      '! EX sh -c "touch /app/x 2>/dev/null"'
check "cannot write /opt/profile-template" '! EX sh -c "touch /opt/profile-template/x 2>/dev/null"'
check "/tmp is writable (tmpfs)"          'EX sh -c "touch /tmp/x && rm /tmp/x"'
check "no capabilities (CapEff is zero)"  'EX sh -c "grep -q ^CapEff:.0000000000000000 /proc/self/status"'
check "no secrets in the environment"     '! EX sh -c "env | grep -i -E \"(password|secret|token|database_url|api_key|private)\""'

echo "network: none (internal network only)"
PROBE='import socket,sys
t=(sys.argv[1],int(sys.argv[2]))
s=socket.socket(); s.settimeout(3)
try: s.connect(t); print("CONNECTED"); sys.exit(0)
except Exception as e: print("blocked:",type(e).__name__); sys.exit(1)'
check "internet IP unreachable (1.1.1.1:443)"   '! EX python -c "$PROBE" 1.1.1.1 443 | grep -q CONNECTED'
check "internet IP unreachable (8.8.8.8:53)"    '! EX python -c "$PROBE" 8.8.8.8 53 | grep -q CONNECTED'
check "DNS to the outside fails"                '! EX python -c "import socket; socket.gethostbyname(\"example.com\")" 2>/dev/null'
check "other-network service unreachable ($PEER_IP:5432)" '! EX python -c "$PROBE" '"$PEER_IP"' 5432 | grep -q CONNECTED'
GW=$($DOCKER inspect -f '{{(index .NetworkSettings.Networks "dc-sec-internal").Gateway}}' dc-sec)
case "$GW" in *invalid*|"<no value>") GW="" ;; esac
check "bridge gateway/host unreachable (${GW:-none}:22)" '[ -z "$GW" ] || ! EX python -c "$PROBE" $GW 22 | grep -q CONNECTED'

echo "limits"
check "pids limit applied"   '[ "$($DOCKER inspect -f "{{.HostConfig.PidsLimit}}" dc-sec)" = 256 ]'
check "memory limit applied" '[ "$($DOCKER inspect -f "{{.HostConfig.Memory}}" dc-sec)" = 1073741824 ]'

echo "memory exhaustion fails safely and the converter survives"
$DOCKER run -d --name dc-sec-oom --read-only --tmpfs /tmp:size=512m --cap-drop ALL --pids-limit 256 --memory 96m --memory-swap 96m --network dc-sec-internal $IMG >/dev/null
sleep 3
OOMIP=$($DOCKER inspect -f '{{(index .NetworkSettings.Networks "dc-sec-internal").IPAddress}}' dc-sec-oom)
R=$($DOCKER run --rm --network dc-sec-internal -v "$FX:/fx:ro" python:3.13-slim python -c "
import urllib.request,urllib.error
d=open('/fx/fixture.pptx','rb').read()
req=urllib.request.Request('http://$OOMIP:9000/convert?kind=pptx',data=d,method='POST')
try: print(urllib.request.urlopen(req,timeout=120).status)
except urllib.error.HTTPError as e: print(e.code, e.read().decode())
except Exception as e: print('conn', type(e).__name__)
")
echo "  (96 MiB job result: $R)"
check "job under a 96 MiB cap ended with a bounded answer (200, or 422/limit) or a closed connection" 'echo "$R" | grep -q -E "^(200|422|conn)"'
sleep 2
check "converter still answers /healthz afterwards (or was restarted)" '$DOCKER exec dc-sec-oom python -c "import urllib.request;urllib.request.urlopen(\"http://127.0.0.1:9000/healthz\",timeout=3)"'

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
