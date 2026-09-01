#!/usr/bin/env bash
# One-shot: create stickydb + its least-privilege role on a LIVE Postgres.
#
# stickydb backs sticky-svc, which holds the durable record of which task
# notes belong on which desktop.
#
#   STICKY_DB_PASSWORD='…' bash scripts/create-sticky-db.sh
#   STICKY_DB_PASSWORD='…' DRY_RUN=1 bash scripts/create-sticky-db.sh
#
# ── Why a script and not just the init files ─────────────────────────────────
# infra/postgres/init/*.sql and *.sh run ONCE, on an EMPTY data volume, via the
# postgres image's entrypoint. This host's Postgres was initialized long ago, so
# editing those files does nothing here — they only serve fresh environments.
# Adding stickydb to them (done) and running this once (to do) are BOTH
# required, and forgetting the second is the single most likely way for the first
# sticky-svc deploy to fail: the container crash-loops on a database that was
# never created, and the desktop notes quietly fall back to client-local state.
#
# ── The part that actually matters ───────────────────────────────────────────
# The role must be a NON-SUPERUSER that OWNS the database's public schema. Not a
# detail: Postgres lets a superuser bypass Row-Level Security entirely, so a
# service connecting as `taskboard` would read every org's pins with the
# per-org policies silently doing nothing. FORCE RLS then covers the owner case.
# This mirrors infra/postgres/init/02-create-roles.sh exactly.
#
# Safe to re-run: every step is guarded.
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.prod.yml}"
export COMPOSE_FILE
cd "$REPO_DIR"

: "${STICKY_DB_PASSWORD:?set STICKY_DB_PASSWORD (must match STICKY_DATABASE_URL in .env.prod)}"
PG_USER="${POSTGRES_USER:-taskboard}"

if docker info >/dev/null 2>&1; then
  USE_SUDO=0
elif sudo -n docker info >/dev/null 2>&1; then
  USE_SUDO=1
else
  echo "cannot reach the Docker daemon (with or without passwordless sudo)" >&2
  exit 1
fi

compose() {
  if (( USE_SUDO )); then
    sudo env COMPOSE_FILE="$COMPOSE_FILE" docker compose "$@"
  else
    docker compose "$@"
  fi
}

psql_super() {
  # Piped over stdin, never `docker cp`: the prod containers run with a read-only
  # root filesystem, so there is nowhere to copy a file to.
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"
}

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: would create database stickydb and role sticky_user"
  psql_super -d postgres -tAc \
    "SELECT 'stickydb exists: ' || EXISTS (SELECT 1 FROM pg_database WHERE datname='stickydb');"
  psql_super -d postgres -tAc \
    "SELECT 'sticky_user exists: ' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sticky_user');"
  exit 0
fi

echo "==> creating database stickydb (if absent)"
# CREATE DATABASE accepts neither IF NOT EXISTS nor a transaction block, and
# psql's \gexec is a META-command that only exists when psql is reading a
# script — it is not SQL, so it cannot ride in on `-c`. Ask, then act.
if [ "$(psql_super -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='stickydb'" | tr -d '[:space:]')" = "1" ]; then
  echo "    already exists"
else
  psql_super -d postgres -c "CREATE DATABASE stickydb"
fi

echo "==> creating role sticky_user (if absent) + granting CONNECT"
psql_super -d postgres -v pw="$STICKY_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sticky_user') THEN
        CREATE ROLE sticky_user LOGIN;
    END IF;
END $$;
SQL
# Set the password separately so re-running the script rotates it, and pipe it
# through STDIN rather than `-c`: psql substitutes :'pw' only when reading a
# script. With `-c` the literal `:'pw'` reaches the parser and is a syntax error
# — which is the safe way to fail, but still a failure.
#
# :'pw' (not :pw) is what single-quotes and escapes the value, so a password
# containing a quote cannot terminate the statement.
psql_super -d postgres -v pw="$STICKY_DB_PASSWORD" <<'SQL'
ALTER ROLE sticky_user LOGIN PASSWORD :'pw';
SQL
psql_super -d postgres \
  -c "REVOKE ALL ON DATABASE stickydb FROM PUBLIC;" \
  -c "GRANT CONNECT ON DATABASE stickydb TO sticky_user;"

echo "==> handing the public schema to sticky_user (so RLS enforces)"
psql_super -d stickydb \
  -c "CREATE EXTENSION IF NOT EXISTS citext;" \
  -c "GRANT ALL ON SCHEMA public TO sticky_user;" \
  -c "ALTER SCHEMA public OWNER TO sticky_user;"

echo "==> verifying"
owner=$(psql_super -d stickydb -tAc \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public';")
super=$(psql_super -d postgres -tAc \
  "SELECT rolsuper FROM pg_roles WHERE rolname='sticky_user';")
echo "    public schema owner: $owner"
echo "    sticky_user is superuser: $super"
if [ "$owner" != "sticky_user" ] || [ "$super" != "f" ]; then
  echo "REFUSING to report success: RLS would not enforce with this configuration" >&2
  exit 1
fi

echo
echo "stickydb is ready. Next:"
echo "  1. STICKY_DATABASE_URL in .env.prod must use sticky_user with this password."
echo "  2. Deploy sticky-svc; it runs its own migrations on boot."
echo "  3. Deploy sticky-relay with DRY_RUN=true for one sweep cycle first — it"
echo "     logs the plan and publishes nothing. Flip it to false only after"
echo "     reading those numbers, or the first sweep after the consumer"
echo "     back-fills every historical task nudges the whole user base at once."
