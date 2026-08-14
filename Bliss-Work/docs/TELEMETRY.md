# Member activity record

What BlissWork records about how people work, who can see it, how long it is
kept, and how to operate it.

Owned by `telemetry-svc` (Python/FastAPI, port 8006, database `telemetrydb`).

---

## 1. What is collected

| Signal | Source | Trust |
|---|---|---|
| Sign-in, sign-out, workspace switch | `auth.events`, emitted by auth-svc in the same transaction as the state change | **server-observed** |
| Messages sent, tasks allocated / acknowledged / completed / reviewed, forwards, blocks | `messaging.events.v1`, `task.events.v1` | **server-observed** |
| Section visited and dwell time, focus/blur, idle, heartbeat | client beacon (`POST /telemetry/beacon`) | self-reported |
| Foreground application name, OS idle, screen lock | desktop agent (`apps/desktop/src/main/activity-agent.ts`), opt-in per machine | self-reported |
| Sites visited | browser extension (`apps/extension`), paired per browser | self-reported |

`source` is stored on every row and rendered distinctly in the UI and the
export. Server-observed rows are derived from events the services emitted while
doing the work and cannot be forged, suppressed or inflated by a client;
everything else is a claim made by software running on the member's machine.
**That distinction is load-bearing the moment anyone uses this screen to make a
decision about a person.**

### Not collected, deliberately

- **Window titles.** They routinely contain document names, customer names and
  password-manager entries. `app_usage_daily` stores an application name only.
- **Full URLs in aggregates.** The registrable domain is stored in the clear
  because every aggregate groups by it; the path lives encrypted and is only
  ever read one row at a time on the timeline.
- **Message bodies.** A preview of the first 120 characters is stored, encrypted
  — never the conversation. Structured payloads (media, locations) are reduced
  to their readable prefix ("🖼️ 3 photos"), so attachment ids and shared
  coordinates cannot reach the telemetry store even though the raw body rides
  the Kafka event.
- **Names and email addresses.** `telemetrydb` holds `user_id`s only; the client
  joins them against auth-svc's directory. A compromise of this database yields
  behaviour without identity.

## 2. Who can see it

One function, `app/routes/subject.py::resolve_subject`, is the entire
enforcement point:

- every member may read **their own** record (`/telemetry/members/me/*`, or
  Settings → Your activity);
- only an `org_admin` may read **anyone else's**;
- the org-wide views (`/telemetry/org/summary`, `scope=org` export) are
  admin-only via `require_admin`.

Members are told, in the product, that this exists — a notice in the Members
list and a permanent entry in Settings. That is a deliberate product decision,
not decoration: monitoring people without telling them is unlawful in much of
the world and corrosive everywhere else.

## 3. Retention — and the separate question of visibility

Two different windows. Confusing them is the easiest mistake to make here.

**Visibility (`TELEMETRY_VISIBLE_WINDOW_DAYS`, default 7)** is how far back the
per-event detail can be *browsed*: the member timeline and the session list.
Those are the intrusive surfaces — a minute-by-minute record of one named
person — and there is no operational reason to scroll a quarter of them. It is
enforced server-side by clamping the query, not by the range picker, so the
limit holds for anything talking to the API. It deletes nothing.

Aggregates are deliberately **not** bounded by it. `/telemetry/summary`,
`/telemetry/org/summary` and the export answer "how has this workload trended",
which needs the longer arc, and they expose totals rather than a play-by-play.

**Retention** is how long the data is *kept*:

- **Raw events: 90 days** (`TELEMETRY_RAW_RETENTION_DAYS`). `activity_events` is
  partitioned by day, so expiry is a `DROP TABLE` rather than a multi-million-row
  `DELETE` competing with every other service for autovacuum.
- **Daily rollups: kept forever.** `activity_daily`, `app_usage_daily` and
  `site_usage_daily` are what make a year-over-year chart possible after the
  events behind it are gone.
- **Sessions: 90 days** after they end.
- **Kafka dedup keys: 7 days.**

## 4. The nightly jobs

Both are systemd timers; `infra/systemd/` is the source of truth.

