# ─────────────────────────────────────────────────────────────────────────────
# Custom Caddy build with the Coraza WAF (OWASP Core Rule Set) for the prod edge.
#
# Stock Caddy has no WAF, so we compile one in with xcaddy. The resulting binary
# understands the `coraza_waf` directive used by infra/caddy/Caddyfile.waf.
#
# Build (referenced by docker-compose.prod.yml `caddy.build`):
#     docker compose -f docker-compose.prod.yml build caddy
# or standalone:
#     docker build -t task-board/caddy-waf:2.8 infra/caddy
#
# The coraza-caddy module EMBEDS the OWASP CRS, exposed via the `load_owasp_crs`
# directive — so the rules ship inside the image. The mounted /etc/caddy/coraza
# files (coraza.conf / crs-setup.conf / rules/*.conf) layer site-specific tuning
# and the DetectionOnly→On engine toggle on top.
# ─────────────────────────────────────────────────────────────────────────────
FROM caddy:2.8-builder-alpine AS build
# Pin the Coraza Caddy module. v2 targets Caddy v2.x and bundles the OWASP CRS.
RUN xcaddy build \
    --with github.com/corazawaf/coraza-caddy/v2

FROM caddy:2.8-alpine
# Replace the stock binary with the WAF-enabled build.
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# Sanity: the custom directive must be present in the build.
RUN caddy list-modules 2>/dev/null | grep -q coraza || \
    (echo "ERROR: coraza module missing from Caddy build" >&2; exit 1)
