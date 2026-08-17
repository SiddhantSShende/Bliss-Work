#!/usr/bin/env bash
# Mint access tokens for the account pool, in parallel.
#
# Done outside k6 on purpose. Logging in 500 accounts inside setup() costs ~50s
# of Argon2 sequentially, which would dominate a short run and count against the
# test duration. Minting here takes a couple of seconds and the WS test just
# reads the file.
#
# Tokens expire in 900s, so re-run this immediately before a run and keep runs
# comfortably under 15 minutes.
set -uo pipefail

AUTH="${AUTH_BASE:-http://127.0.0.1:8001}"
ORIGIN="${ORIGIN:-http://localhost:5173}"
PASSWORD="${LT_PASSWORD:-LoadTest12345!}"
USERS="${1:-users-ws.json}"
OUT="${2:-tokens.json}"

tmp=$(mktemp -d)
python3 -c "import json,sys;[print(e) for e in json.load(open('$USERS'))]" > "$tmp/emails"
total=$(wc -l < "$tmp/emails")
echo "minting ${total} tokens ..." >&2

nl -ba "$tmp/emails" | xargs -P 20 -n 2 sh -c '
  i="$0"; email="$1"
  tok=$(curl -s -X POST "'"$AUTH"'/auth/login" \
    -H "Content-Type: application/json" -H "Origin: '"$ORIGIN"'" \
    -H "X-Forwarded-For: 198.51.$((i / 250)).$((i % 250 + 1))" \
    -d "{\"email\":\"${email}\",\"password\":\"'"$PASSWORD"'\"}" \
    | sed -n "s/.*\"accessToken\":\"\([^\"]*\)\".*/\1/p")
  [ -n "$tok" ] && echo "$tok" >> "'"$tmp"'/tokens"
' 2>/dev/null

python3 - "$tmp/tokens" "$OUT" <<'PY'
import json, sys
toks = [l.strip() for l in open(sys.argv[1]) if l.strip()]
json.dump(toks, open(sys.argv[2], "w"))
print(f"wrote {len(toks)} tokens to {sys.argv[2]}")
PY
rm -rf "$tmp"
