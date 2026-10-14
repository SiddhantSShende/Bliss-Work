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
FROM caddy:2.11-builder-alpine@sha256:b6a94e74b72261bd536b35acdd22f3577d4e466a9550f2c8d6c8ed6413085d72 AS build
# coraza-caddy/v2 (>= v2.5) needs Go >= 1.25 (newer than the builder bundles);
# GOTOOLCHAIN=auto fetches the required toolchain on demand.
ENV GOTOOLCHAIN=auto
# coraza-caddy v2.5.0 ships the EMBEDDED OWASP CRS (the `load_owasp_crs`
# directive) and requires Caddy 2.11 — hence the 2.11 builder/runtime here.
# (v2.0.0 has NO embedded CRS, so it was a no-op WAF.) Keep all three —
# builder, runtime, and this module version — bumped together.
RUN xcaddy build \
    --with github.com/corazawaf/coraza-caddy/v2@v2.5.0

FROM caddy:2.11-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
# Replace the stock binary with the WAF-enabled build.
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# Sanity: the coraza module must be compiled in. Its module ID is
# `http.handlers.waf`, so grep the PACKAGE path (which contains coraza-caddy)
# via --packages rather than the module name.
RUN caddy list-modules --packages 2>/dev/null | grep -q coraza || \
    (echo "ERROR: coraza module missing from Caddy build" >&2; \
     caddy list-modules --packages 2>/dev/null | grep -i waf || true; exit 1)
