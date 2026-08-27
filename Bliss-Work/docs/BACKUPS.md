# Backups & Point-in-Time Recovery

## Encrypted logical backups (any environment)

`scripts/backup-db.sh` dumps every service database and streams each through
AES-256-CBC so plaintext never lands on disk:

```sh
BACKUP_ENCRYPTION_KEY='<strong-passphrase>' ./scripts/backup-db.sh
# -> backups/<db>-<UTC-ts>.sql.enc  (authdb, taskdb, messagingdb, notificationdb, emaildb)

# restore one:
BACKUP_ENCRYPTION_KEY='<same>' ./scripts/restore-db.sh backups/authdb-<ts>.sql.enc authdb
```

- **Column encryption interplay:** the `*_enc` columns stay ciphertext inside the
  dump; the `org_keys` rows are dumped too, so a restore is readable — unless that
  org was crypto-shredded (its `org_keys` row deleted), which stays unreadable
  even from backup. Store `BACKUP_ENCRYPTION_KEY` in the secret manager, NOT with
  the backups.
- Schedule via cron / a Kubernetes CronJob; ship the `.sql.enc` files to
  object storage (S3/GCS) with bucket-level encryption + lifecycle expiry.

## Point-in-Time Recovery (production)

Logical dumps give a daily restore point; for PITR (restore to any second) use
**pgBackRest** (or WAL-G) with encryption + WAL archiving:

```ini
# pgbackrest.conf
[global]
repo1-path=/var/lib/pgbackrest
repo1-cipher-type=aes-256-cbc          # encrypted repo
repo1-cipher-pass=<from-secret-manager>
repo1-retention-full=14

[taskboard]
pg1-path=/var/lib/postgresql/data
```

```ini
# postgresql.conf
archive_mode = on
archive_command = 'pgbackrest --stanza=taskboard archive-push %p'
```

```sh
pgbackrest --stanza=taskboard stanza-create
pgbackrest --stanza=taskboard --type=full backup     # nightly
pgbackrest --stanza=taskboard --type=incr backup     # hourly
# restore to a timestamp:
pgbackrest --stanza=taskboard --type=time \
  --target='2026-06-25 14:30:00+00' restore
```

Run backups against a replica where possible. Managed Postgres (RDS/Cloud SQL)
gives encrypted automated backups + PITR out of the box — prefer it in prod.

**PITR itself is documented above, not deployed.** The production host runs
the nightly logical-dump path only (`blisswork-backup.timer`, below) —
`archive_mode`/`archive_command` are not set on the live `postgres` service,
so RPO today is bounded by the nightly backup window (~24h), not continuous.
Wiring up the `pgbackrest.conf`/`postgresql.conf` blocks above against the
real deployment is open work (Part A.7 of the scaling roadmap).

## Restore testing

"Test restores regularly (an untested backup is not a backup)" used to be the
entire content of this section — advice, not a mechanism, and there was no
evidence a restore had ever actually been exercised. `blisswork-restore-test.timer`
(see `infra/systemd/README.md`) now does this automatically every night: it
restores the previous backup set into a disposable scratch Postgres, checks
every database actually has data in it (not just that `psql` exited 0), and
alerts on anything short of a full pass. It currently covers the logical-dump
path only — extending it to verify a PITR restore, once that's wired up, is
the natural next step rather than a new script.
