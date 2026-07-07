#!/usr/bin/env bash
#
# Sign a Windows installer with a .pfx/.p12 code-signing cert — ON LINUX, via
# osslsigncode. No Windows machine needed. Runs fine on the VPS or in CI.
#
# Works with either:
#   • a SELF-SIGNED cert (build/gen-selfsigned-cert.sh) — for clean installs on
#     devices your org MANAGES (deploy the .crt to Trusted Root + Trusted
#     Publishers via GPO/Intune — see SIGNING.md "Free path for managed fleets"), OR
#   • any LEGACY file-based OV cert you were issued as a .pfx.
#
# A modern hardware/cloud EV/OV cert can't be exported to a .pfx — for those use
# SSL.com eSigner (build/sign-win.cjs) instead. See SIGNING.md.
#
# Usage:
#   build/sign-win-pfx.sh <cert.pfx> <pfx-password> <input.exe> [output.exe]
#   (defaults output to signing IN PLACE)
# Requires:  sudo apt install osslsigncode
set -euo pipefail

PFX="${1:?usage: sign-win-pfx.sh <cert.pfx> <password> <input.exe> [output.exe]}"
PASS="${2:?missing pfx password}"
IN="${3:?missing input .exe}"
OUT="${4:-$IN}"
TS="${TIMESTAMP_URL:-http://timestamp.digicert.com}"   # RFC3161 timestamp (keeps the sig valid after the cert expires)

command -v osslsigncode >/dev/null || { echo "osslsigncode not found — 'sudo apt install osslsigncode'"; exit 1; }

tmp="$(mktemp --suffix=.exe)"
echo "▸ signing $IN …"
osslsigncode sign \
  -pkcs12 "$PFX" -pass "$PASS" \
  -n "BlissWork" -i "https://blisswork.rnrtechs.com" \
  -h sha256 -ts "$TS" \
  -in "$IN" -out "$tmp"
mv -f "$tmp" "$OUT"

echo "✓ signed → $OUT"
osslsigncode verify "$OUT" 2>/dev/null | grep -iE "Subject:|Timestamp time" | head -4
echo ""
echo "Remember to regenerate SHA256SUMS.txt for the signed file before publishing."
