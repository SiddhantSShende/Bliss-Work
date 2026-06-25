# ── build stage ───────────────────────────────────────────────────────────────
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache module downloads.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/messaging-svc ./cmd/server

# ── final stage ─────────────────────────────────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/messaging-svc /app/messaging-svc
RUN chown -R app:app /app

USER app

EXPOSE 8004

# Readiness probe — wget is already installed in the runtime layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8004/readyz || exit 1

ENTRYPOINT ["/app/messaging-svc"]
