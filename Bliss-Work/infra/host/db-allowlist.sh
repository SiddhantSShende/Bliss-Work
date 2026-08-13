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
# line FLUSHES that chain on each reload — harmless today (nothing else uses
# it), but any future DOCKER-USER rules must be added to the managed block
# below rather than with a bare `iptables -I`.
#
# Usage:
#   sudo bash infra/host/db-allowlist.sh                     # default allowlist
#   sudo bash infra/host/db-allowlist.sh 203.0.113.7/32      # ISP rotated your IP
#   sudo bash infra/host/db-allowlist.sh 203.0.113.7/32 198.51.100.0/24
#   sudo EXT_IF=eth0 DB_PORT=5432 bash infra/host/db-allowlist.sh
#
# Re-running is idempotent: the managed block is replaced, never duplicated.
#
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root:  sudo bash $0" >&2
  exit 1
fi

log() { printf '\n\033[1;36m[db-allowlist]\033[0m %s\n' "$*"; }

DB_PORT="${DB_PORT:-5432}"
AFTER_RULES="${AFTER_RULES:-/etc/ufw/after.rules}"
BEGIN_MARK="# BEGIN BLISSWORK-DB-ALLOWLIST (managed by infra/host/db-allowlist.sh)"
END_MARK="# END BLISSWORK-DB-ALLOWLIST"

# Allowed sources: CLI args win, else the default below. Keep this default in
# sync with docs/OPERATIONS.md §7.
DEFAULT_ALLOW=("183.82.156.92/32")
if [[ $# -gt 0 ]]; then
  ALLOW=("$@")
else
  ALLOW=("${DEFAULT_ALLOW[@]}")
fi

# The public NIC, derived from the default route (ens3 on this host). Override
# with EXT_IF= if the box ever grows a second uplink.
EXT_IF="${EXT_IF:-$(ip -4 route show default | awk '/default/ {print $5; exit}')}"
if [[ -z "${EXT_IF}" ]]; then
  echo "ERROR: could not determine the external interface; set EXT_IF=<iface>." >&2
  exit 1
fi
if ! ip link show "${EXT_IF}" >/dev/null 2>&1; then
  echo "ERROR: interface '${EXT_IF}' does not exist." >&2
  exit 1
fi

# Reject anything that isn't a bare IPv4 address or CIDR before it reaches
# iptables-restore — a typo there fails the WHOLE ufw reload, not just this rule.
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

log "Allowing ${DB_PORT}/tcp on ${EXT_IF} from: ${ALLOW[*]}"

# ── 1. Build the managed block ──────────────────────────────────────────────
# A SECOND *filter section appended after ufw's own COMMIT. iptables-restore
# processes table blocks in sequence, so this commits after ufw's ruleset and
# lands in DOCKER-USER without disturbing ufw's chains.
block="$(
  printf '%s\n' "${BEGIN_MARK}"
  printf '%s\n' "# Postgres is host-published by docker-compose.prod.yml; ufw cannot filter a"
  printf '%s\n' "# published Docker port, so the gate lives here in DOCKER-USER. Edit via the"
  printf '%s\n' "# script, not by hand — a 'ufw reload' rewrites this block from it."
  printf '%s\n' "*filter"
  printf '%s\n' ":DOCKER-USER - [0:0]"
  for src in "${ALLOW[@]}"; do
    printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -s %s -j RETURN\n' \
      "${EXT_IF}" "${DB_PORT}" "${src}"
  done
  printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -j DROP\n' "${EXT_IF}" "${DB_PORT}"
  printf '%s\n' "COMMIT"
  printf '%s\n' "${END_MARK}"
)"

# ── 2. Pre-flight: prove the block parses BEFORE ufw reload touches anything ─
# `ufw reload` resets and re-applies the ENTIRE ruleset. If our block is
# malformed, iptables-restore aborts partway and can leave the firewall in a
# half-applied state — on a box administered over SSH, that is a lockout risk.
# --test parses and validates without committing; --noflush so the partial
# *filter section is treated as an addition, not a replacement.
log "Validating the ruleset with iptables-restore --test"
if ! grep -v '^#' <<<"${block}" | iptables-restore --test --noflush; then
  echo "ERROR: the generated rules are not valid; ${AFTER_RULES} left untouched." >&2
  echo "--- generated block ---" >&2
  echo "${block}" >&2
  exit 1
fi

# ── 3. Splice it into after.rules (replace-or-append, never duplicate) ───────
backup="${AFTER_RULES}.blisswork-$(date +%Y%m%d%H%M%S).bak"
cp -a "${AFTER_RULES}" "${backup}"
log "Backed up ${AFTER_RULES} → ${backup}"

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
# Strip any previous managed block, then append the new one.
awk -v b="${BEGIN_MARK}" -v e="${END_MARK}" '
  $0 == b { skip = 1 }
  !skip   { print }
  $0 == e { skip = 0 }
' "${AFTER_RULES}" > "${tmp}"
printf '\n%s\n' "${block}" >> "${tmp}"
install -m 0640 -o root -g root "${tmp}" "${AFTER_RULES}"

# ── 4. Reload ufw so the block is actually loaded ───────────────────────────
log "Reloading ufw"
if ! ufw reload; then
  echo "ERROR: 'ufw reload' failed — restoring ${AFTER_RULES} from backup." >&2
  cp -a "${backup}" "${AFTER_RULES}"
  ufw reload || true
  exit 1
fi

# A documentation-only rule so `ufw status` tells the truth about what is
# reachable. It is NOT what enforces the allowlist (Docker's DNAT bypasses ufw);
# the DOCKER-USER rules above are.
for src in "${ALLOW[@]}"; do
  ufw allow from "${src}" to any port "${DB_PORT}" proto tcp \
    comment 'Postgres (actually enforced in DOCKER-USER)' >/dev/null
done

# ── 5. Verify the rules are live, and fail loudly if they are not ───────────
# Getting this wrong means an open database, so do not trust the reload
# silently: read the live chain back.
live="$(iptables -S DOCKER-USER 2>/dev/null || true)"
missing=0
for src in "${ALLOW[@]}"; do
  grep -qF -- "-i ${EXT_IF} -p tcp -m tcp --dport ${DB_PORT} -s ${src}" <<<"${live}" \
    || grep -qF -- "-s ${src} -i ${EXT_IF} -p tcp -m tcp --dport ${DB_PORT} -j RETURN" <<<"${live}" \
    || missing=1
done
grep -q -- "--dport ${DB_PORT} -j DROP" <<<"${live}" || missing=1

if [[ "${missing}" -ne 0 ]]; then
  echo "ERROR: DOCKER-USER does not contain the expected rules after reload." >&2
  echo "       Port ${DB_PORT} may be UNPROTECTED. Live chain:" >&2
  echo "${live}" >&2
  echo "       Remove the 'ports:' mapping from docker-compose.prod.yml and" >&2
  echo "       recreate postgres until this is resolved." >&2
  exit 1
fi

log "Done. Live DOCKER-USER chain:"
iptables -S DOCKER-USER
cat <<NOTE

Verify from OFF the box (Docker's chain is only in play for forwarded traffic):
  from an ALLOWED host:      nc -vz -w 5 <this-host> ${DB_PORT}   # connects
  from anywhere else:        nc -vz -w 5 <this-host> ${DB_PORT}   # TIMES OUT

If 'systemctl restart docker' ever empties DOCKER-USER, 'sudo ufw reload'
re-applies this block.
NOTE
