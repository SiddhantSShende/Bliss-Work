#!/usr/bin/env bash
#
# docker-user-allowlist.sh — shared implementation behind db-allowlist.sh and
# nats-gateway-allowlist.sh.
#
# Both scripts solve the exact same problem for a different host-published
# Docker port: a published port bypasses ufw entirely (Docker's DNAT and
# FORWARD rules are evaluated BEFORE ufw's chains — see harden-host.sh's
# "Docker vs ufw" note), so the only place a user-supplied rule lands ahead
# of Docker's ACCEPT is the DOCKER-USER chain. This file holds that
# security-critical logic ONCE — root check, external-interface
# auto-detection, CIDR validation, building the iptables block, the
# iptables-restore pre-flight, splicing into /etc/ufw/after.rules, the ufw
# reload with rollback-on-failure, and the live-chain verification — so a fix
# to one (e.g. a rollback edge case) can't silently miss the other.
#
# ── WHY THERE IS ONLY EVER ONE MANAGED BLOCK, NOT ONE PER CALLER ────────────
#
# `iptables-restore` flushes a chain the moment it is (re-)declared via
# `:DOCKER-USER - [0:0]` — that is true even with `--noflush`, which only
# skips flushing chains NOT mentioned in the input. If db-allowlist.sh and
# nats-gateway-allowlist.sh each spliced in their own self-contained
# `*filter ... :DOCKER-USER - [0:0] ... COMMIT` section, /etc/ufw/after.rules
# would end up with TWO such sections, and on the next `ufw reload` (or
# reboot) the second one processed would flush the chain and silently wipe
# out whichever rules the first section had just installed — leaving that
# port's traffic to fall through to Docker's own ACCEPT, unprotected, with
# no error from either script.
#
# So instead: every caller registers its (port, allowed IPs, explanatory
# comment) in a small per-caller state file under `${DOCKER_USER_ALLOWLIST_REGISTRY:-
# /etc/blisswork-docker-user-allowlist.d}`, and `install_docker_user_allowlist`
# always regenerates ONE combined block — one `:DOCKER-USER - [0:0]`
# declaration, then every registered caller's RETURN/DROP rules in a
# deterministic (alphabetical-by-caller) order, one `COMMIT` — from the FULL
# set of registered entries, not just the caller that happens to be running.
# Running either script updates its own entry and rewrites the whole shared
# block from every entry on disk, so the other script's port stays protected
# no matter which one ran most recently.
#
# Not meant to be run directly: source it, then call require_root and
# install_docker_user_allowlist. See db-allowlist.sh / nats-gateway-allowlist.sh
# for the calling convention.
#
set -euo pipefail

# require_root <usage_hint>
#
# usage_hint is appended verbatim after "sudo bash $0" in the error message,
# e.g. " <peer-ip-or-cidr>" (with its own leading space) or "" for none.
require_root() {
  local usage_hint="${1:-}"
  if [[ "${EUID}" -ne 0 ]]; then
    echo "ERROR: run as root:  sudo bash $0${usage_hint}" >&2
    exit 1
  fi
}

# The one shared managed region in /etc/ufw/after.rules. Every registered
# caller's rules live inside this single block — see the header comment
# above for why callers no longer get their own begin/end marks.
_DUL_BEGIN_MARK="# BEGIN BLISSWORK-DOCKER-USER-ALLOWLIST (managed by infra/host/lib/docker-user-allowlist.sh — do not hand-edit; re-run the *-allowlist.sh script that owns the entry you want to change)"
_DUL_END_MARK="# END BLISSWORK-DOCKER-USER-ALLOWLIST"

