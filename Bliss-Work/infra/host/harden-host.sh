#!/usr/bin/env bash
#
# harden-host.sh — lock down the HOST surface for the Task-Board production box.
#
# Goal: "no open ports" beyond what the app needs. On this box only three TCP
# ports should be reachable from the internet:
#
#   80/tcp, 443/tcp + 443/udp   the app (published by the Caddy container)
#   22/tcp                       SSH for administration
#
# Redis/Kafka and every application service are NOT host-published
# (docker-compose.prod.yml has no `ports:` for them) — they live only on the
# private `taskboard` bridge network, so this script does not need to touch them.
#
# POSTGRES IS THE EXCEPTION: 5432 IS host-published (for psql/GUI admin access)
# and is therefore NOT closed by anything this script does — see the Docker-vs-ufw
# note below. Its source-IP allowlist is a separate concern, installed by
# infra/host/db-allowlist.sh. Run that too; this script does not call it, so that
# the "what's open to the world" and "who may reach the DB" decisions stay
# independently reviewable.
#
# What this does (idempotent — safe to re-run):
#   1. ufw firewall: default-deny incoming, allow 22/80/443.
#   2. SSH: key-only auth (no passwords, no root login) via a drop-in.
#   3. fail2ban: ban hosts that brute-force SSH.
#
# ── IMPORTANT: Docker vs ufw ────────────────────────────────────────────────
# Docker publishes container ports (here 80/443) by inserting its own iptables
# rules in the DOCKER chain, which is consulted BEFORE ufw's chains. So ufw can
# NOT filter the Caddy-published 80/443 — and that's exactly what we want (they
# must stay public). ufw governs the host's own listeners (sshd, and anything
# you add later that is NOT a `-p` docker publish). Do not "ufw deny 80" expecting
# it to close the app — to close or restrict a published port you must either
# remove its `ports:` mapping in docker-compose.prod.yml, or filter it in the
# DOCKER-USER chain, which IS consulted before Docker's own ACCEPT. The latter is
# what infra/host/db-allowlist.sh does for postgres:5432.
#
# Usage:  sudo bash infra/host/harden-host.sh
#
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root:  sudo bash $0" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: this script targets Debian/Ubuntu (apt). Adapt for your distro." >&2
  exit 1
fi

SSH_PORT="${SSH_PORT:-22}"
log() { printf '\n\033[1;36m[harden]\033[0m %s\n' "$*"; }

# ── 1. Firewall (ufw) ────────────────────────────────────────────────────────
log "Installing + configuring ufw (default-deny incoming; allow ${SSH_PORT}/80/443)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw

ufw default deny incoming
ufw default allow outgoing
# Allow SSH FIRST so enabling ufw never drops the session running this script.
ufw allow "${SSH_PORT}/tcp" comment 'SSH admin'
ufw allow 80/tcp   comment 'HTTP (Caddy ACME + redirect)'
ufw allow 443/tcp  comment 'HTTPS (Caddy)'
ufw allow 443/udp  comment 'HTTP/3 QUIC (Caddy)'
# WebRTC TURN relay (coturn, host-networked) — required for calls to cross NAT.
# Comment these out if you are NOT running the coturn service.
ufw allow 3478/udp comment 'TURN/STUN (coturn)'
ufw allow 3478/tcp comment 'TURN over TCP (coturn)'
# MUST match --min-port/--max-port in docker-compose.prod.yml's coturn command.
# coturn allocates one UDP port per relay session, so this range IS the
# concurrent relayed-call capacity of the host — it was 49160:49200, which is
# 41 ports and about twenty calls for the entire platform. A range narrower
# than coturn's own leaves it handing out ports the firewall drops, which
# presents as calls that connect and carry no media, for only the minority of
# users who actually need a relay.
ufw allow 30000:49999/udp comment 'TURN relay range (coturn)'
# Group-call media (LiveKit SFU, host-networked). Comment these out if you are
# NOT running the livekit service.
#
# ⚠️ These rules are not optional decoration. If the UDP range is closed, a group
# call CONNECTS, shows every participant, and carries no audio or video — the
# most confusing failure this stack has, because it looks exactly like an
# application bug. The TCP fallback is what rescues clients on networks that
# block UDP outright (corporate proxies, some hotel and airline wifi).
ufw allow 50000:50200/udp comment 'SFU media range (livekit)'
ufw allow 7881/tcp comment 'SFU media TCP fallback (livekit)'
# DELIBERATELY NOT OPENED: 7880, LiveKit's signaling/HTTP port. Host networking
# makes it listen on every interface, but the public door to it is the
# TLS-terminated /livekit route through Caddy. Opening 7880 here would publish
# an unencrypted second entrance to the same service.
# `ufw --force enable` is idempotent: re-running just reloads the ruleset.
ufw --force enable
ufw reload

# ── 2. SSH: key-only, no root password login ────────────────────────────────
# CRITICAL: only enforce key-only auth when at least one authorized_keys file
# exists — otherwise we'd lock out a box that currently logs in by password. We
# do NOT even WRITE the drop-in when no key is present, because a stray
# `PasswordAuthentication no` would bite on the next sshd restart / reboot even
# if we skip the reload now. Add your public key (ssh-copy-id), then re-run.
if grep -rqsI . /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null; then
  log "Enforcing key-only SSH (authorized_keys present) via a drop-in"
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/99-taskboard-hardening.conf <<'EOF'
# Managed by infra/host/harden-host.sh — key-based auth only.
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
PermitEmptyPasswords no
EOF
  if ! sshd -t; then
    echo "ERROR: sshd config test failed; reverting drop-in, NOT reloading." >&2
    rm -f /etc/ssh/sshd_config.d/99-taskboard-hardening.conf
    exit 1
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload
  log "sshd reloaded with key-only auth."
else
  echo "WARNING: no authorized_keys found — SKIPPING SSH key-only hardening to" >&2
  echo "         avoid lockout (ufw + fail2ban below still apply). Add your public" >&2
  echo "         key, then re-run this script to enforce key-only auth." >&2
fi

# ── 3. fail2ban: throttle SSH brute-force ───────────────────────────────────
log "Installing + enabling fail2ban (sshd jail)"
apt-get install -y -qq fail2ban
cat > /etc/fail2ban/jail.d/taskboard-sshd.local <<EOF
[sshd]
enabled  = true
port     = ${SSH_PORT}
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# ── Summary ─────────────────────────────────────────────────────────────────
log "Done. Current state:"
echo "--- ufw status ---";        ufw status verbose || true
echo "--- listening sockets ---"; ss -tlnp 2>/dev/null | awk 'NR==1 || /:(22|80|443)\s/ || /LISTEN/' | head -20 || true
echo "--- fail2ban sshd ---";     fail2ban-client status sshd 2>/dev/null || true
cat <<'NOTE'

Verify from OFF the box (so Docker's chain is in play):
  nmap -Pn -p 22,80,443,5432,6379,9092,8001-8004,8080 <host>
Expect ONLY 22, 80, 443 open; every datastore/service port filtered/closed.
5432 IS published, so it must read `filtered` from an address that is not on the
db-allowlist.sh allowlist. `open` there means the allowlist is not in force —
run `sudo bash infra/host/db-allowlist.sh` and re-scan.
NOTE
