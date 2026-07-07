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

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
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
