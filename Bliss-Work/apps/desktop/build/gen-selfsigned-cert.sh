#!/usr/bin/env bash
#
# Generate a SELF-SIGNED Windows code-signing certificate (.pfx) for LOCAL /
# INTERNAL testing of the signing pipeline only.
#
# ⚠️  IMPORTANT — READ THIS ⚠️
# A self-signed certificate is NOT trusted by Windows on other people's
# machines. It lets you verify that electron-builder signing WORKS end to end,
# and it can be trusted on machines where you manually install the public cert
# into "Trusted Root Certification Authorities" + "Trusted Publishers" (e.g. a
# managed corporate fleet via GPO). For PUBLIC distribution with NO SmartScreen
# warning you MUST buy a real Authenticode certificate from a CA (DigiCert,
# Sectigo, GlobalSign, SSL.com …) — see SIGNING.md.
#
# Output:
#   build/certs/blisswork-selfsigned.pfx   (private key + cert, for signing)
#   build/certs/blisswork-selfsigned.crt   (public cert, to trust on test PCs)
#
# Usage:
#   bash build/gen-selfsigned-cert.sh "YourStrongPassword"
# Then build a signed installer with:
#   CSC_LINK="$PWD/build/certs/blisswork-selfsigned.pfx" \
#   CSC_KEY_PASSWORD="YourStrongPassword" \
#   npx electron-builder --win
set -euo pipefail

PASS="${1:-blisswork-test}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
CN="BlissWork (AEIV Global Private Limited)"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

echo "▸ Generating a 3072-bit key + self-signed code-signing cert for: $CN"

# Code-signing needs the Code Signing EKU (1.3.6.1.5.5.7.3.3).
cat > _codesign.ext <<'EOF'
[codesign]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
EOF

openssl req -x509 -newkey rsa:3072 -keyout _key.pem -out blisswork-selfsigned.crt \
  -days 1095 -nodes \
  -subj "/CN=${CN}/O=AEIV Global Private Limited/C=IN" \
  -extensions codesign -config <(cat /etc/ssl/openssl.cnf _codesign.ext) 2>/dev/null \
  || openssl req -x509 -newkey rsa:3072 -keyout _key.pem -out blisswork-selfsigned.crt \
       -days 1095 -nodes -subj "/CN=${CN}/O=AEIV Global Private Limited/C=IN" \
       -addext "basicConstraints=critical,CA:FALSE" \
       -addext "keyUsage=critical,digitalSignature" \
       -addext "extendedKeyUsage=critical,codeSigning"

openssl pkcs12 -export -out blisswork-selfsigned.pfx \
  -inkey _key.pem -in blisswork-selfsigned.crt \
  -passout pass:"$PASS"

rm -f _key.pem _codesign.ext

echo ""
echo "✓ Wrote:"
echo "    $OUT_DIR/blisswork-selfsigned.pfx  (sign with this)"
echo "    $OUT_DIR/blisswork-selfsigned.crt  (import into Trusted Root + Trusted Publishers on test PCs)"
echo ""
echo "Build a self-signed installer:"
echo "    CSC_LINK=\"$OUT_DIR/blisswork-selfsigned.pfx\" CSC_KEY_PASSWORD=\"$PASS\" npx electron-builder --win"
echo ""
echo "⚠  Self-signed = still warns on machines that don't trust this cert. For public"
echo "   distribution buy a real Authenticode cert (see SIGNING.md)."
