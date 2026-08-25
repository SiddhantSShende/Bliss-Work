# systemd units (production host)

Units installed on the production VPS. The copies here are the source of truth —
`/etc/systemd/system/` is a deployment target, not a place to edit.

## blisswork-backup.{service,timer}

Daily encrypted dumps of all six service databases via `scripts/backup-db.sh`,
at 02:30 UTC with a ≤5min jitter. `Persistent=true`, so a host that was down at
02:30 runs the backup when it comes back rather than skipping the day.

Installed 2026-08-06, after finding production had been running **11 days with no
backup at all** — the previous dumps were from a single manual run on 2026-07-26.
There was no cron entry, no timer, and nothing in CI: the backup script existed
and worked, it was simply never scheduled.

```sh
sudo cp infra/systemd/blisswork-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-backup.timer

systemctl list-timers blisswork-backup.timer   # when it next runs
sudo journalctl -u blisswork-backup.service    # what happened last time
sudo systemctl start blisswork-backup.service  # run one now
```

Two host-specific details that are easy to get wrong, both of which silently
break every scheduled run:

- Docker here is the **snap**, so the dependency is `snap.docker.dockerd.service`.
  `Requires=docker.service` makes the unit unstartable — there is no such unit.
- systemd's default `PATH` excludes `/snap/bin`, so `docker` is not found unless
  the unit sets `PATH` explicitly.

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/blisswork` | Destination (0700, root). Deliberately outside the repo tree. |
| `BACKUP_KEEP_DAYS` | `14` | Retention. Pruning runs only after a fully successful backup, so a bad day never deletes the last good dumps. |

The passphrase is read from `/home/ubuntu/bliss-backup-key.txt` (0600) at run
time and never written into the unit file, which is world-readable.

## blisswork-gc-attachments.{service,timer}

Daily reap of chat attachments that were uploaded but never sent, via
`scripts/gc-attachments.sh`, at 04:00 UTC with a ≤5min jitter.

**Why the job has to exist at all:** a message references its attachments by ids
embedded in the message body, and bodies are encrypted at rest
(`messages.body_enc`). The server cannot read a message to learn what it points
at, so it can never decide "is this blob still reachable?" by inspection.
Uploads are therefore expiring-by-default (`expires_at = now() +
MEDIA_UPLOAD_TTL`) and made permanent only when the client commits them after
the message is accepted. Someone who attaches a 90 MB video and closes the tab
leaves a row that lapses — and, without this, a blob nothing will ever reference.

**Why 04:00 and not 02:30:** deliberately after the backup. This job DELETES
data, so the most recent dump should predate it. If the reaper ever removed
something it shouldn't, there is a backup from before it ran rather than one
taken afterwards that faithfully records the loss.

```sh
sudo cp infra/systemd/blisswork-gc-attachments.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-gc-attachments.timer

GC_DRY_RUN=1 bash scripts/gc-attachments.sh   # report only, delete nothing
sudo journalctl -u blisswork-gc-attachments.service
```

Installed 2026-08-07, with the media-sharing feature.

Beyond the two host traps above (snap Docker dependency, explicit `PATH`), one
more specific to running a container command from a unit:

- The snap Docker CLI **re-parents itself into its own transient scope**
  (`snap.docker.docker-<uuid>.scope`), so anything `docker compose exec` writes
  is attributed to that scope, not to the calling unit. `journalctl -u
  blisswork-gc-attachments.service` showed only "Started" and "Finished" — none
  of the reaper's own log lines, which is exactly what you want when a nightly
  run misbehaves. The script now captures the output and echoes it from bash, so
  the writer is back in the service's cgroup.

| Env | Default | Meaning |
|---|---|---|
| `GC_DRY_RUN` | unset | Any value: report what would be reclaimed, delete nothing. |
| `GC_BATCH_SIZE` | `500` | Rows per pass; the job loops until a short batch. |

## blisswork-media-disk.{service,timer}

Hourly check of free space on the filesystem backing the `media_blobs` volume,
via `scripts/check-media-disk.sh`. **Emails** when it gets tight.

**Why it emails rather than logs:** Prometheus and Alertmanager exist in this
repo but only under the dev `observability` profile — production runs neither,
and `journalctl` is not an alert. SMTP is already configured and proven (it
sends the invite mail), so it is the one channel that reaches a person.

**Why it matters:** Postgres enforces its own limits; a filesystem does not.
`MEDIA_ORG_DAILY_BYTES` caps how fast ONE org can upload, not the total, and the
volume shares a filesystem with the database. A volume that fills does not
merely stop uploads — it takes Postgres down with it.

**Why hourly:** a disk does not fill gradually. One upload burst can cross the
threshold in minutes, and a daily check could notice up to 24h late. The check
is a `df` in a throwaway container, so polling is free.

**It will not spam you.** State is kept between runs in
`/var/lib/blisswork-alerts/media-disk.state`; mail is sent only when the level
CHANGES (including a RESOLVED notice on recovery), or once per
`ALERT_REPEAT_HOURS` while it stays bad. A send that FAILS is deliberately not
recorded, so it retries next hour rather than being suppressed as "already told
them" — a swallowed alert is indistinguishable from a healthy system.

```sh
sudo cp infra/systemd/blisswork-media-disk.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-media-disk.timer

