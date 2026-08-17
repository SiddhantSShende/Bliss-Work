#!/usr/bin/env bash
# Provision a pool of load-test accounts on a DEV stack.
#
# ── Why a pool at all ────────────────────────────────────────────────────────
# Rate limits here are keyed on the VERIFIED USER, not just the source address:
# messaging-svc allows 600 reads/min per user, task-svc 600/min, auth-svc
# 120/min. A load test driven by one account therefore measures the rate
# limiter, not the application — it flatlines around 10 rps and reports 429s
# that have nothing to do with capacity.
#
# One account per ~10 rps of intended load is the rule of thumb.
#
# ── Why the X-Forwarded-For header is varied ─────────────────────────────────
# Org creation is capped at 5/60s per IP, which would make provisioning 30
# accounts a six-minute wait. Varying XFF gives each request its own bucket.
#
# That this WORKS is itself a finding, recorded in the load-test README: both
# services resolve the caller address from the last X-Forwarded-For entry, and
# on a directly-reachable port the client controls that value entirely. It is
# safe in production only because Caddy appends the real address last. Do not
# rely on this trick against anything but a dev stack you own.
set -uo pipefail

AUTH="${AUTH_BASE:-http://127.0.0.1:8001}"
ORIGIN="${ORIGIN:-http://localhost:5173}"
COUNT="${COUNT:-30}"
PASSWORD="${LT_PASSWORD:-LoadTest12345!}"
OUT="${OUT:-users.json}"

stamp=$(date +%s)
tmp=$(mktemp -d)

echo "provisioning ${COUNT} accounts against ${AUTH} ..." >&2

seq 1 "$COUNT" | xargs -P 10 -I{} sh -c '
  i="{}"
  email="lt'"$stamp"'-${i}@example.com"
  body=$(printf "{\"orgName\":\"LT%s-%s\",\"email\":\"%s\",\"password\":\"%s\",\"displayName\":\"LT %s\"}" \
    "'"$stamp"'" "$i" "$email" "'"$PASSWORD"'" "$i")
  code=$(curl -s -o "'"$tmp"'/${i}.json" -w "%{http_code}" -X POST "'"$AUTH"'/auth/orgs" \
    -H "Content-Type: application/json" -H "Origin: '"$ORIGIN"'" \
    -H "X-Forwarded-For: 198.51.100.${i}" -d "$body")
  if [ "$code" = "201" ]; then echo "$email" >> "'"$tmp"'/emails"; fi
' 2>/dev/null

n=$(wc -l < "$tmp/emails" 2>/dev/null || echo 0)
python3 - "$tmp/emails" "$OUT" <<'PY'
import json, sys
emails = [l.strip() for l in open(sys.argv[1]) if l.strip()]
json.dump(emails, open(sys.argv[2], "w"), indent=1)
print(f"wrote {len(emails)} accounts to {sys.argv[2]}")
PY

rm -rf "$tmp"
echo "provisioned ${n}/${COUNT}" >&2
