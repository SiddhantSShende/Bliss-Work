# Activating WAL archiving / PITR (A7) — prepared, not yet applied

`infra/postgres/Dockerfile` and `infra/postgres/pgbackrest.conf` are ready to
review. This document is the exact remaining diff and command sequence to
activate them against the live production Postgres — written out rather than
applied automatically, because **the last step recreates the live `postgres`
container**, and `docs/DEPLOY.md` already documents that a Postgres capacity
setting change "recreates the container — a brief outage for every service,
not a reload." `archive_mode` is exactly that kind of setting: not reloadable,
requires a restart. Get sign-off on the outage window before running the
last two steps against production.

## What changes in `docker-compose.prod.yml`

The `postgres` service currently pulls a stock, pinned image
(`image: postgres:17-alpine@sha256:...`). It needs to build the image in
`infra/postgres/` instead, and add two `-c` flags plus a repo volume:

```diff
   postgres:
-    image: postgres:17-alpine@sha256:dc17045ccfd343b49600570ea734b9c4991cf1c3f3302e67df51e3b402dd55c4
+    build: infra/postgres
     restart: unless-stopped
     command:
       - postgres
       - -c
       - ssl=on
       # ... existing ssl/-c flags unchanged ...
       - -c
       - max_wal_size=4GB
+      # ── WAL archiving / PITR (A7) ──────────────────────────────────────
+      - -c
+      - archive_mode=on
+      - -c
+      - archive_command=pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=taskboard archive-push %p
     environment:
       # ... unchanged ...
     volumes:
       - pgdata:/var/lib/postgresql/data
       - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
       - ./infra/postgres/certs:/etc/postgres/certs:ro
+      - ./infra/postgres/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro
+      - pgbackrest_repo:/var/lib/pgbackrest
```

And add the new named volume alongside the existing `pgdata`/`media_blobs`
declarations at the bottom of the file:

```diff
 volumes:
   pgdata:
+  pgbackrest_repo:
```

`repo1-cipher-pass` in `pgbackrest.conf` ships as a placeholder — replace it
with a real secret (same secret-manager path as `BACKUP_ENCRYPTION_KEY`)
before building, not by editing the committed file.

## One-time activation sequence

```sh
# 1. Build the new image (does not touch the running container yet).
docker compose -f docker-compose.prod.yml build postgres

# 2. Recreate postgres with the new image + archive_mode=on. THIS IS THE
#    BRIEF-OUTAGE STEP — every service loses its DB connection until the new
#    container is healthy again (docs/DEPLOY.md's existing "Postgres restarts
#    for capacity settings are NOT rolling" note applies verbatim here).
docker compose -f docker-compose.prod.yml up -d postgres

# 3. Wait for healthy, then create the pgBackRest stanza — a ONE-TIME
#    operation; running it again against an already-initialized stanza is
#    safe (idempotent) but unnecessary.
docker compose -f docker-compose.prod.yml exec postgres \
  pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=taskboard stanza-create

# 4. First full backup — WAL archiving alone with no base backup is not yet
#    a working PITR chain.
docker compose -f docker-compose.prod.yml exec postgres \
  pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=taskboard --type=full backup

# 5. Verify archiving is actually flowing (should show a growing WAL segment
#    count, not stay at zero):
docker compose -f docker-compose.prod.yml exec postgres \
  pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=taskboard info
```

Restore to a point in time:

```sh
docker compose -f docker-compose.prod.yml exec postgres \
  pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=taskboard \
  --type=time --target='2026-06-25 14:30:00+00' restore
```

## Scheduling incremental backups

`docs/BACKUPS.md`'s template suggests nightly full + hourly incremental. Add a
new systemd timer/service pair (`infra/systemd/blisswork-pgbackrest.{service,timer}`)
following the exact pattern every other unit in `infra/systemd/` already uses
(see `infra/systemd/README.md`) — not written here, since it's a mechanical
follow of that established pattern once the steps above are confirmed working
against production, not something to speculatively add before archiving is
even flowing.

## Integrating with `blisswork-restore-test.timer`

`scripts/restore-test.sh` (A8) already documents this as a known gap: it only
verifies the nightly logical dumps, not a PITR restore. Once the sequence
above is live, extend that same script's pattern (disposable scratch
container, real integrity checks, not just "the command exited 0") to also
restore a `pgbackrest` backup and confirm it comes up clean — the scratch-
restore-and-verify mechanism is already built; this is applying it to a
second backup mechanism, not writing a new one.

## Off-host copy

`pgbackrest_repo` starts as local-disk-only (see the comment at the top of
`pgbackrest.conf`). Extend `scripts/backup-offsite.sh`'s existing rsync target
to also cover this volume's mount point, or migrate `repo1-path` to S3-
compatible object storage (pgBackRest supports this natively via
`repo1-type=s3` and the same `MEDIA_S3_*`-style credentials messaging-svc
already uses for its own S3 backend) once a bucket exists. Local-only is a
real improvement over the current ~24h RPO in the meantime, not a reason to
wait for the off-host piece before shipping this.
