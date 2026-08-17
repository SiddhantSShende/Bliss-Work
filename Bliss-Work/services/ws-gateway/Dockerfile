# ── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# TWO binaries from one module, because they are one bounded context: the
# delivery service needs the same recipient-routing contract, the same Redis
# store, the same Kafka security config and the same metrics as the gateway.
# Splitting them into separate modules would duplicate all of it to gain
# nothing — the image is shared and the entrypoint selects which one runs.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/ws-gateway ./cmd/ws-gateway \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/delivery-svc ./cmd/delivery-svc

# ── Final stage ──────────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

COPY --from=build /out/ws-gateway /usr/local/bin/ws-gateway
COPY --from=build /out/delivery-svc /usr/local/bin/delivery-svc

USER app

# 8080 is the gateway; 8090 is delivery-svc's metrics/health port. Only one of
# the two runs per container — the entrypoint decides which.
EXPOSE 8080 8090

# Readiness probe for the DEFAULT entrypoint. A container running delivery-svc
# instead must override this (it listens on DELIVERY_PORT, not 8080) — the
# compose service below does.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8080/readyz || exit 1

# Default to the gateway. Override with
# `entrypoint: ["/usr/local/bin/delivery-svc"]` to run the routed-delivery
# consumer from the same image.
ENTRYPOINT ["/usr/local/bin/ws-gateway"]
