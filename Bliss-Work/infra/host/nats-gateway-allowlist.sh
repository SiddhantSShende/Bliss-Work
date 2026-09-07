#!/usr/bin/env bash
#
# nats-gateway-allowlist.sh — restrict the host-published NATS gateway port
# (7222) to a source-IP allowlist: the peer region's address, and nothing else.
#
# WHY THIS EXISTS: docker-compose.crossregion.yml deliberately does NOT publish
# any port by default — see that file's header. The moment a real peer region
# exists and its gateway needs to reach THIS host, port 7222 has to be
# published, and a published Docker port is NOT filtered by ufw — Docker's DNAT
# and its FORWARD rules are evaluated BEFORE ufw's chains (see
# harden-host.sh's "Docker vs ufw" note), so `ufw default deny incoming` does
# nothing for it. Same trap as scripts/db-allowlist.sh solves for Postgres;
# this is the identical fix for the gateway port.
#
# TLS + auth (infra/nats/region-a.conf's gateway.tls / gateway.authorization)
# are the actual authentication for anyone who reaches the port. This script
# is defense in depth on TOP of that, not instead of it — the two are
# independent controls, and skipping either one leaves the other doing all the
# work alone.
#
# The one place a user-supplied rule DOES land ahead of Docker's ACCEPT is the
# DOCKER-USER chain, which is exactly what this installs:
#
#   -A DOCKER-USER -i <ext-if> -p tcp --dport 7222 -s <peer-ip> -j RETURN
#   -A DOCKER-USER -i <ext-if> -p tcp --dport 7222                -j DROP
#
# ── THREE DETAILS THAT MAKE THIS CORRECT RATHER THAN SUBTLY BROKEN ──────────
#
#  1. `-i <ext-if>` IS MANDATORY. Container→container traffic crosses the SAME
#     FORWARD/DOCKER-USER path: nats-a-1's own gateway dial to a SIBLING node
#     never touches 7222 over the public NIC (siblings talk over cluster
#     routes, 6222, not the gateway). An unscoped DROP on dport 7222 would
#     still be safe for THIS stack, but scoping to the public NIC is the same
#     discipline as db-allowlist.sh and costs nothing.
#  2. Scoped by INTERFACE, not by bridge name. The taskboard bridge is some
#     `br-<hash>` that changes every time the compose network is recreated;
#     the public NIC name does not.
#  3. DROP, not REJECT — a scanner gets a timeout rather than a "closed"
#     signal.
#
# PERSISTENCE: the rules are written into /etc/ufw/after.rules, so they are
# re-applied on `ufw reload` and at boot. This script and db-allowlist.sh
# share ONE combined DOCKER-USER block rather than one each — see
# lib/docker-user-allowlist.sh's header for why (a second `:DOCKER-USER - [0:0]`
# declaration would flush the chain and silently wipe the other script's rule).
#
# Usage:
#   sudo bash infra/host/nats-gateway-allowlist.sh <peer-ip-or-cidr>
#   sudo bash infra/host/nats-gateway-allowlist.sh 203.0.113.7/32
#   sudo bash infra/host/nats-gateway-allowlist.sh 203.0.113.7/32 198.51.100.8/32
#   sudo EXT_IF=eth0 GATEWAY_PORT=7222 bash infra/host/nats-gateway-allowlist.sh 203.0.113.7/32
#
# Unlike db-allowlist.sh there is deliberately NO default allowlist: a
# cross-region gateway peer is not known at checkout time the way an operator's
# own admin IP might be, and guessing wrong here means silently leaving the
# port open to nobody useful while looking configured. The peer IP is required.
#
# Re-running is idempotent: the managed block is replaced, never duplicated.
#
# The DOCKER-USER installation itself (root check, interface auto-detection,
# CIDR validation, iptables-restore pre-flight, after.rules splice, ufw
# reload with rollback, live-chain verification) is shared with
# db-allowlist.sh — see lib/docker-user-allowlist.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-user-allowlist.sh
source "${SCRIPT_DIR}/lib/docker-user-allowlist.sh"

require_root " <peer-ip-or-cidr>"

GATEWAY_PORT="${GATEWAY_PORT:-7222}"

if [[ $# -eq 0 ]]; then
  echo "ERROR: no peer IP/CIDR given. Unlike db-allowlist.sh, this has no default —" >&2
  echo "       a wrong guess here silently leaves the gateway port open to nobody" >&2
  echo "       useful while looking configured." >&2
  echo "  usage: sudo bash $0 <peer-ip-or-cidr> [<more-ips>...]" >&2
  exit 1
fi
ALLOW=("$@")

BLOCK_COMMENT="$(cat <<'EOF'
# The NATS cross-region gateway is host-published only once a real peer
# region exists (docker-compose.crossregion.yml has no ports: by default).
# ufw cannot filter a published Docker port, so the gate lives here in
# DOCKER-USER. Edit via the script, not by hand — a 'ufw reload' rewrites
# this block from it.
EOF
)"

install_docker_user_allowlist \
  "nats-gateway-allowlist" \
  "${GATEWAY_PORT}" \
  "${BLOCK_COMMENT}" \
  "NATS cross-region gateway" \
  "" \
  "${ALLOW[@]}"

cat <<NOTE

Now add the port publish itself — it is NOT in docker-compose.crossregion.yml
by default (see that file's header). Either a small third overlay
(-p "${GATEWAY_PORT}:${GATEWAY_PORT}" on whichever nats-a-N node the peer
dials) or a documented one-line edit at deploy time. Do this AFTER the
allowlist above is live, never before.

Verify from OFF the box (Docker's chain is only in play for forwarded traffic):
  from the peer:             nc -vz -w 5 <this-host> ${GATEWAY_PORT}   # connects
  from anywhere else:        nc -vz -w 5 <this-host> ${GATEWAY_PORT}   # TIMES OUT

If 'systemctl restart docker' ever empties DOCKER-USER, 'sudo ufw reload'
re-applies this block.
NOTE
