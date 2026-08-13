#!/usr/bin/env bash
#
# Pack the built extension into a signed .crx for self-hosted force-install.
# Delegates to the browserless Node packer (pack-crx.mjs) — no browser needed,
# so it runs on a headless server or in CI.
#
#   npm run build -w @taskboard/extension
#   CODEBASE_URL=https://cdn.example.com/blisswork-activity.crx \
#     bash apps/extension/scripts/pack-crx.sh
#
# See pack-crx.mjs for the format and the self-verification it prints.
set -Eeuo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/pack-crx.mjs" "$@"
