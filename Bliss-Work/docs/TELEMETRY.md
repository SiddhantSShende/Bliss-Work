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
| Refused screen-capture attempts (`screenshot.attempted`, category `security`) | client beacon, from whichever host detected it | self-reported |
| Foreground application name, OS idle, screen lock | desktop agent (`apps/desktop/src/main/activity-agent.ts`), opt-in per machine | self-reported |
| Sites visited | browser extension (`apps/extension`), paired per browser | self-reported |

`source` is stored on every row and rendered distinctly in the UI and the
export. Server-observed rows are derived from events the services emitted while
doing the work and cannot be forged, suppressed or inflated by a client;
everything else is a claim made by software running on the member's machine.
**That distinction is load-bearing the moment anyone uses this screen to make a
decision about a person.**

### Window titles — collected, with explicit consent, encrypted

Window titles routinely contain document names, customer names and
password-manager entries, so they are held to a higher bar than the rest of
this feature:

- Carried only in `detail_enc` (encrypted per-org, read one row at a time on
  the timeline) — never in `targetId`, which stays the coarse, plaintext,
  aggregatable application name every rollup groups by. `app_usage_daily`
  still stores an application name only; no rollup ever sees a title.
- Gated by the SAME explicit, versioned, per-machine consent as everything
  else in §7 — turning on activity tracking for a device is what allows
  titles, not a separate switch, and DeviceActivitySettings.tsx says so in the
  disclosure list before anyone connects a device.
- On macOS specifically, reading a title ALSO requires the OS's own Screen
  Recording permission, independently of BlissWork's consent above. See
  §8 for the full breakdown — application-name tracking works on macOS
  without it; only the title half is gated.

### Not collected, deliberately

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
make prod-deploy

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

## 8. macOS desktop sensor — permissions, onboarding, degradation

The desktop activity sensor (`apps/desktop/src/main/activity-agent.ts`) uses
the SAME code path on Windows, macOS and Linux — it calls `get-windows`
identically on every platform, and `get-windows` itself is what differs
underneath. macOS is the one platform with an OS-level permission gate on
part of what the sensor reads, handled in its own module,
`apps/desktop/src/main/macos-permissions.ts`, kept isolated from the shared
sampling logic: a platform assumption is the part that cannot be verified
without the real operating system in front of you, so it belongs in one small
module of its own rather than spread through the sensor.

### 8.1 Required permission

| Permission | Required for | NOT required for |
|---|---|---|
| **Screen Recording** (macOS System Settings → Privacy & Security → Screen Recording) | Window **title** ("activity.go - BlissWork") | Application **name/process** ("Switched to VS Code") — this works unconditionally |

Only one macOS permission is requested by this feature. `get-windows` also
supports an **Accessibility** permission (for browser-tab URL detection), but
this sensor never enables that option — page-level browser context is the
browser extension's job (see §7 and `apps/extension/README.md`), not the
desktop sensor's, so Accessibility is never requested here at all.

**Why Screen Recording, specifically:** macOS treats reading another
application's window title as screen content, gated behind the same TCC
permission family used for actual screen capture, regardless of whether any
pixel is ever read. There is no narrower "just the title" permission on
macOS. Apple's own `get-windows` dependency (`screenRecordingPermission`
option) documents this exact behavior: with the permission absent, `title`
comes back as an empty string — never an exception.

### 8.2 First-run behavior

macOS shows its OWN native Screen Recording prompt automatically, the first
time any gated API is actually called — there is no Electron or BlissWork API
to trigger that prompt early or suppress it (confirmed: Electron's
`systemPreferences.askForMediaAccess` explicitly does not accept `'screen'` as
a media type; only `'microphone' | 'camera'` are supported there). This means:

1. The person clicks **"Turn on for this device"** in Settings → Activity.
2. `DeviceActivitySettings.tsx` pairs the device, enables the agent, and — on
   a macOS build specifically — the success toast says *"macOS may ask for
   Screen Recording access — allow it to include window titles"*, so the
   native OS dialog that appears moments later reads as expected rather than
   as something going wrong.
3. The agent's first sample runs `get-windows`' underlying window-list call,
   which is what actually triggers the OS prompt.
4. Whatever the person chooses, application-name tracking is unaffected
   either way — it does not wait on this decision.

### 8.3 Permission denied (at any point)

`get-windows` never throws for a denied Screen Recording permission; it
returns `title: ""` silently. `activity-agent.ts`'s `sample()` already treats
an empty/absent title as "no `detail.title` for this row" (this was already
true before macOS existed as a target — the same code path handles a
Windows/Linux window that legitimately has no title). The practical effect:

- **Rows keep recording.** "Switched to VS Code" / duration still appears.
- **No second line.** The title line ("activity.go - BlissWork") is simply
  absent — not blank, not a placeholder, not an error string.
- **The Settings screen says so.** `capability()` returns
  `titleTracking: false` with a `titleTrackingReason` describing WHY
  (not-determined / denied / restricted), rendered as a narrow warning
  distinct from the broader "app tracking isn't available at all" banner —
  conflating the two would tell someone whose titles are merely ungranted
  that their whole activity record is broken, which is not true.
