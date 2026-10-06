# ── Build stage ───────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# BUILD CONTEXT IS THE REPOSITORY ROOT: go.mod points shared-internalauth at the
# sibling module services/shared/internalauth via a `replace` directive, and the
# final stage copies the English UI catalogs from packages/app.
#
#     docker build -f services/translate-gw/Dockerfile .
COPY services/translate-gw/go.mod services/translate-gw/go.sum services/translate-gw/
COPY services/shared/internalauth/go.mod services/shared/internalauth/
WORKDIR /src/services/translate-gw
RUN go mod download

WORKDIR /src
COPY services/translate-gw services/translate-gw
COPY services/shared/internalauth services/shared/internalauth
WORKDIR /src/services/translate-gw
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/translate-gw ./cmd/server

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
# ca-certificates: TLS to translation.googleapis.com and oauth2.googleapis.com.
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user. NO credential is baked in: Application Default
# Credentials are supplied at run time (see docker-compose*.yml's translate-gw).
RUN adduser -D -u 10001 app
WORKDIR /app
COPY --from=build /out/translate-gw /app/translate-gw
# The canonical English UI strings — the SAME files the client bundles, so the
# client's catalog and the gateway's never drift into two hand-kept copies. This
# is the only text the gateway will ever translate (see internal/catalog).
COPY packages/app/src/i18n/locales/en /app/i18n_source/en
RUN chown -R app:app /app
ENV I18N_SOURCE_DIR=/app/i18n_source/en
USER app

EXPOSE 8012
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8012/readyz || exit 1
ENTRYPOINT ["/app/translate-gw"]
