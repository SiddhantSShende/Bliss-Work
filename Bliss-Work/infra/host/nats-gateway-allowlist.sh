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
# re-applied on `ufw reload` and at boot.
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
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root:  sudo bash $0 <peer-ip-or-cidr>" >&2
  exit 1
fi

log() { printf '\n\033[1;36m[nats-gateway-allowlist]\033[0m %s\n' "$*"; }

GATEWAY_PORT="${GATEWAY_PORT:-7222}"
AFTER_RULES="${AFTER_RULES:-/etc/ufw/after.rules}"
BEGIN_MARK="# BEGIN BLISSWORK-NATS-GATEWAY-ALLOWLIST (managed by infra/host/nats-gateway-allowlist.sh)"
END_MARK="# END BLISSWORK-NATS-GATEWAY-ALLOWLIST"

if [[ $# -eq 0 ]]; then
  echo "ERROR: no peer IP/CIDR given. Unlike db-allowlist.sh, this has no default —" >&2
  echo "       a wrong guess here silently leaves the gateway port open to nobody" >&2
  echo "       useful while looking configured." >&2
  echo "  usage: sudo bash $0 <peer-ip-or-cidr> [<more-ips>...]" >&2
  exit 1
fi
ALLOW=("$@")

EXT_IF="${EXT_IF:-$(ip -4 route show default | awk '/default/ {print $5; exit}')}"
if [[ -z "${EXT_IF}" ]]; then
  echo "ERROR: could not determine the external interface; set EXT_IF=<iface>." >&2
  exit 1
fi
if ! ip link show "${EXT_IF}" >/dev/null 2>&1; then
  echo "ERROR: interface '${EXT_IF}' does not exist." >&2
  exit 1
fi

for src in "${ALLOW[@]}"; do
  if ! [[ "${src}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
    echo "ERROR: '${src}' is not a valid IPv4 address or CIDR (e.g. 203.0.113.7/32)." >&2
    exit 1
  fi
done

if [[ ! -f "${AFTER_RULES}" ]]; then
  echo "ERROR: ${AFTER_RULES} not found — is ufw installed? Run harden-host.sh first." >&2
  exit 1
fi

log "Allowing ${GATEWAY_PORT}/tcp on ${EXT_IF} from: ${ALLOW[*]}"

block="$(
  printf '%s\n' "${BEGIN_MARK}"
  printf '%s\n' "# The NATS cross-region gateway is host-published only once a real peer"
  printf '%s\n' "# region exists (docker-compose.crossregion.yml has no ports: by default)."
  printf '%s\n' "# ufw cannot filter a published Docker port, so the gate lives here in"
  printf '%s\n' "# DOCKER-USER. Edit via the script, not by hand — a 'ufw reload' rewrites"
  printf '%s\n' "# this block from it."
  printf '%s\n' "*filter"
  printf '%s\n' ":DOCKER-USER - [0:0]"
  for src in "${ALLOW[@]}"; do
    printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -s %s -j RETURN\n' \
      "${EXT_IF}" "${GATEWAY_PORT}" "${src}"
  done
  printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -j DROP\n' "${EXT_IF}" "${GATEWAY_PORT}"
  printf '%s\n' "COMMIT"
  printf '%s\n' "${END_MARK}"
)"

log "Validating the ruleset with iptables-restore --test"
if ! grep -v '^#' <<<"${block}" | iptables-restore --test --noflush; then
  echo "ERROR: the generated rules are not valid; ${AFTER_RULES} left untouched." >&2
  echo "--- generated block ---" >&2
  echo "${block}" >&2
  exit 1
fi

backup="${AFTER_RULES}.blisswork-$(date +%Y%m%d%H%M%S).bak"
cp -a "${AFTER_RULES}" "${backup}"
log "Backed up ${AFTER_RULES} → ${backup}"

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
awk -v b="${BEGIN_MARK}" -v e="${END_MARK}" '
  $0 == b { skip = 1 }
  !skip   { print }
  $0 == e { skip = 0 }
' "${AFTER_RULES}" > "${tmp}"
printf '\n%s\n' "${block}" >> "${tmp}"
install -m 0640 -o root -g root "${tmp}" "${AFTER_RULES}"

log "Reloading ufw"
if ! ufw reload; then
  echo "ERROR: 'ufw reload' failed — restoring ${AFTER_RULES} from backup." >&2
  cp -a "${backup}" "${AFTER_RULES}"
  ufw reload || true
  exit 1
fi

for src in "${ALLOW[@]}"; do
  ufw allow from "${src}" to any port "${GATEWAY_PORT}" proto tcp \
    comment 'NATS cross-region gateway (actually enforced in DOCKER-USER)' >/dev/null
done

live="$(iptables -S DOCKER-USER 2>/dev/null || true)"
missing=0
for src in "${ALLOW[@]}"; do
  grep -qF -- "-i ${EXT_IF} -p tcp -m tcp --dport ${GATEWAY_PORT} -s ${src}" <<<"${live}" \
    || grep -qF -- "-s ${src} -i ${EXT_IF} -p tcp -m tcp --dport ${GATEWAY_PORT} -j RETURN" <<<"${live}" \
    || missing=1
done
grep -q -- "--dport ${GATEWAY_PORT} -j DROP" <<<"${live}" || missing=1

if [[ "${missing}" -ne 0 ]]; then
  echo "ERROR: DOCKER-USER does not contain the expected rules after reload." >&2
  echo "       Port ${GATEWAY_PORT} may be UNPROTECTED. Live chain:" >&2
  echo "${live}" >&2
  exit 1
fi

log "Done. Live DOCKER-USER chain:"
iptables -S DOCKER-USER
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
