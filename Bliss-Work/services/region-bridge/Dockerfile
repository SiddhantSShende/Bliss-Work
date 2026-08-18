# ── build stage ───────────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# Cache module downloads.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
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
