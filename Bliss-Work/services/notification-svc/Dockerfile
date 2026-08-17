# ── Build stage ───────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# Cache dependencies.
COPY go.mod go.sum ./
RUN go mod download

# Build.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/notification-svc ./cmd/server
# Event-table retention, run as a cron/one-shot. notification.events.v1 is the
# highest-fan-out topic in the product — one outbox row per notification per
# recipient — so this table grew fastest and had no bound at all.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/prune-event-tables ./cmd/prune-event-tables

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/notification-svc /app/notification-svc
COPY --from=build /out/prune-event-tables /app/prune-event-tables
RUN chown -R app:app /app

USER app

EXPOSE 8003

# Readiness probe — wget is already installed in the runtime layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8003/readyz || exit 1

ENTRYPOINT ["/app/notification-svc"]
