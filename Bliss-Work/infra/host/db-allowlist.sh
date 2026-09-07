#!/usr/bin/env bash
#
# db-allowlist.sh — restrict the host-published Postgres port (5432) to a
# source-IP allowlist.
#
# WHY THIS EXISTS: docker-compose.prod.yml publishes postgres as
# `0.0.0.0:5432:5432` so you can point psql / DBeaver / pgAdmin at the box
# instead of shelling into the container. A published Docker port is NOT
# filtered by ufw — Docker's DNAT and its FORWARD rules are evaluated BEFORE
# ufw's chains (see harden-host.sh's "Docker vs ufw" note), so
# `ufw default deny incoming` does nothing for it. Without this script, that
# ports: line puts the production database on the public internet with only the
# scram-sha-256 password in front of it.
#
# The one place a user-supplied rule DOES land ahead of Docker's ACCEPT is the
# DOCKER-USER chain, which is exactly what this installs:
#
#   -A DOCKER-USER -i <ext-if> -p tcp --dport 5432 -s <allowed> -j RETURN
#   -A DOCKER-USER -i <ext-if> -p tcp --dport 5432            -j DROP
#
# ── THREE DETAILS THAT MAKE THIS CORRECT RATHER THAN SUBTLY BROKEN ──────────
#
#  1. `-i <ext-if>` IS MANDATORY. Container→container traffic crosses the SAME
#     FORWARD/DOCKER-USER path: every app service reaches the DB as
#     `postgres:5432` over the taskboard bridge. An unscoped DROP on dport 5432
#     therefore takes the WHOLE STACK off its database. Scoping to the public
#     NIC leaves bridge traffic untouched.
#  2. Scoped by INTERFACE, not by bridge name. The taskboard bridge is some
#     `br-<hash>` that changes every time the compose network is recreated; the
#     public NIC name does not.
#  3. DROP, not REJECT — a scanner gets a timeout rather than a "closed" signal.
#
# Host-local access is unaffected: `psql` on this box to 127.0.0.1:5432 never
# traverses FORWARD, so the allowlist does not apply to it.
#
# PERSISTENCE: the rules are written into /etc/ufw/after.rules, so they are
# re-applied on `ufw reload` and at boot. NOTE that the `:DOCKER-USER - [0:0]`
# line FLUSHES that chain on each reload — this script and
# nats-gateway-allowlist.sh share ONE combined block for exactly that reason
# (see lib/docker-user-allowlist.sh's header): if each installed its own
# separate block, whichever reloaded last would flush the chain and silently
# wipe the other's rule. Any future DOCKER-USER rules must go through
# install_docker_user_allowlist, never a bare `iptables -I`.
#
# Usage:
#   sudo bash infra/host/db-allowlist.sh                     # default allowlist
#   sudo bash infra/host/db-allowlist.sh 203.0.113.7/32      # ISP rotated your IP
#   sudo bash infra/host/db-allowlist.sh 203.0.113.7/32 198.51.100.0/24
#   sudo EXT_IF=eth0 DB_PORT=5432 bash infra/host/db-allowlist.sh
#
# Re-running is idempotent: the managed block is replaced, never duplicated.
#
# The DOCKER-USER installation itself (root check, interface auto-detection,
# CIDR validation, iptables-restore pre-flight, after.rules splice, ufw
# reload with rollback, live-chain verification) is shared with
# nats-gateway-allowlist.sh — see lib/docker-user-allowlist.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/docker-user-allowlist.sh
source "${SCRIPT_DIR}/lib/docker-user-allowlist.sh"

require_root

DB_PORT="${DB_PORT:-5432}"

# Allowed sources: CLI args win, else the default below. Keep this default in
# sync with docs/OPERATIONS.md §7.
DEFAULT_ALLOW=("183.82.156.92/32")
if [[ $# -gt 0 ]]; then
  ALLOW=("$@")
else
  ALLOW=("${DEFAULT_ALLOW[@]}")
fi

BLOCK_COMMENT="$(cat <<'EOF'
# Postgres is host-published by docker-compose.prod.yml; ufw cannot filter a
# published Docker port, so the gate lives here in DOCKER-USER. Edit via the
# script, not by hand — a 'ufw reload' rewrites this block from it.
EOF
)"

MISSING_GUIDANCE="$(cat <<'EOF'
       Remove the 'ports:' mapping from docker-compose.prod.yml and
       recreate postgres until this is resolved.
EOF
)"

install_docker_user_allowlist \
  "db-allowlist" \
  "${DB_PORT}" \
  "${BLOCK_COMMENT}" \
  "Postgres" \
  "${MISSING_GUIDANCE}" \
  "${ALLOW[@]}"

cat <<NOTE

Verify from OFF the box (Docker's chain is only in play for forwarded traffic):
  from an ALLOWED host:      nc -vz -w 5 <this-host> ${DB_PORT}   # connects
  from anywhere else:        nc -vz -w 5 <this-host> ${DB_PORT}   # TIMES OUT

If 'systemctl restart docker' ever empties DOCKER-USER, 'sudo ufw reload'
re-applies this block.
NOTE
