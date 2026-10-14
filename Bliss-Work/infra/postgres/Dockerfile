# ─────────────────────────────────────────────────────────────────────────────
# Custom Postgres build with pgBackRest, for WAL archiving / PITR (A7 in the
# scaling roadmap).
#
# archive_command runs INSIDE the postgres server process, so the pgbackrest
# binary has to be in this image — a sidecar container cannot satisfy
# archive_command, only stanza-create/backup/restore/expire can run from one.
# Stock postgres:17-alpine has no pgbackrest; this adds it via apk, same
# approach infra/caddy/Dockerfile uses to add Coraza to stock Caddy.
#
# Build (mirrors the caddy build, once wired into docker-compose.prod.yml):
#     docker compose -f docker-compose.prod.yml build postgres
# or standalone:
#     docker build -t task-board/postgres-pgbackrest:17 infra/postgres
#
# NOT YET REFERENCED BY docker-compose.prod.yml. Activating this means
# recreating the live postgres container (archive_mode is not reloadable —
# see docs/BACKUPS.md and infra/postgres/PGBACKREST-SETUP.md), which is a
# brief outage for every service. Left as a prepared, reviewable artifact
# rather than applied automatically.
# ─────────────────────────────────────────────────────────────────────────────
FROM postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873

RUN apk add --no-cache pgbackrest

# Sanity: fail the build rather than ship an image that silently lacks the
# binary archive_command depends on.
RUN pgbackrest version