# install_docker_user_allowlist <log_prefix> <port> <block_comment> \
#     <service_label> <missing_guidance> <allow_ip>...
#
#   log_prefix        tag used in the "[log_prefix] message" banner lines,
#                      AND as this caller's registry entry filename — must be
#                      stable and unique per caller (db-allowlist,
#                      nats-gateway-allowlist, ...).
#   port              TCP port to gate
#   block_comment     multi-line explanatory comment written into the
#                      generated iptables block above this caller's rules
#                      (already "# "-prefixed)
#   service_label     short name used in the documentation-only
#                      `ufw allow ... comment` (the fixed
#                      "(actually enforced in DOCKER-USER)" suffix is added
#                      here)
#   missing_guidance  extra remediation lines appended to stderr if the
#                      live-chain verification fails after reload; pass ""
#                      for none
#   allow_ip...       one or more source IPs/CIDRs to allow
#
# Honors the same EXT_IF and AFTER_RULES environment-variable overrides the
# original two scripts did, plus DOCKER_USER_ALLOWLIST_REGISTRY (mainly for
# tests) to relocate the registry directory.
install_docker_user_allowlist() {
  local log_prefix="$1" port="$2" block_comment="$3" service_label="$4" missing_guidance="$5"
  shift 5
  local -a allow=("$@")

  local after_rules="${AFTER_RULES:-/etc/ufw/after.rules}"
  local registry_dir="${DOCKER_USER_ALLOWLIST_REGISTRY:-/etc/blisswork-docker-user-allowlist.d}"

  _dul_log() { printf '\n\033[1;36m[%s]\033[0m %s\n' "${log_prefix}" "$*"; }

  # The public NIC, derived from the default route. Override with EXT_IF= if
  # the box ever grows a second uplink.
  local ext_if="${EXT_IF:-$(ip -4 route show default | awk '/default/ {print $5; exit}')}"
  if [[ -z "${ext_if}" ]]; then
    echo "ERROR: could not determine the external interface; set EXT_IF=<iface>." >&2
    exit 1
  fi
  if ! ip link show "${ext_if}" >/dev/null 2>&1; then
    echo "ERROR: interface '${ext_if}' does not exist." >&2
    exit 1
  fi

  # Reject anything that isn't a bare IPv4 address or CIDR before it reaches
  # iptables-restore — a typo there fails the WHOLE ufw reload, not just this rule.
  local src
  for src in "${allow[@]}"; do
    if ! [[ "${src}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
      echo "ERROR: '${src}' is not a valid IPv4 address or CIDR (e.g. 203.0.113.7/32)." >&2
      exit 1
    fi
  done

  if [[ ! -f "${after_rules}" ]]; then
    echo "ERROR: ${after_rules} not found — is ufw installed? Run harden-host.sh first." >&2
    exit 1
  fi

  _dul_log "Allowing ${port}/tcp on ${ext_if} from: ${allow[*]}"

  # ── 1. Register this caller's entry ─────────────────────────────────────
  # Persisted so the block built in step 2 can include every OTHER caller's
  # rules too, not just this one — see the file header for why that matters.
  install -d -m 0750 -o root -g root "${registry_dir}"
  local entry_file="${registry_dir}/${log_prefix}.state"
  {
    printf '# Auto-generated by %s via install_docker_user_allowlist — do not hand-edit.\n' "${log_prefix}"
    printf 'PORT=%q\n' "${port}"
    printf 'SERVICE_LABEL=%q\n' "${service_label}"
    printf 'BLOCK_COMMENT=%q\n' "${block_comment}"
    printf 'ALLOW=('
    for src in "${allow[@]}"; do
      printf '%q ' "${src}"
    done
    printf ')\n'
  } >"${entry_file}.tmp"
  mv -f "${entry_file}.tmp" "${entry_file}"
  chmod 0640 "${entry_file}"

  # ── 2. Build the ONE combined block from EVERY registered entry ─────────
  # A SECOND *filter section appended after ufw's own COMMIT. iptables-restore
  # processes table blocks in sequence, so this commits after ufw's ruleset
  # and lands in DOCKER-USER without disturbing ufw's chains.
  local block regfile
  block="$(
    printf '%s\n' "${_DUL_BEGIN_MARK}"
    printf '%s\n' "*filter"
    printf '%s\n' ":DOCKER-USER - [0:0]"
    for regfile in "${registry_dir}"/*.state; do
      [[ -e "${regfile}" ]] || continue
      local PORT SERVICE_LABEL BLOCK_COMMENT
      local -a ALLOW=()
      # shellcheck disable=SC1090
      source "${regfile}"
      printf '%s\n' "${BLOCK_COMMENT}"
      local a
      for a in "${ALLOW[@]}"; do
        printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -s %s -j RETURN\n' \
          "${ext_if}" "${PORT}" "${a}"
      done
      printf -- '-A DOCKER-USER -i %s -p tcp --dport %s -j DROP\n' "${ext_if}" "${PORT}"
    done
    printf '%s\n' "COMMIT"
    printf '%s\n' "${_DUL_END_MARK}"
  )"

  # ── 3. Pre-flight: prove the block parses BEFORE ufw reload touches anything ─
  # `ufw reload` resets and re-applies the ENTIRE ruleset. If our block is
  # malformed, iptables-restore aborts partway and can leave the firewall in a
  # half-applied state — on a box administered over SSH, that is a lockout risk.
  # --test parses and validates without committing; --noflush so the partial
  # *filter section is treated as an addition, not a replacement.
  _dul_log "Validating the ruleset with iptables-restore --test"
  if ! grep -v '^#' <<<"${block}" | iptables-restore --test --noflush; then
    echo "ERROR: the generated rules are not valid; ${after_rules} left untouched." >&2
    echo "--- generated block ---" >&2
    echo "${block}" >&2
    exit 1
  fi

  # ── 4. Splice it into after.rules (replace-or-append, never duplicate) ───
  local backup="${after_rules}.blisswork-$(date +%Y%m%d%H%M%S).bak"
  cp -a "${after_rules}" "${backup}"
  _dul_log "Backed up ${after_rules} → ${backup}"

  # Intentionally NOT `local`: the EXIT trap below fires at the calling
  # script's exit, after this function has returned, and still needs to see
  # this value to clean up the temp file.
  tmp="$(mktemp)"
  trap 'rm -f "${tmp}"' EXIT
  # Strip any previous managed block, then append the new one.
  awk -v b="${_DUL_BEGIN_MARK}" -v e="${_DUL_END_MARK}" '
    $0 == b { skip = 1 }
    !skip   { print }
    $0 == e { skip = 0 }
  ' "${after_rules}" >"${tmp}"
  printf '\n%s\n' "${block}" >>"${tmp}"
  install -m 0640 -o root -g root "${tmp}" "${after_rules}"

  # ── 5. Reload ufw so the block is actually loaded ────────────────────────
  _dul_log "Reloading ufw"
  if ! ufw reload; then
    echo "ERROR: 'ufw reload' failed — restoring ${after_rules} from backup." >&2
    cp -a "${backup}" "${after_rules}"
    ufw reload || true
    exit 1
  fi

  # A documentation-only rule so `ufw status` tells the truth about what is
  # reachable. It is NOT what enforces the allowlist (Docker's DNAT bypasses
  # ufw); the DOCKER-USER rules above are.
  for src in "${allow[@]}"; do
    ufw allow from "${src}" to any port "${port}" proto tcp \
      comment "${service_label} (actually enforced in DOCKER-USER)" >/dev/null
  done

  # ── 6. Verify the rules are live for EVERY registered caller, not just
  #      this one — the whole point of the shared-block design is that one
  #      caller's reload must never silently cost another caller its rules,
  #      so confirm that guarantee actually held on every run. ────────────
  local live
  live="$(iptables -S DOCKER-USER 2>/dev/null || true)"
  local missing=0
  for regfile in "${registry_dir}"/*.state; do
    [[ -e "${regfile}" ]] || continue
    local PORT SERVICE_LABEL BLOCK_COMMENT
    local -a ALLOW=()
    # shellcheck disable=SC1090
    source "${regfile}"
    local a entry_name
    entry_name="$(basename "${regfile}" .state)"
    for a in "${ALLOW[@]}"; do
      grep -qF -- "-i ${ext_if} -p tcp -m tcp --dport ${PORT} -s ${a}" <<<"${live}" \
        || grep -qF -- "-s ${a} -i ${ext_if} -p tcp -m tcp --dport ${PORT} -j RETURN" <<<"${live}" \
        || { missing=1; echo "       missing RETURN rule for '${entry_name}' (${SERVICE_LABEL}) src ${a}" >&2; }
    done
    grep -q -- "--dport ${PORT} -j DROP" <<<"${live}" \
      || { missing=1; echo "       missing DROP rule for '${entry_name}' (${SERVICE_LABEL}) port ${PORT}" >&2; }
  done

  if [[ "${missing}" -ne 0 ]]; then
    echo "ERROR: DOCKER-USER does not contain the expected rules after reload." >&2
    echo "       One or more ports above may be UNPROTECTED. Live chain:" >&2
    echo "${live}" >&2
    if [[ -n "${missing_guidance}" ]]; then
      printf '%s\n' "${missing_guidance}" >&2
    fi
    exit 1
  fi

  _dul_log "Done. Live DOCKER-USER chain:"
  iptables -S DOCKER-USER
}
