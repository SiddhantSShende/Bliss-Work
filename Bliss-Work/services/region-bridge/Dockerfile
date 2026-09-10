# ── build stage ───────────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/region-bridge ───────
# go.mod points its github.com/task-board/shared-backoff and
# github.com/task-board/shared-kafkaauth requirements at the sibling modules
# services/shared/backoff and services/shared/kafkaauth (the same Kafka
# SASL/TLS config used by messaging-svc, notification-svc and sticky-relay)
# via `replace ... => ../shared/...` directives, so the build needs both:
#
#     docker build -f services/region-bridge/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.

# Cache dependencies: manifests first, so this layer is reused until a
# dependency actually changes.
COPY services/region-bridge/go.mod services/region-bridge/go.sum services/region-bridge/
COPY services/shared/backoff/go.mod services/shared/backoff/
COPY services/shared/kafkaauth/go.mod services/shared/kafkaauth/
WORKDIR /src/services/region-bridge
RUN go mod download

# Build.
WORKDIR /src
COPY services/region-bridge services/region-bridge
COPY services/shared/backoff services/shared/backoff
COPY services/shared/kafkaauth services/shared/kafkaauth
WORKDIR /src/services/region-bridge

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/region-bridge ./cmd/bridge

# ── final stage ───────────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/region-bridge /app/region-bridge
RUN chown -R app:app /app

USER app

EXPOSE 8080

# READINESS, not liveness. /readyz fails on a dead dependency or a stalled
# import; /healthz would pass in both cases, which is the point of having two —
# restarting this process does not fix NATS, and a restart loop during a WAN
# partition destroys the offsets' usefulness for nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8080/readyz || exit 1

ENTRYPOINT ["/app/region-bridge"]
