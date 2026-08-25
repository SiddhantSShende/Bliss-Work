#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# gen-nats-certs.sh — generate a self-signed CA + server/client certificates for
# ONE region's cross-region NATS cluster (infra/nats/region-a.conf /
# region-b.conf).
#
# INTENDED USE: dev / staging / a first real region where you don't yet have a
# corporate or managed CA. Mirrors scripts/gen-db-certs.sh's shape on purpose —
# same layout, same "don't ship this to real prod" caveat — so anyone who has
# provisioned the Postgres certs already knows how this one works.
#
# It produces exactly what ONE region's three NATS nodes need for cluster TLS
# (mutual, same-region) and gateway TLS (mutual, cross-region):
#
#     infra/nats/certs/<region>/ca.crt      # this region's CA (public)
#     infra/nats/certs/<region>/ca.key      # CA private key — keep OFFLINE / delete
#     infra/nats/certs/<region>/server.crt  # shared by all 3 nodes of this region
#     infra/nats/certs/<region>/server.key  # shared by all 3 nodes of this region
#     infra/nats/certs/<region>/bridge.crt  # region-bridge's client cert (NATS_TLS_CERT)
#     infra/nats/certs/<region>/bridge.key  # region-bridge's client key  (NATS_TLS_KEY)
#
# The server cert covers all three node hostnames (nats-<region>-1/2/3) plus
# localhost, so cluster route TLS (`verify: true`, mutual) succeeds between
# siblings. It carries BOTH serverAuth and clientAuth because in a mesh every
# node is a TLS server to inbound routes/gateways AND a TLS client when it
# dials out to its peers — one cert has to work in both directions.
#
# ── Two regions, two CAs — do not share one ──────────────────────────────────
# Each region generates and keeps its OWN CA. A gateway's `tls.ca_file` verifies
# the PEER's certificate, so it must be seeded with the PEER's ca.crt, not this
# region's own — see infra/nats/region-a.conf's gateway block and
# docs/CROSS-REGION.md §7 for the exact exchange. Run this script once per
# region; never copy one region's ca.key to another.
#
#   PROD WITH A REAL CA
#   -------------------
#   Do NOT ship a self-signed CA to real production. Use your org PKI / a
#   managed cert issuer (cert-manager, Vault PKI, ACME) to issue server.crt /
#   server.key and bridge.crt / bridge.key, and place the org root/intermediate
#   bundle at ca.crt. The private key material never has to touch this script.
#
# USAGE:
#     scripts/gen-nats-certs.sh region-a                  # 825-day leaf
#     REGION_HOST_PREFIX=nats-a DAYS=365 scripts/gen-nats-certs.sh region-a
#
# Re-running regenerates everything for that region (idempotent for dev/staging).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="${1:?usage: scripts/gen-nats-certs.sh <region-id>   e.g. region-a}"
# The three node hostnames this region's cluster routes name — see
# infra/nats/region-a.conf's cluster.routes, which lists nats-a-1/2/3 (NOT
# nats-region-a-1/2/3), and docker-compose.crossregion.yml's matching service
# names. Strip a leading "region-" so the common case (region-a, region-b)
# derives the right prefix with no override; pass REGION_HOST_PREFIX explicitly
# for any other naming scheme.
HOST_PREFIX="${REGION_HOST_PREFIX:-nats-${REGION#region-}}"
DAYS="${DAYS:-825}"
CA_DAYS="${CA_DAYS:-3650}"
OUT_DIR="${OUT_DIR:-infra/nats/certs/${REGION}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
case "${OUT_DIR}" in
  /*) : ;;
  *)  OUT_DIR="${REPO_ROOT}/${OUT_DIR}" ;;
esac

mkdir -p "${OUT_DIR}"
cd "${OUT_DIR}"

echo "==> [${REGION}] Generating CA (self-signed, ${CA_DAYS}d) in ${OUT_DIR}"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ca.key
openssl req -x509 -new -nodes -key ca.key -sha256 -days "${CA_DAYS}" \
  -subj "/CN=Task-Board ${REGION} NATS CA/O=Task-Board" -out ca.crt \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash"

echo "==> [${REGION}] Generating shared node server key + CSR (CN=${HOST_PREFIX}-1)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out server.key
openssl req -new -key server.key -subj "/CN=${HOST_PREFIX}-1/O=Task-Board" -out server.csr

cat > server.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = DNS:${HOST_PREFIX}-1, DNS:${HOST_PREFIX}-2, DNS:${HOST_PREFIX}-3, DNS:localhost, IP:127.0.0.1
EOF

echo "==> [${REGION}] Signing node server cert with the CA (${DAYS}d)"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "${DAYS}" -sha256 -extfile server.ext -out server.crt
rm -f server.csr server.ext

echo "==> [${REGION}] Generating region-bridge client key + CSR"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out bridge.key
openssl req -new -key bridge.key -subj "/CN=region-bridge-${REGION}/O=Task-Board" -out bridge.csr
cat > bridge.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
EOF
echo "==> [${REGION}] Signing region-bridge client cert with the CA (${DAYS}d)"
openssl x509 -req -in bridge.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "${DAYS}" -sha256 -extfile bridge.ext -out bridge.crt
rm -f bridge.csr bridge.ext ca.srl

chmod 600 ca.key server.key bridge.key
chmod 644 ca.crt server.crt bridge.crt

# ── OWNERSHIP: bridge.key MUST be readable by region-bridge's runtime uid ────
# services/region-bridge/Dockerfile creates uid 10001 and runs as it (non-root,
# matching x-svc-defaults elsewhere in this repo's prod compose). A 600-mode
# key bind-mounted from the host keeps the HOST uid, so left owned by whoever
# ran this script (typically uid 1000) it fails at container start with
# "error loading client certificate: ... permission denied" — proven directly,
# not a theoretical case. The nats-server containers do NOT need this: the
# official image runs as root, so server.key at 600 owned by the host user is
# already readable there.
#
# Same shape as scripts/gen-db-certs.sh's server.key handling for Postgres:
# this does not break a running region-bridge (the key is only read at
# startup), so getting it wrong lies dormant until the next restart or deploy.
if [ "$(id -u)" -eq 0 ]; then
  chown 10001:10001 bridge.key
elif sudo -n true 2>/dev/null; then
  sudo -n chown 10001:10001 bridge.key
else
  echo "WARNING: could not chown bridge.key to uid 10001 (no root / no passwordless sudo)." >&2
  echo "         region-bridge WILL FAIL TO START on its next (re)start. Fix with:" >&2
  echo "           sudo chown 10001:10001 ${OUT_DIR}/bridge.key" >&2
fi

echo
echo "==> Done. Files in ${OUT_DIR}:"
ls -l ca.crt ca.key server.crt server.key bridge.crt bridge.key
cat <<EOF

Next steps:
  1. Mount ca.crt/server.crt/server.key into the region's nats-* containers at
     /etc/nats/certs/ — see docker-compose.crossregion.yml.
  2. Point the region-bridge service at bridge.crt/bridge.key/ca.crt via
     NATS_TLS_CERT / NATS_TLS_KEY / NATS_TLS_CA.
  3. Set NATS_CLUSTER_PASSWORD / NATS_GATEWAY_PASSWORD in .env.prod (openssl
     rand -base64 32) — these are NOT generated by this script; TLS certs and
     the auth password are independent controls and one is not a substitute
     for the other.
  4. When a real peer region exists, exchange CA public certs out-of-band and
     place the PEER's ca.crt at
     infra/nats/certs/${REGION}/gateway-peer-ca.crt — see docs/CROSS-REGION.md §7.
     NEVER send ca.key anywhere; only ca.crt crosses the wire.
EOF