ALERT_FORCE=1 bash scripts/check-media-disk.sh   # prove the mail path works
sudo journalctl -u blisswork-media-disk.service
```

Installed 2026-08-07. Only CRIT fails the unit, so `systemctl --failed` stays a
list of things needing hands rather than a list of warnings.

| Env | Default | Meaning |
|---|---|---|
| `DISK_WARN_PERCENT` | `80` | Warning threshold. |
| `DISK_CRIT_PERCENT` | `90` | Critical; also fails the unit. |
| `ALERT_EMAIL_TO` | `SMTP_FROM` from `.env.prod` | Recipient. Set in the unit to redirect. |
| `ALERT_REPEAT_HOURS` | `24` | Re-send cadence while the condition persists. |
| `MEDIA_VOLUME` | `task-board-prod_media_blobs` | Volume to measure. |

`scripts/send-alert.py` is the mail sender — stdlib-only on purpose, since an
alerting path that breaks when a dependency moves is not an alerting path. It
takes everything via the environment so no secret appears in `ps`.

## Off-host copy

The unit runs `scripts/backup-offsite.sh` immediately after a successful local
backup, rsyncing the verified dumps to a second machine over SSH. The files are
ciphertext before they leave, so the target stores the data without being
trusted with it.

**To finish setting it up** — one line plus one key:

1. Install this host's dedicated public key on the target, ideally restricted:

   ```
   # in the target's ~/.ssh/authorized_keys
   restrict,command="rsync --server -logDtpre.iLsfxCIvu . /srv/blisswork/" ssh-ed25519 AAAA... blisswork-backup@vps-5ac6bf98
   ```

   The public key is `/root/.ssh/blisswork-backup.pub` on this host. The private
   half is root-only and was generated here — it is not the GitHub key.

2. Set the destination in `/etc/blisswork-backup.env` (0600, not in git — it
   names a private host):

   ```
   BACKUP_REMOTE=backup@your-host.example.com:/srv/blisswork
   ```

3. `sudo systemctl start blisswork-backup.service` and check the journal.

Until `BACKUP_REMOTE` is set **the unit fails on purpose**, every day. The local
dumps still get written and verified first — only the shipping stage fails. That
is deliberate: an off-host backup that quietly isn't happening is the exact
failure this was added to prevent, and a red unit is a reminder where silence
isn't. Set `OFFSITE_REQUIRED=0` to accept local-only without the red mark.

`rsync` runs **without `--delete`**. The remote is not a mirror: if this host is
compromised or its disk wipes, a mirroring rsync would faithfully propagate that
and destroy the last surviving copy. The remote grows instead — ~800KB/day, a few
hundred MB a year — and should be pruned there, on its own schedule.

After shipping, the script re-stats every dump from the last 24h on the far end
and compares sizes. rsync exiting 0 is not proof the bytes landed.

### Known gaps

- **No alerting.** A failed run marks the unit failed and logs to the journal,
  but nothing pages anyone. `OnFailure=` pointing at a notifier is the fix.
- **The passphrase is on the same host as the dumps.** Lose the disk and you lose
  both the backups and the only key that opens them. It belongs in a password
  manager too — without it the dumps are unrecoverable, by design. Copying it to
  the *backup target* would defeat the encryption, so put it somewhere else
  entirely.

## blisswork-refresh-token-prune.{service,timer}

Deletes refresh-token rows past their expiry, via
`scripts/refresh-token-prune.sh` → `python -m app.jobs.prune_refresh_tokens`
inside `auth-svc`. **Hourly** at **:17 UTC**, `Persistent=true`.

**Hourly, unlike everything else here, and that is the point.** The other jobs
clear data that accumulates with USE. `refresh_tokens` gains a row every time an
access token expires — for every logged-in session, whether or not anyone
touched the product — because refresh ROTATES: a new row in, the old one
revoked. Until this job existed, nothing ever deleted either. Nightly would
leave the table that the login path depends on at its largest for most of the
day.

**It deletes on EXPIRY, not on `revoked`.** A revoked row is evidence rather
than litter: replaying a rotated-away token finds it, sees it revoked, and tears
down the whole family — that is the theft detection. Deleting revoked rows early
would make an identical replay read as an unknown token, still refused but no
longer recognised as theft, leaving the rest of the attacker's family working.
Past `expires_at` the replay is refused anyway, so the row has nothing left to
prove. There is also a 24h grace past expiry, purely so a session that failed
moments ago is still visible to an investigation.

Batched — 10k rows per transaction with a commit and a short sleep between them.
A single `DELETE` on a table this size would hold locks for minutes on the table
serving every login; bounded batches compete for milliseconds instead. If a run
hits its batch ceiling it logs `refresh_prune_hit_batch_ceiling` and the next
run continues, so a long-neglected backlog drains over several hours rather than
in one long transaction.

```
sudo cp infra/systemd/blisswork-refresh-token-prune.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-refresh-token-prune.timer

