#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# gen-db-certs.sh — generate a self-signed CA + a Postgres server certificate
# for IN-TRANSIT TLS between the application services and Postgres.
#
# INTENDED USE: dev / staging / a single prod box where you don't yet have a
# corporate or managed-service CA. It produces exactly what the prod stack needs
# to run Postgres with `ssl=on` and the clients with `sslmode=verify-full`:
#
#     infra/postgres/certs/ca.crt        # CA (public)         — mounted into clients
#     infra/postgres/certs/ca.key        # CA private key      — keep OFFLINE / delete
#     infra/postgres/certs/server.crt    # Postgres leaf cert  — mounted into postgres
#     infra/postgres/certs/server.key    # Postgres leaf key   — mounted into postgres
#
# The server cert's CN/SAN is the compose service name (default: `postgres`) so
# `sslmode=verify-full` (which checks the hostname against the cert) succeeds when
# the clients connect to `postgres:5432` on the compose network.
#
#   PROD WITH A REAL CA
#   -------------------
#   Do NOT ship a self-signed CA to real production. Instead use:
#     • a managed Postgres (RDS / Cloud SQL / Azure DB) — download THEIR CA bundle
#       and mount it as ca.crt; the clients still use sslmode=verify-full, and the
#       server cert/key are managed for you (no server.crt/server.key needed); or
#     • your org PKI / cert-manager / Vault PKI to issue the server leaf, and the
#       org root/intermediate CA bundle as ca.crt.
#   In both cases ONLY ca.crt is mounted into the application services; the server
#   key never leaves the database host.
#
# USAGE:
#     scripts/gen-db-certs.sh                 # CN=postgres, 825-day leaf
#     PG_HOST=db.internal DAYS=365 scripts/gen-db-certs.sh
#
# Re-running regenerates everything (idempotent for dev). Postgres requires the
# server key to be owned by the postgres user and mode 0600 — the prod compose
# mounts it read-only and Postgres tolerates a root-owned 0600 file mounted in.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PG_HOST="${PG_HOST:-postgres}"          # must match the host in *_DATABASE_URL
DAYS="${DAYS:-825}"                      # leaf validity (≤825d keeps modern TLS happy)
CA_DAYS="${CA_DAYS:-3650}"
OUT_DIR="${OUT_DIR:-infra/postgres/certs}"

# Resolve OUT_DIR relative to the repo root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
case "${OUT_DIR}" in
  /*) : ;;                               # absolute — leave as-is
  *)  OUT_DIR="${REPO_ROOT}/${OUT_DIR}" ;;
esac

mkdir -p "${OUT_DIR}"
cd "${OUT_DIR}"

echo "==> Generating CA (self-signed, ${CA_DAYS}d) in ${OUT_DIR}"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ca.key
openssl req -x509 -new -nodes -key ca.key -sha256 -days "${CA_DAYS}" \
  -subj "/CN=Task-Board Dev DB CA/O=Task-Board" -out ca.crt \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash"

echo "==> Generating Postgres server key + CSR (CN=${PG_HOST})"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out server.key
openssl req -new -key server.key -subj "/CN=${PG_HOST}/O=Task-Board" -out server.csr

# SANs: the service name verify-full checks, plus localhost/loopback for local psql.
cat > server.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:${PG_HOST}, DNS:localhost, IP:127.0.0.1
EOF

echo "==> Signing server cert with the CA (${DAYS}d)"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "${DAYS}" -sha256 -extfile server.ext -out server.crt

rm -f server.csr server.ext ca.srl

# Postgres refuses a server key that is group/world readable.
chmod 600 server.key ca.key
chmod 644 server.crt ca.crt

# ── Optional: a Redis server cert signed by the SAME CA (REDIS=1) ─────────────
# Redis TLS has the ws-gateway self-signed-CA caveat documented in
# docs/OPERATIONS.md §7 — only useful with a code follow-up or a managed Redis.
if [ "${REDIS:-0}" = "1" ]; then
  REDIS_HOST="${REDIS_HOST:-redis}"
  REDIS_OUT="${REPO_ROOT}/infra/redis/certs"
  echo "==> REDIS=1: generating Redis server cert (CN=${REDIS_HOST}) in ${REDIS_OUT}"
  mkdir -p "${REDIS_OUT}"
  cp ca.crt "${REDIS_OUT}/ca.crt"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${REDIS_OUT}/server.key"
  openssl req -new -key "${REDIS_OUT}/server.key" \
    -subj "/CN=${REDIS_HOST}/O=Task-Board" -out "${REDIS_OUT}/server.csr"
  cat > "${REDIS_OUT}/server.ext" <<EOF2
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:${REDIS_HOST}, DNS:localhost, IP:127.0.0.1
EOF2
  openssl x509 -req -in "${REDIS_OUT}/server.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "${DAYS}" -sha256 -extfile "${REDIS_OUT}/server.ext" -out "${REDIS_OUT}/server.crt"
  rm -f "${REDIS_OUT}/server.csr" "${REDIS_OUT}/server.ext" ca.srl
  chmod 600 "${REDIS_OUT}/server.key"
  chmod 644 "${REDIS_OUT}/server.crt" "${REDIS_OUT}/ca.crt"
  echo "    Redis certs ready in ${REDIS_OUT}"
fi

echo
echo "==> Done. Files in ${OUT_DIR}:"
ls -l ca.crt ca.key server.crt server.key
cat <<EOF

Next steps (prod stack):
  1. The prod compose mounts ${OUT_DIR} into postgres at /etc/postgres/certs (ro)
     and into the app services at /etc/ssl/db (ro). No further wiring needed.
  2. Verify the chain:    openssl verify -CAfile ${OUT_DIR}/ca.crt ${OUT_DIR}/server.crt
  3. KEEP ca.key OFFLINE (or delete it) — it can mint trusted server certs.
  4. The *_DATABASE_URL values in .env.prod already use:
         ?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.crt
EOF
