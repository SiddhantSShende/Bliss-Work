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

### Known gaps

- **No alerting.** A failed run marks the unit failed and logs to the journal,
  but nothing pages anyone. `OnFailure=` pointing at a notifier is the fix.
- **Not off-host.** Dumps live on the same disk as the database they protect, so
  they cover a bad migration or a dropped table but not loss of the host. Real
  off-site storage needs a destination and credentials.
- **The passphrase is on the same host as the dumps.** Lose the disk and you lose
  both the backups and the only key that opens them. It belongs in a password
  manager too — without it the dumps are unrecoverable, by design.
