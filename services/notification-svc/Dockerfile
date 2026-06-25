# ── Build stage ───────────────────────────────────────────────────────────
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache dependencies.
COPY go.mod go.sum ./
RUN go mod download

# Build.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/notification-svc ./cmd/server

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/notification-svc /app/notification-svc
RUN chown -R app:app /app

USER app

EXPOSE 8003

# Readiness probe — wget is already installed in the runtime layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8003/readyz || exit 1

ENTRYPOINT ["/app/notification-svc"]
