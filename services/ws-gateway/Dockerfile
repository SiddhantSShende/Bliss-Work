# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/ws-gateway ./cmd/ws-gateway

# ── Final stage ──────────────────────────────────────────────────────────────
FROM alpine:3.20
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

COPY --from=build /out/ws-gateway /usr/local/bin/ws-gateway

USER app

EXPOSE 8080

# Readiness probe — wget is already installed in the runtime layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8080/readyz || exit 1

ENTRYPOINT ["/usr/local/bin/ws-gateway"]
