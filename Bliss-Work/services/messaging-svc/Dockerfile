# ── build stage ───────────────────────────────────────────────────────────────
FROM golang:1.26-alpine@sha256:3ad57304ad93bbec8548a0437ad9e06a455660655d9af011d58b993f6f615648 AS build
WORKDIR /src

# ── BUILD CONTEXT IS THE REPOSITORY ROOT, not services/messaging-svc ────────
# go.mod points its github.com/task-board/shared-kafkaauth,
# github.com/task-board/shared-internalauth and
# github.com/task-board/shared-jwtauth requirements at the sibling modules
# services/shared/kafkaauth (Kafka SASL/TLS config, also used by
# notification-svc and ws-gateway), services/shared/internalauth
# (constant-time internal-service-secret comparison, also used by
# ws-gateway) and services/shared/jwtauth via `replace ... => ../shared/X`
# directives, so the build needs all three directories too:
#
#     docker build -f services/messaging-svc/Dockerfile .
#
# .dockerignore at the repo root keeps that context to roughly source size.

# Cache module downloads: manifests first, so this layer is reused until a
# dependency actually changes.
COPY services/messaging-svc/go.mod services/messaging-svc/go.sum services/messaging-svc/
COPY services/shared/kafkaauth/go.mod services/shared/kafkaauth/
COPY services/shared/internalauth/go.mod services/shared/internalauth/
COPY services/shared/jwtauth/go.mod services/shared/jwtauth/
WORKDIR /src/services/messaging-svc
RUN go mod download

WORKDIR /src
COPY services/messaging-svc services/messaging-svc
COPY services/shared/kafkaauth services/shared/kafkaauth
COPY services/shared/internalauth services/shared/internalauth
COPY services/shared/jwtauth services/shared/jwtauth
WORKDIR /src/services/messaging-svc

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/messaging-svc ./cmd/server
# Attachment garbage collector — run as a cron/one-shot, not by the server.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/gc-attachments ./cmd/gc-attachments
# Event-table retention. Also a cron/one-shot: the outbox and the dedup tables
# had no retention at all, so they grew one row per event forever on the single
# Postgres primary. See the command's own doc comment.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/prune-event-tables ./cmd/prune-event-tables

# ── final stage ─────────────────────────────────────────────────────────────────
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache wget ca-certificates

# Unprivileged runtime user/group.
RUN adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/messaging-svc /app/messaging-svc
COPY --from=build /out/gc-attachments /app/gc-attachments
COPY --from=build /out/prune-event-tables /app/prune-event-tables
RUN chown -R app:app /app

# Attachment blob volume. Creating and chowning the MOUNTPOINT here is what
# makes the volume writable as uid 10001: Docker copies the mountpoint's
# ownership onto a named volume when it is first created. Without this the
# volume lands root-owned and every upload fails with EACCES — and because the
# rest of the root filesystem is read-only in production, there is no other
# writable path to fall back to.
RUN mkdir -p /var/lib/blisswork/media && chown -R app:app /var/lib/blisswork
VOLUME ["/var/lib/blisswork/media"]

USER app

EXPOSE 8004

# Readiness probe — wget is already installed in the runtime layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:8004/readyz || exit 1

ENTRYPOINT ["/app/messaging-svc"]
