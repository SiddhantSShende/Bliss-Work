#!/usr/bin/env bash
# Shared boilerplate for the maintenance/ops scripts in scripts/. Source it —
# do not execute it directly.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/compose-job.sh"
#
# Assumes the sourcing script already has `set -Eeuo pipefail` active (every
# caller in this directory does) — this file does not set shell options
# itself, so sourcing it never silently changes a caller's shell behavior.
#
# Provides:
#   detect_docker_sudo()            sets USE_SUDO (0/1) and DOCKER ("docker"
#                                    or "sudo docker"), or exits 1 if neither
#                                    plain nor passwordless-sudo docker works.
#   compose()                       `docker compose` wrapper that re-adds
#                                    COMPOSE_FILE (and, if set, the names
#                                    listed in COMPOSE_SUDO_ENV_VARS) through
#                                    `sudo env` when USE_SUDO=1.
#   run_and_capture_for_journald()  run a command, capture its combined
#                                    output, re-emit it, and return its exit
#                                    status.
#   envval(file, key)               read one KEY=value out of an env file
#                                    without sourcing it.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "compose-job.sh is a library — source it, don't execute it" >&2
  exit 1
fi

# detect_docker_sudo(): docker may or may not be reachable without sudo
# depending on the invoking user's groups (systemd units typically run as
# root and need neither). Detect once rather than assume — these jobs run
# unattended, where a sudo password prompt would hang the job rather than
# fail it.
detect_docker_sudo() {
  if docker info >/dev/null 2>&1; then
    USE_SUDO=0
    DOCKER="docker"
  elif sudo -n docker info >/dev/null 2>&1; then
    USE_SUDO=1
    DOCKER="sudo docker"
  else
    echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
    exit 1
  fi
}

# compose(): wraps `docker compose`. COMPOSE_FILE must reach compose, and
# SUDO SANITIZES THE ENVIRONMENT — an exported COMPOSE_FILE does not survive
# `sudo docker compose`, which then silently falls back to the DEV
# docker-compose.yml whose services are not running here. The failure reads
# "service X is not running", pointing at the service rather than at the
# missing variable.
#
# Set COMPOSE_SUDO_ENV_VARS (space-separated names) before calling compose()
# to forward additional environment variables through `sudo env` the same
# way — gc-attachments.sh needs this for GC_DRY_RUN/GC_BATCH_SIZE.
compose() {
  if (( USE_SUDO )); then
    local -a env_args=(COMPOSE_FILE="$COMPOSE_FILE")
    local var
    for var in ${COMPOSE_SUDO_ENV_VARS:-}; do
      env_args+=("$var=${!var:-}")
    done
    sudo env "${env_args[@]}" docker compose "$@"
  else
    docker compose "$@"
  fi
}

# run_and_capture_for_journald(): run "$@", capture its combined
# stdout+stderr, re-emit it, then return its exit status. The output is
# CAPTURED and re-emitted from this shell rather than inherited straight
# through: the snap Docker CLI re-parents itself into its own transient scope
# (snap.docker.docker-<uuid>.scope), so anything it writes is attributed to
# THAT unit in the journal — `journalctl -u blisswork-<job>.service` would
# show only "Started" and "Finished" and none of the job's own log lines.
# Echoing from bash puts the writer back in the service's cgroup.
#
# Cost: output arrives at the end rather than streaming. These jobs print a
# handful of lines and finish quickly, so that trade is free.
run_and_capture_for_journald() {
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  [ -n "$output" ] && printf '%s\n' "$output"
  return "$status"
}

# envval(file, key): read a single KEY=value out of an env file WITHOUT
# sourcing it. Sourcing would execute whatever is in there, and these files
# hold production secrets. Strips one layer of surrounding double quotes, if
# present — unlike a bare `tr -d '"'`, it leaves a literal `"` that is part
# of the value itself (not just wrapping it) untouched.
envval() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/'
}