| Unit | When | What |
|---|---|---|
| `blisswork-telemetry-rollup.timer` | 01:30 UTC | Rolls yesterday into the daily aggregates. **Before** the 02:30 backup, so each dump contains the day that just closed. |
| `blisswork-telemetry-prune.timer` | 04:30 UTC | Drops expired raw partitions. **After** the backup and after the 04:00 attachment GC — this job deletes data, so the most recent dump must predate it. |

**The prune refuses to run** if a day it is about to drop was never rolled up,
and exits non-zero so the unit goes red. Rollups are the only thing that
survives, so dropping an unrolled day destroys it permanently and silently. If
that fires:

```bash
ROLLUP_DAY=YYYY-MM-DD bash scripts/telemetry-rollup.sh
```

Backfill a range, or re-check without deleting:

```bash
ROLLUP_FROM=2026-07-01 ROLLUP_TO=2026-07-31 bash scripts/telemetry-rollup.sh
PRUNE_DRY_RUN=1 bash scripts/telemetry-prune.sh
```

## 5. First deploy

`infra/postgres/init/*` runs ONCE, on an empty data volume. Production's
Postgres was initialized long ago, so the database and role must be created by
hand — this is the single most likely way for the first telemetry deploy to
fail:

```bash
TELEMETRY_DB_PASSWORD='…' bash scripts/create-telemetry-db.sh   # idempotent
# then set TELEMETRY_DATABASE_URL in .env.prod to match, and:
bash scripts/deploy-prod.sh

sudo cp infra/systemd/blisswork-telemetry-*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blisswork-telemetry-rollup.timer blisswork-telemetry-prune.timer
```

The role must be a **non-superuser that owns the `public` schema**. Postgres
lets a superuser bypass Row-Level Security entirely, so a service connecting as
`taskboard` would read every org's activity with the per-org policies silently
doing nothing. `create-telemetry-db.sh` verifies both properties and refuses to
report success otherwise.

## 6. Operating notes

- **The beacon is the highest-frequency JSON POST in the product** — a batch per
  open client every 30s. It is exactly the shape OWASP CRS anomaly scoring trips
  on. If beacons start 403ing, add a scoped exclusion keyed on
  `REQUEST_URI "^/api/telemetry/beacon"` in
  `infra/caddy/coraza/rules/99-tuning.conf` rather than lowering the paranoia
  level globally.
- **The Kafka consumer starts at `latest`, never `earliest`.** A fresh consumer
  group on `earliest` would replay every event these topics have ever held into
  partitions that were never created for those dates. Telemetry starts when it
  is switched on; it is not a backfill tool.
- **Rollup days are `ROLLUP_TIMEZONE` days** (default UTC). Changing it later
  requires recomputing every rollup, so decide while the history is short.
- **`telemetrydb` is in the nightly backup** (`scripts/backup-db.sh`).

## 7. Agents (desktop app, browser extension)

Both are **opt-in per machine** and both authenticate with a single-purpose
pairing secret rather than a session — see `apps/extension/README.md` for the
reasoning, which applies identically to the desktop sampler.

- Minted by the member from their own session, for themselves. An admin cannot
  mint one on someone's behalf; that would be an admin able to write activity
  attributed to a colleague.
- Stored only as `sha256(raw)`, scoped to one `(org, user)`, write-only.
- Revocable from Settings → Your activity, which works even when the device is
  gone — a wiped laptop cannot unpair itself.
- **Revoked automatically** when the membership ends: the telemetry consumer
  handles `user.removed` / `user.deactivated` by revoking that person's tokens,
  because revoking their sessions does nothing to an agent secret.

The desktop agent degrades rather than fails: `powerMonitor` idle and lock work
everywhere with no dependency, and foreground-application sampling is a
dynamically-loaded optional native module. Where it is unavailable — a build
without it installed, or a Wayland session, where GNOME and KDE deliberately do
not expose the active window — the Settings screen says so. An empty "Apps used"
panel would otherwise read to an admin as "they did no work", which is a
materially different claim.

## 8. Right to erasure

The per-org DEK model applies here as it does elsewhere: deleting an org's
`org_keys` row makes every `detail_enc`, `ip_enc` and `user_agent_enc` value
permanently unreadable in O(1). The timeline degrades gracefully — surrounding
metadata still renders, and the undecryptable detail is simply absent rather
than 500ing the page.
