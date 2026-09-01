# ── Build stage ───────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/sticky-relay ────────
# go.mod points its github.com/task-board/shared-kafkaauth requirement at the
# sibling module services/shared/kafkaauth (the Kafka SASL/TLS config also used
# by messaging-svc, notification-svc and ws-gateway) via a
# `replace ... => ../shared/kafkaauth` directive, so the build needs that
# directory too:
#
#     docker build -f services/sticky-relay/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.

# Cache dependencies: manifests first, so this layer is reused until a
# dependency actually changes.
COPY services/sticky-relay/go.mod services/sticky-relay/go.sum services/sticky-relay/
COPY services/shared/kafkaauth/go.mod services/shared/kafkaauth/
WORKDIR /src/services/sticky-relay
RUN go mod download

# Build.
WORKDIR /src
COPY services/sticky-relay services/sticky-relay
COPY services/shared/kafkaauth services/shared/kafkaauth
WORKDIR /src/services/sticky-relay

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/sticky-relay ./cmd/sticky-relay

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/sticky-relay /app/sticky-relay
RUN chown -R app:app /app

USER app

# Metrics/health only — this service serves no application traffic and is not
# published to the host or the edge.
EXPOSE 8010

# Liveness only: there is nothing for a sweeper to be "ready" for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8010/healthz || exit 1

ENTRYPOINT ["/app/sticky-relay"]
