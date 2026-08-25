#!/usr/bin/env bash
#
# Render a region's cross-region NATS config with its secrets filled in.
#
# ── Why this exists ─────────────────────────────────────────────────────────
# infra/nats/region-a.conf and region-b.conf are IN THE REPO and must stay
# secret-free to be reviewable. Two things in them cannot be nats-server $VAR
# references, though, and have to come from here instead:
#
#   1. The cluster route password. nats-server's own $VAR substitution only
#      replaces a token that IS the variable — a variable concatenated with
#      literal text in the same token (`user:$VAR@host`, which is exactly what
#      a credentialed route URL needs) is silently left un-substituted. Proven
#      the hard way: with the password left to nats-server's $VAR, three nodes
#      produced a connect/reject loop of thousands of "authentication error"
#      log lines per second, because nats-server's `authorization{}` block is
#      ALSO not consulted for explicitly-listed routes in the first place —
#      only routes discovered implicitly use it to decide what to present. The
#      block still matters (it is what a node checks incoming connections
#      against), but the URL form is what makes THIS node's own outbound
#      dials carry credentials at all.
#   2. The gateway URL to a real peer, for the same reason plus a second one:
#      it is genuinely unknown infrastructure until a peer exists, so it comes
#      from the environment rather than being edited into a tracked file.
#
# Same reasoning as EGRESS_CONFIG_BODY in docker-compose.recording.yml and
# scripts/render-livekit-recording-config.sh's Redis password — the tracked
# file stays reviewable, the secret only ever exists on the deployment host.
#
# Usage (from the repo's Bliss-Work directory):
#   set -a; . ./.env; . ./.env.prod; set +a
#   bash scripts/render-nats-conf.sh region-a
#
# With no real peer yet, leave PEER_REGION_GATEWAY_URL unset — it defaults to
# an address that will never resolve, which is the correct, safe state (the
# gateway retries a DNS lookup forever rather than doing anything).
set -euo pipefail

REGION="${1:?usage: scripts/render-nats-conf.sh <region-id>   e.g. region-a}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/infra/nats/${REGION}.conf"
out="$here/infra/nats/${REGION}.rendered.conf"

[[ -f "$src" ]] || { echo "render-nats-conf: no such file: $src" >&2; exit 1; }

# Fail closed. A missing password would render a config nats-server either
# refuses to start (a route URL missing the password segment entirely is a
# parse error) or, worse, one where the auth block silently disagrees with the
# route URLs — which is exactly the class of mistake this script exists to
# take out of anyone's hands.
missing=()
for var in NATS_CLUSTER_PASSWORD NATS_GATEWAY_PASSWORD; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} )); then
  echo "render-nats-conf: missing ${missing[*]}" >&2
  echo "  source BOTH env files first: set -a; . ./.env; . ./.env.prod; set +a" >&2
  exit 1
fi

# Bare host:port, e.g. "region-b.example.com:7222" — NOT a full nats:// URL and
# NOT a scheme+credentials, both of which this script supplies. Defaults to a
# hostname that will never resolve, which is the deliberately safe state for a
# region with no peer yet (see docs/CROSS-REGION.md §11, "remote region
# unavailable" — a DNS failure that retries forever, not a crash).
PEER_REGION_GATEWAY_URL="${PEER_REGION_GATEWAY_URL:-unconfigured-peer:7222}"
if [[ "$PEER_REGION_GATEWAY_URL" == *"://"* ]]; then
  echo "render-nats-conf: PEER_REGION_GATEWAY_URL should be host:port only (got '$PEER_REGION_GATEWAY_URL')" >&2
  echo "  this script adds the nats:// scheme and the gateway credentials itself." >&2
  exit 1
fi

# A password containing '&', '@' or similar would corrupt more than one match
# if it landed in sed's replacement text unescaped. Only alnum + a conservative
# punctuation set is accepted — reject rather than silently mis-render.
for var in NATS_CLUSTER_PASSWORD NATS_GATEWAY_PASSWORD; do
  val="${!var}"
  if [[ "$val" =~ [^A-Za-z0-9._~+/=-] ]]; then
    echo "render-nats-conf: $var contains a character unsafe in a NATS URL userinfo segment." >&2
    echo "  stick to openssl rand -base64 32 (alnum, +, /, =) and this is a non-issue." >&2
    exit 1
  fi
done

umask 077   # the output holds two passwords; never world-readable
sed \
  -e "s|__NATS_CLUSTER_PASSWORD__|${NATS_CLUSTER_PASSWORD}|g" \
  -e "s|__NATS_GATEWAY_PASSWORD__|${NATS_GATEWAY_PASSWORD}|g" \
  -e "s|__PEER_REGION_GATEWAY_URL__|nats://nats-gateway:${NATS_GATEWAY_PASSWORD}@${PEER_REGION_GATEWAY_URL}|g" \
  "$src" > "$out"

# Prove every placeholder actually got replaced — a typo'd placeholder name in
# either this script or the source file would otherwise ship a config with the
# literal string "__NATS_CLUSTER_PASSWORD__" as nats-server's route password,
# which fails at CONNECT time on every node, not at render time here.
if grep -q '__[A-Z_]*__' "$out"; then
  echo "render-nats-conf: unreplaced placeholder(s) remain in $out:" >&2
  grep -n '__[A-Z_]*__' "$out" >&2
  rm -f "$out"
  exit 1
fi

echo "wrote $out ($(wc -l < "$out") lines, mode $(stat -c %a "$out"))"
