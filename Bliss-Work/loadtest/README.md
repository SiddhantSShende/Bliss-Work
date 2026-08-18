# Load testing BlissWork

Measured 2026-08-17 against the **dev** compose stack, in **two runs**. Read the
caveats before quoting any number from here — several of them move the answer by
more than an order of magnitude.

**Run 2 supersedes Run 1's headline throughput number.** Run 1 excluded task-svc;
Run 2 rebuilt it and put it back in the mix, and sustainable throughput fell from
700 rps to 400. Jump to [Run 2](#run-2--task-svc-included-and-the-number-moved).
The Redis ceiling — which is what actually binds — is unchanged, and Run 2
confirms it against production data rather than dev.

```
./provision.sh                       # create a pool of accounts (see below)
RATES="100 300 400 500 600" ./step.sh   # walk the throughput/latency curve
```

⚠️ `step.sh` forwards only `LT_EMAIL`/`LT_CHANNEL` into the k6 container and does
not mount `users.json`, so `LT_USERS=users.json ./step.sh` silently falls back to
a **single account** — which measures the per-user rate limiter at ~10 rps, not
capacity. Run 2 drove the pool by mounting it and passing `LT_USERS` through;
`step.sh` should be fixed to do the same.

⚠️ k6's `--summary-export` carries only `avg/min/med/max/p(90)/p(95)`, so the
`p(99)` this harness asks for comes back empty. **The p99 column in Run 1 below
cannot have come from `step.sh`** — treat it as unsourced and read p95 instead.

---

## Run 1 — the measured curve (task-svc excluded)

Dev stack, 8-core box, ~4.5 cores actually available, task-svc excluded (see
"stale image" below). Mix weighted 60/20/10/5/4/1 per
`QUICK_START_OPTIMIZATION.md`.

**Run twice — once on the near-empty dev database, once after `seed.sql` +
`seed2.sql`.** The gap between the two columns is the entire reason the seeded
number is the one to quote.

| Target rps | p50 (empty) | p50 (seeded) | p95 (seeded) | p99 (seeded) | errors | verdict |
|---|---|---|---|---|---|---|
| 100 | 1.95 ms | 4.65 ms | 10.4 ms | 91 ms | 0.00% | idle |
| 300 | 1.75 ms | 5.04 ms | 12.1 ms | 34 ms | 0.00% | comfortable |
| 600 | 1.86 ms | 6.84 ms | 26.5 ms | 99 ms | 0.00% | comfortable |
| **700** | — | **7.12 ms** | **48.9 ms** | **147 ms** | **0.00%** | **last clean point** |
| 800 | — | 12.0 ms | 248 ms | 409 ms | 0.00% | knee — p95 5× in 100 rps |
| 900 | 2.2 ms | 107 ms | 481 ms | 1.09 s | 0.00% | past it; p50 16× |
| 1200 | — | 1.45 s | 3.0 s | 3.08 s | 0.00% | queued solid; run aborted on host load |
| 1000 | 2.39 ms | — | — | — | 0.00% | (empty DB: still idle here) |

**Seeded: sustainable ≈ 700 rps, knee at ~800.**
**Empty: sustainable ≈ 1,000 rps, hard ceiling ~1,600.** Seeding cost ~30% of
throughput and moved the knee down by a third.

Two things about the shape are worth keeping:

- **Saturation here is latency, not errors.** Every seeded row above returned
  0.00% failures, including the run where p50 was 1.45 s. Nothing 5xx'd, nothing
  timed out — requests just queued. An error-rate alert would have stayed green
  through the entire collapse.
- **On the empty database the tail broke first; on the seeded one the median
  breaks too.** Empty, p50 stayed at ~2 ms while p99 hit seconds. Seeded, p50
  itself goes 7 ms → 107 ms. That is the difference between a few slow requests
  and every request being slow, and only the second one is what users feel.

## Turning that into DAU

Requests/day = 700 rps × 86,400 = **60.5M requests/day** of capacity.

Two things convert that to DAU, and both are assumptions rather than
measurements:

- **Requests per user per day.** Clients poll `/presence` every 20s while open
  and react-query refetches on a 10s stale time, so an active session is
  request-heavy. 300–500/user/day is a reasonable band for 20–40 min of use.
- **Peak-to-average ratio.** Traffic is not flat across 24h. A work app
  typically puts 10–15% of its daily traffic in its busiest hour, i.e. a peak
  factor of **~3×** over the daily mean. Capacity must cover the peak.

| req/user/day | DAU at peak factor 3 |
|---|---|
| 300 | ~67,000 |
| 500 | ~40,000 |
| 1000 | ~20,000 |

**So: roughly 40,000–67,000 DAU** — call it **~50,000** — for this stack on this
hardware, under the caveats below. **⚠️ SUPERSEDED by Run 2: with task-svc in the
mix this is 23,000–38,000, and neither number is the binding one — Redis is.** That sits at the top of the ~10k comfortable
/ ~50k ceiling band in `INFRASTRUCTURE.md`, which is a reasonable place for a
box with headroom and no read cache to land.

### What the seeded data was, and what it was not

535,531 channel messages, 76,658 DMs, 224,396 memberships, 6,795 channels,
1,643 users, 1,281 conversations, 6,419 notifications, across 32 orgs — roughly
200 channels and 50 users per org, with the driving account a member of 30.

That is a credible mid-size tenant. It is **not** a large one: no org here has
10,000 members or 50,000 channels, and those are the shapes
`INFRASTRUCTURE.md` calls out as the ones that hurt (the O(N) roster on every
send, `/channels/open` before it was paged). A single large customer would pull
this number down further than the 30% that seeding already cost.

## Caveats, in order of how much they matter

1. **No WebSocket load.** Real users hold a socket for their whole session.
   `WS_MAX_CONNECTIONS=25000` and the Redis replay outbox are sized in *weekly
   actives*, and INFRASTRUCTURE.md's Stage 11 audit found Redis memory — not
   HTTP throughput — to be the binding constraint on the deployed stack. This
   test does not touch that at all, and it is probably the real ceiling. The
   ~50k figure above is an HTTP number; treat it as an upper bound until the
   socket tier is measured.
2. **Shared box.** A live production stack runs on the same 8 cores. Only ~4.5
   were free, and the load average sat at ~5 before the test started. A
   dedicated box would measure higher.
3. **The messaging inbox is unseeded.** `inbox_items` is constrained to
   THREAD/TASK kinds and needs `threads` seeded first, so it was left alone —
   see the note in seed2.sql. It is off this mix's path but is a hot read in
   the real product.
4. **task-svc excluded.** See below.
5. **No read cache.** `READ_CACHE_ENABLED` is off, which is the current
   default; the largest available win is not in these numbers. Every one of the
   700 rps above went to the single Postgres primary.

## Three things the test found before it could measure anything

Each of these made the earlier readings meaningless, and each is worth knowing
independently of load testing.

### Rate limits are keyed on the verified USER

messaging-svc allows 600 reads/min and 120 writes/min per user, task-svc and
auth-svc 600 and 120/min. A load test driven by one account measures the
limiter: it flatlines around 10 rps and returns 429s that have nothing to do
with capacity. `provision.sh` exists for this — budget roughly one account per
10 rps of intended load.

### The per-IP limiter is bypassable by setting a header

messaging-svc resolves the caller address from the **last** `X-Forwarded-For`
entry with no trusted-hop configuration (`internal/middleware/ratelimit.go:245`).
Measured on the dev stack:

- 500 requests, one source, no header → **212 rate-limited**
- 500 identical requests, varying `X-Forwarded-For` → **0 rate-limited**

**In production this is currently safe**, and the reason is worth stating
precisely: Caddy appends the real client address to `X-Forwarded-For`, so the
last entry is Caddy's observation rather than anything the client chose, and
the service ports are not published. So this is a **defence-in-depth** gap, not
a live bypass.

What makes it worth fixing anyway is the asymmetry: auth-svc solves the same
problem properly, via `TRUSTED_PROXY_HOPS` (`app/net.py`), and documents that
setting it too high "is how a per-IP limiter becomes bypassable". messaging-svc
has no equivalent knob, so any topology change — a second proxy, a direct
internal caller, an ingress that overwrites rather than appends — silently
turns the outermost anti-flood defence off, with nothing to configure and no
error. The Go services should take the hop count the same way the Python ones
already do.

### The deployed task-svc image is a month stale

`task-board-task-svc-1` was built **2026-07-11**; auth-svc and messaging-svc
were rebuilt today. The old image predates `app/net.py`, so its limiter cannot
see `X-Forwarded-For` and buckets the entire fleet into a single 600/min key —
it returns 429 from ~10 rps upward regardless of how load is spread. That alone
produced 13–35% error rates in the first curve and looked exactly like
saturation. It is excluded via `SKIP_TASK=1`; rebuild it and re-run to include
task-svc in the number.

**Done in Run 2.** Rebuilt from current HEAD and re-run without `SKIP_TASK`: the
429 storm is gone (0.00% failures up to 500 rps), and with the tasks path back in
the mix the sustainable rate is **400 rps, not 700**. Rebuilding it also surfaced
that an untracked `009_delete_muth_tasks.sql` in the migrations directory matches
tasks by `t.title` — a column that no longer exists, since titles are encrypted —
so task-svc crash-loops at boot on `UndefinedColumnError` wherever that file is
present in the build context.

---

## Run 2 — task-svc included, and the number moved

Same box, same seeded database (536,211 channel messages, 76,658 DMs, 7,037
channels, 224,638 memberships), same 60/20/10/5/4/1 mix. Two things differ from
Run 1: **task-svc was rebuilt from current HEAD and left in the mix** (Run 1 had
to exclude it), and the account pool was actually driven rather than silently
collapsing to one account.

| target rps | achieved | p50 | p90 | p95 | fail% |
|---|---|---|---|---|---|
| 100 | 92.2 | 5.47 ms | 10.2 ms | 13.8 ms | 0.00% |
| 300 | 272.0 | 6.56 ms | 15.8 ms | 25.6 ms | 0.00% |
| **400** | **357.3** | **7.68 ms** | **31.0 ms** | **139 ms** | **0.00%** |
| 500 | 448.6 | 11.4 ms | 282 ms | 455 ms | 0.00% |
| 600 | 494.1 | 14.3 ms | 1.51 s | 2.81 s | 0.00% |
| 700 | 548.3 | 13.3 ms | 4.28 s | 6.07 s | 4.21% |
| 800 | 609.0 | 40.6 ms | 4.79 s | 9.55 s | 17.21% |

**Sustainable ≈ 400 rps. Knee at 500. Throughput plateaus around 600** — past
that the arrival rate simply queues, which is why achieved rps stops tracking
target.

### It is two endpoints, not the stack

The interesting part is not the aggregate. At 600 rps:

| endpoint | p50 | p95 |
|---|---|---|
| `ep_inbox` | 456 ms | **5.29 s** |
| `ep_tasks` | 391 ms | **5.41 s** |
| ep_directory | 17.4 ms | 347 ms |
| ep_channels | 14.5 ms | 47.6 ms |
| ep_conversations | 9.55 ms | 31.3 ms |
| ep_send | 8.15 ms | 20.4 ms |
| ep_messages | 4.32 ms | 19.4 ms |
| ep_notifications | 3.02 ms | 10.4 ms |

Everything except the inbox and the tasks read is still comfortably under 50 ms
at the rate where the aggregate p95 has already hit 2.8 s. Those two are the
capacity number; the rest of the surface has headroom. `ep_login` (744 ms) is
Argon2 doing its job and is 1% of the mix by design.

That also means the Run 1 caveat "the messaging inbox is unseeded… it is off
this mix's path" understated things: `/inbox` **is** on the path, and it is one
of the two paths that break.

### WebSocket, re-measured

| target | held | gateway MB | Redis MB | B/conn (gateway) | B/conn (Redis) | rejects |
|---|---|---|---|---|---|---|
| 500 | 500 | 48.1 | 7.63 | 67,193 | 902 | 0 |
| 2,000 | 2,000 | 138.9 | 7.76 | 64,398 | 294 | 0 |
| 5,000 | 4,998 | 319.2 | 7.17 | 63,596 | — | 2 |
| 8,000 | 7,824 | 522.6 | 7.03 | 67,885 | — | 178 |

Baseline 16.07 MB gateway / 7.20 MB Redis. **~65 KB per connection**, confirming
Run 1's ~60 KB across four scales.

Redis cost per *idle socket* falls into allocator noise above ~2,000 (the column
goes negative — used_memory drifts below baseline). Presence and the node
registry are not a constraint at any scale this box can reach. The rejections are
`WS_MAX_CONNS_PER_USER=20` against a 500-account pool, not a gateway limit.

### The Redis ceiling, measured on production

Run 1 derived ~550–630 bytes/entry from dev. Sampling the **live production**
Redis instead — 18 real user outboxes, 2,280 entries, deepest 550 —

    1,380,275 bytes / 2,280 entries = 605 bytes/entry

which lands inside Run 1's band and confirms it against real event payloads.
Against prod's `maxmemory 2gb` / `noeviction` and the 7-day `outboxTTL`:

| entries/user/week | WAU | DAU (0.4–0.6 ratio) |
|---|---|---|
| 127 — mean observed on prod today | 27,900 | 11,200–16,800 |
| **350 — 50 events/day × 7d (roadmap)** | **10,100** | **4,100–6,100** |
| 2,000 — `maxReplayHard` trim cap | 1,780 | 710–1,065 |

Reserving ~20% of the 2 GiB for presence, the node registry and the shared
rate-limit buckets pulls the middle row to **3,245–4,868 DAU**.

Production currently uses **2.93 MB of 2 GB** — 0.14%. The ceiling is real and a
long way off.

### The single highest-leverage change

Reaching 50,000 DAU on this shape needs ~20 GiB of Redis, which is not a
sensible thing to buy. Cutting `outboxTTL` (`internal/store/store.go:20`) from 7
days to 1 divides the requirement by seven — ~2.8 GiB for the same 50,000 — and
costs only replay depth for users offline longer than a day, who already fall
past `maxReplayHard` and backfill over REST. One constant, worth more than any
HTTP-tier optimisation on this list.

### Run 2 caveats

- Sockets were held **idle**, as in Run 1. Fan-out under sustained delivery to a
  large roster is still unmeasured, and remains the biggest unknown.
- The DAU conversions inherit Run 1's peak factor (~3×) and requests-per-user
  band. Those are assumptions, not measurements; the client's polling cadence
  (`App.tsx` `staleTime: 10_000`, plus 20/30/60 s `refetchInterval`s) is what
  they rest on.
- Still a shared box: a live production stack runs on the same 8 cores. Load
  average was 3.3 at the start of the curve and ~11 at 800 rps; prod stayed
  healthy throughout and served in 19–67 ms.

---

## Run 1 — WebSocket capacity

Held idle sockets against the dev gateway, sampling the SERVER rather than k6 —
a held socket issues no requests, so the cost lives in gateway RSS and Redis.

| target | held | gateway RSS | Redis | B/conn (gateway) | B/conn (Redis) |
|---|---|---|---|---|---|
| 500 | 500 | 39 MB | 3.64 MB | ~51,000 | 902 |
| 2,000 | 2,000 | 134 MB | 4.10 MB | ~60,000 | 467 |
| 5,000 | 4,997 | 304 MB | 4.59 MB | ~58,000 | 269 |
| 8,000 | 7,805 | 484 MB | 5.05 MB | ~60,000 | 234 |

Cross-checked from inside the container at 3,000 sockets: `VmRSS` 241 MB,
`go_memstats_heap_inuse` 121 MB, `go_goroutines` 9,069.

- **~60 KB RSS per connection** (~40 KB live Go heap, **3.02 goroutines each**)
- **~250 bytes of Redis per idle connection** (presence + node registry)

The 7,805-of-8,000 shortfall was 198 rejections, all `reason="per_user"` — the
pool hitting `WS_MAX_CONNS_PER_USER=20`, not a gateway limit.

### The gateway costs ~29× what the roadmap records

`INFRASTRUCTURE.md` Stage 1 states a connection went "from 13,855 to 2,079
bytes" after `sendChanCap` was cut from 512 to 64. Measured RSS is **~60,000
bytes**, consistent across four scales and confirmed against `/proc`.

Those are not the same quantity — 2,079 bytes is plausibly the send buffer's
own allocation, while RSS includes the ~3 goroutine stacks per connection (8 KB
minimum each), read/write buffers, and the session objects. The problem is that
**the capacity sizing uses the small number**:

| | |
|---|---|
| prod gateway memory limit | 384 MiB |
| `WS_MAX_CONNECTIONS` in the running prod container | **unset → default 50,000** |
| sockets that actually fit in 384 MiB at 60 KB | **~6,500** |

**✅ FIXED as of the 43da7d0 deploy — re-verified in Run 2.** The running prod
gateway is now limited to **1 GiB** with **`WS_MAX_CONNECTIONS=12,000`** set
explicitly. At the measured ~65 KB/conn that is 0.73 GiB at the cap, against
~16,500 that would fit — so the cap now fires *before* memory, which is the
whole point of having one. The paragraph below describes the state prior to that
deploy and is kept because the reasoning still applies to any future retuning:
the cap and the memory limit have to move together.

So the connection cap is roughly **8× unreachable**. The container is
OOM-killed long before the cap can refuse a connection cleanly — which is the
exact failure Stage 11 describes having fixed ("the pod was OOM-killed around
13k, so the cap that exists to refuse connections cleanly never fired. Memory
limits now move with the cap and both files say so"). `.env.prod.example` does
set `WS_MAX_CONNECTIONS=25000`, but the deployed container has no `WS_*`
variables set at all, so it runs on the 50,000 default — and 25,000 would still
not fit in 384 MiB.

### Redis: the outbox, not the sockets

Idle connections cost ~250 bytes of Redis each, which is nothing. The replay
outbox is the constraint, and measuring real keys confirms the roadmap's
arithmetic rather than overturning it:

| outbox key depth | bytes | bytes/entry |
|---|---|---|
| 7 | 4,958 | 708 |
| 53 | 28,912 | 545 |
| 65 | 36,384 | 560 |
| 71 | 39,182 | 552 |
| 115 | 71,600 | 623 |

**~550–630 bytes per entry** (TTL confirmed at ~7 days), against the ~700 B
assumed in `INFRASTRUCTURE.md` — so slightly *better* than assumed. At the
2,000-entry trim cap a single user's outbox tops out around **1.2 MB**.

Against production's `maxmemory 2gb` with `noeviction`, and the roadmap's
assumption of ~50 events/day over a 7-day TTL (~350 entries/user):

    2 GB / (350 x 600 B) = ~9,500 weekly actives

That is the number that binds, and it is an order of magnitude below the HTTP
tier's ~50,000 DAU. At a DAU/WAU ratio of 0.4–0.6 it lands at roughly
**4,000–6,000 DAU** before Redis fills — and because the policy is
`noeviction`, filling it takes presence, the node registry and the shared
rate-limit buckets down with the outbox, not just replay history.

### So which ceiling is real

| tier | ceiling | equivalent DAU |
|---|---|---|
| HTTP (seeded DB) | 700 rps | ~50,000 |
| ws-gateway memory | ~6,500 sockets before OOM | ~90,000 (if it degraded gracefully — it does not) |
| **Redis replay outbox** | **~9,500 weekly actives** | **~4,000–6,000** |

Updated after Run 2 (task-svc included; prod limits as deployed at 43da7d0):

| tier | ceiling | equivalent DAU |
|---|---|---|
| HTTP (seeded DB, task-svc **in**) | **400 rps** sustainable, knee 500 | 23,000–38,000 |
| ws-gateway | cap 12,000 in 1 GiB — cap binds, not memory | ~96,000+ |
| **Redis replay outbox** | **~8,100–10,100 weekly actives** | **~3,000–6,000** |

The conclusion is unchanged and now rests on production bytes rather than dev
ones: **Redis binds first, by roughly 5×.**

**Stage 11 was right: Redis binds first**, by roughly an order of magnitude, and
this measurement supports its reasoning with real key sizes rather than
replacing it. The new finding is the gateway's per-connection memory, which
does not change which tier binds but does mean the connection cap protecting it
is set ~8× beyond what its memory limit can hold.

### Caveats

- Sockets were held **idle**. Fan-out under sustained delivery to a large
  roster is not measured here; the seeded orgs top out at 35 members, and the
  O(N) roster cost lives well above that.
- Dev Redis has **no** `maxmemory`; production caps at 2gb. The ceiling above is
  computed from measured bytes-per-entry, not observed by filling it.
- Dev gateway has no memory limit; production's 384 MiB is the constraint.
  I did not drive the gateway to OOM — that would be a destructive test on a box
  running production.

## Safety

`step.sh` refuses to continue if any `*-prod-*` container leaves `(healthy)` or
if the 1-minute load average passes `ABORT_LOAD` (default 14). **Never point
this at the production ports.** The provisioning script creates real accounts
and the mix performs writes.