- **A one-click path back.** The same panel offers "Open Screen Recording
  settings", which deep-links to the exact System Settings pane
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  — confirmed stable across Ventura/Sonoma/Sequoia; NOT independently
  confirmed on macOS Tahoe, which reportedly relabels the pane in its UI —
  see §8.5).

### 8.4 Permission revoked while the app is running

This is the genuinely subtle case, and it is handled deliberately rather than
assumed away:

- Electron's own `systemPreferences.getMediaAccessStatus('screen')` is
  **documented to go stale** after a change made in System Settings while the
  app keeps running (tracked upstream as `electron/electron#36722`) — it does
  not reliably reflect a revocation until the app restarts.
- So `macos-permissions.ts` does not trust that status alone. Every
  foreground sample already reads whether a title came back
  (`recordTitleObservation`, called from `activity-agent.ts`'s existing
  `sample()` loop — no new sampling, just an interpretation of data already
  being read); `titleReadWorking()` combines the OS's cached status with the
  last 5 minutes of REAL observations, and a real "no title" observation
  overrides a stale "granted" status.
- The Settings screen polls this every 30 seconds while open, so a
  revocation is discoverable without needing to close and reopen Settings —
  see `DeviceActivitySettings.tsx`'s periodic `load()`.
- Either way — believed-granted-but-actually-revoked, or correctly-detected
  — the agent never crashes or stops recording application names; the
  degradation is always "titles silently absent for new rows going forward",
  never "the whole feature breaks".

### 8.5 What was — and was NOT — verified

**This environment could not run Electron on macOS, sign a build, or trigger
a real TCC prompt.** No Mac hardware, no Xcode/codesign, no Apple Developer
identity was available. Saying this feature "supports macOS" on the strength
of TypeScript compiling for a `darwin` target would be exactly the false
claim this feature's own requirements warn against, so the honest state is
recorded here rather than implied by silence.

**Actually verified, in this environment:**

- `apps/desktop` typechecks clean against the extended `capability()`/IPC
  contract (`tsc --noEmit`, zero new errors).
- `macos-permissions.ts`'s logic is unit-tested (20 tests,
  `src/main/macos-permissions.test.ts`) against a mocked
  `systemPreferences.getMediaAccessStatus`, covering: every documented status
  value, the platform guard on Windows/Linux, the API-throws case, and —
  specifically — the `#36722` staleness scenario (a stale "granted" status
  overridden by a real recent "no title" observation).
- `DeviceActivitySettings.tsx`'s new branches are tested (9 tests,
  `DeviceActivitySettings.test.tsx`): the narrow vs. broad warning
  distinction, the settings-deep-link button, the macOS-only onboarding
  toast copy, and the 30-second re-poll actually surfacing a state change.
- The type contract between `get-windows`' documented `MacOSResult`/
  `MacOSOwner` shape and this codebase's `ForegroundWindow` interface was
  checked field-by-field against the library's own `.d.ts` (`name`,
  `processId`, `path` on `BaseOwner`; `title` on `BaseResult`) — structurally
  compatible, not merely "TypeScript did not complain".
- The `x-apple.systempreferences:...Privacy_ScreenCapture` deep link and the
  Screen-Recording-vs-Accessibility permission split were checked against
  Electron's and `get-windows`' own documentation, not assumed.

**NOT verified — required before this can be called production-ready on
macOS:**

- A real Screen Recording TCC prompt has never actually been triggered or
  observed on macOS hardware.
- `get-windows`' real runtime behavior on macOS (title empty-string-on-denial,
  `owner.name`/`owner.path` working unconditionally) is taken from its
  documentation, not independently confirmed by running it.
- Real revocation timing — whether `titleReadWorking()`'s 5-minute
  observation window is well-tuned against ACTUAL `getMediaAccessStatus`
  staleness on current macOS, rather than the general behavior described in
  the upstream issue — is unverified.
- Code-signing/notarization interaction: per Apple Developer Forum reports,
  some Screen-Recording-adjacent preflight checks on macOS Sequoia+ reportedly
  require a Developer ID–signed binary and can behave inconsistently under
  ad-hoc signing. This repo's dev builds are not notarized
  (`electron-builder.mac.notarize: false`); whether that affects THIS specific
  permission (Screen Recording via `get-windows`, not ScreenCaptureKit
  directly) has not been tested.
- The Screen Recording pane's identifier on macOS Tahoe (reportedly relabeled
  "Screen & System Audio Recording" in Apple's UI) is unconfirmed to still
  resolve via the same deep link.
- Universal (arm64 + x64) build behavior is unverified — the `get-windows`
  native module's prebuilt binaries are assumed to cover both, per the
  package's own published platform support, not independently confirmed here.

**Required before shipping:** a real macOS test pass — first run (fresh TCC
database, e.g. via `tccutil reset ScreenCapture com.blisswork.desktop`),
explicit denial, and revocation-while-running — on an actual, at minimum
ad-hoc-signed build, ideally on both Intel and Apple Silicon.

## 9. Right to erasure

The per-org DEK model applies here as it does elsewhere: deleting an org's
`org_keys` row makes every `detail_enc`, `ip_enc` and `user_agent_enc` value
permanently unreadable in O(1). The timeline degrades gracefully — surrounding
metadata still renders, and the undecryptable detail is simply absent rather
than 500ing the page.