PRUNE_DRY_RUN=1 bash scripts/refresh-token-prune.sh   # count only, delete nothing
sudo journalctl -u blisswork-refresh-token-prune.service
```

## blisswork-redact-expired-secrets.{service,timer}

Strips the raw secret URL from outbox rows once their token has expired, via
`scripts/redact-expired-secrets.sh` → `python -m app.jobs.redact_expired_secrets`
inside `auth-svc`. Every **15 minutes**, `Persistent=true`.

**Why this exists.** Three event types — `password.reset.requested`,
`email.verification.requested`, `invite.created` — carry a raw single-use
secret (a reset/verify/invite URL) in `outbox.payload`. The outbox poller
already strips that field before publishing to Kafka (email-worker pulls it
back via an authenticated internal call instead — see
`docs/AUTH_AUTHZ_REMEDIATION_PLAN.md`, Phase 3), but the STORED row was
untouched by that change and would otherwise carry the secret for the
outbox's full multi-day retention window
(`blisswork-prune-event-tables.{service,timer}`), long after the token itself
stopped being useful. This job closes that gap on its own schedule: once a
row's `expiresAt` has passed, the URL fields are nulled. It never deletes the
row — `prune_event_tables.py` still owns that.

**Why every 15 minutes and not hourly/nightly like everything else here.**
This is a security-hygiene bound, not disk cleanup — password-reset and
email-verification tokens expire in 30-60 minutes, and the point is to keep
the row's exposure window close to the token's own lifetime rather than to
the outbox's multi-day retention.

**Why no batching.** Every other job here batches because it deletes from a
table that grows with platform-wide use over the deployment's entire
lifetime. This one only ever touches rows for three event types in the
narrow window between "pending or just-published" and "past its own
expiresAt" — a handful at any moment, not a backlog. A single `UPDATE` is the
right size for that.

```sh
sudo cp infra/systemd/blisswork-redact-expired-secrets.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-redact-expired-secrets.timer

PRUNE_DRY_RUN=1 bash scripts/redact-expired-secrets.sh   # count only, redact nothing
sudo journalctl -u blisswork-redact-expired-secrets.service
```

## blisswork-org-purge.{service,timer}

Destroys organizations whose deletion grace period has elapsed, via
`scripts/purge-orgs.sh` → `python -m app.jobs.purge_orgs` inside `auth-svc`.
Daily at **05:00 UTC**, `Persistent=true`.

**This is the most destructive job on the host.** It erases an organization
across seven databases and the blob volume. Two properties are load-bearing:

- **It runs last.** After the 02:30 backup, the 03:00 attachment GC and the
  04:30 telemetry prune. The backup ordering is the point — if a deletion was
  requested in error and nobody cancelled it in time, the most recent dump
  predates the loss rather than faithfully recording it.
- **Failure is loud.** Non-zero exit turns the unit red and it should stay red
  until someone looks. A swallowed failure here is indistinguishable from
  "nothing was due", and the difference is whether an erasure request was
  actually honoured.

Only the auth-svc half runs here: the crypto-shred (deleting the org's
`org_keys` row, which makes every encrypted column in every service unreadable
in O(1)) and the auth-side row deletion. The other services erase themselves on
the `org.deleted` event this emits. That asynchrony is deliberate — the
guarantee is the shred, which does not depend on any consumer being up.

```bash
sudo cp infra/systemd/blisswork-org-purge.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-org-purge.timer

systemctl list-timers blisswork-org-purge.timer
sudo journalctl -u blisswork-org-purge.service

# See what WOULD be purged, without deleting anything:
PURGE_DRY_RUN=1 bash scripts/purge-orgs.sh
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PURGE_DRY_RUN` | unset | Report the due orgs and delete nothing. |
| `ORG_DELETE_GRACE_DAYS` | `7` | Read by auth-svc when a deletion is REQUESTED, not by this job — changing it does not move an already-scheduled purge. |
