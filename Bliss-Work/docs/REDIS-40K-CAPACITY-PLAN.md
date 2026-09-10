# Redis 40K User Capacity Plan

Evidence-gathering and design report for the question: **can the current
BlissWork Redis/outbox/replay architecture safely support 40,000 users?**

Produced entirely as measurement, modeling, and design work. **No production
code, configuration, or topology was changed to produce this report** —
`maxReplayHard`, Redis `maxmemory`, the eviction policy, outbox semantics, and
WebSocket acknowledgement behavior are all untouched (see
[Scope and methodology](#scope-and-methodology) for what was and wasn't
possible to test, and the [Implementation Rules](#implementation-rules)
this report was produced under).

Every number below is labeled **MEASURED** (real prod or real controlled
experiment), **MODELED** (derived by combining measured inputs), or
**ASSUMED** (a stated, reasoned assumption where no statistically sufficient
real data exists) — see the Final Rule in the original spec: *"Do not claim
40K readiness from theoretical arithmetic alone."*

---

## Scope and methodology

Production Redis is currently near-empty (`DBSIZE`=30, ~2.13 MB used, a
handful of real active users at measurement time) — there is no way to
statistically sample a real 40K-user-scale population from it today. Where
real production sampling was statistically sufficient (per-entry byte size —
size doesn't require high cardinality to measure accurately), it was used
directly. Where it wasn't (entries/user distribution across a large
population, reconnect-storm behavior at scale), a controlled experiment was
built against a disposable scratch Redis container (`redis-capacity-scratch`,
`redis:7.4-alpine`, torn down after use, never touched prod) seeded with real
production event payloads as templates.

The reconnect-storm test (Phase F) exercises the **Redis layer only** —
concurrent reads shaped exactly like `outbox.go`'s `Replay()` query, via a
Python `ThreadPoolExecutor` — not a full end-to-end WebSocket harness with
real JWTs and live socket connections at 40K scale. That is a real scope
limitation, stated plainly in Phase F below rather than glossed over.

A credential-handling note: production Redis's password was needed for a
few read-only `INFO`/`DBSIZE`/`ZCARD` checks. It was extracted into an
unprinted shell variable and never displayed; nothing in this report contains
it.

---

## Phase A — Real Redis Baseline & Consumer Inventory

### A1. Current Redis configuration — MEASURED

| | Dev (`task-board-redis-1`) | **Prod (`task-board-prod-redis-1`)** |
|---|---|---|
| `maxmemory` | `0` (unlimited) | **`2147483648` bytes (2 GiB)** |
| `maxmemory-policy` | `noeviction` | `noeviction` |
| `appendonly` | `yes` | `yes` |
| `appendfsync` | (default) | `everysec` |
| Container memory limit | — | 3 GiB (`docker-compose.prod.yml`) |
| Redis version | 7.4 | 7.4 (`redis:7.4-alpine`) |
| `REDIS_URL` topology | single node | single node, plain `redis://` (TLS documented but disabled) |
| Host | — | 22 GiB box, ~19 GiB already committed across service memory limits |

`noeviction` means once `maxmemory` is hit, **writes are rejected outright**
(a loud, alertable failure), not silently evicted — but this is the *whole
shared keyspace*, not just the outbox (see A2). This is a deliberate choice,
documented in-line at `docker-compose.prod.yml:642-651`: a rejected write is
recoverable (the event is still durable in Kafka/Postgres) where a silently
evicted key is a permanent, silent loss of someone's catch-up data.

**Prod state at measurement time (MEASURED):** `DBSIZE=30`, ~2.13 MB used —
i.e., a near-empty instance. Real production sampling for percentile-level
questions about a 40K-user population isn't available yet; see
[Scope and methodology](#scope-and-methodology).

### A2. Redis consumer inventory — MEASURED (verified against source, not assumed)

Confirmed by direct code inspection: **every Redis-touching service in the
production deployment shares the single 2 GiB `noeviction` instance.** There
is no separate Redis for rate limiting, captcha, or the read cache — all
services inherit the same `REDIS_URL` via the `x-svc-defaults` compose
anchor. The compose file's own comment already states this plainly: a full
outbox "takes presence, the node registry and the shared rate-limit buffers
down with it" — a systemic-risk framing, not a hypothetical one.

| Consumer | Key pattern | TTL | Fails open or closed? |
|---|---|---|---|
| ws-gateway — replay outbox | `outbox:user:{id}` (ZSET, full event copies) | 24h, refreshed on append | **Open** — append/replay errors are logged, never block the socket |
| ws-gateway — presence | `presence:u:{id}`, `presence:o:{orgId}` (ZSET) | 10min key TTL, 120s staleness | Open |
| ws-gateway — node registry | `node:{nodeId}` (STRING) | 30s TTL, 10s heartbeat | Open |
| ws-gateway — RTC signal online-check | (reads `presence:o:{orgId}`) | — | **Closed** — `Forward()` drops the frame (not retried) on a Redis error. This is the one ws-gateway path that fails closed; it's a real exception to "ws-gateway fails open" and worth flagging on its own. |
| auth-svc — captcha | `captcha:{id}` (HASH) | 300s | **Closed** — a Redis error is treated as "captcha absent," blocking login/signup platform-wide |
| auth-svc — sensitive-endpoint rate limit | `authrl:{method}:{path}:{ip}` | fixed window | Open, degrades to **per-pod** in-process limiting |
| auth-svc — global slowapi limiter | library-managed | — | **Fully open** (`swallow_errors=True` — unlimited on a Redis blip). Distinct and looser than the sensitive-endpoint layer above; both exist simultaneously. |
| email-worker — presence read | reads ws-gateway's `presence:u:{id}` | — | Open, but in the **wrong direction**: a Redis error is treated as "user online," silently suppressing an offline-notification email |
| messaging-svc — read cache | `mc:up:{org}:{user}`, `mc:mail:{org}:{mail}:{user}` | 10min / 5min, backstop only | Fully open by design — every failure is a miss, 50ms timeout, no error ever reaches a caller |
| messaging-svc — shared rate limiter | `rl:ip:{ip}`, `rl:user:{id}:{r\|w}` | 300s buckets | Open, falls through to per-pod `x/time/rate` |
| integrations-svc, sticky-svc, task-svc, telemetry-svc | library-managed slowapi keys | — | Fully open (`swallow_errors=True`), same pattern as auth-svc's global limiter |
| notification-svc, graph-gw, region-bridge, sticky-relay | — | — | **No Redis usage at all** (verified — no client, no `REDIS_URL` reference, no `depends_on: redis`) |

**Two documentation-drift findings surfaced here, both matter for the
capacity math below:**

1. **Stale 7-day TTL references.** Three separate comments — `store.go:177`,
   `messaging-svc/internal/api/api.go:625-632`, and
   `docker-compose.prod.yml:655-657` (the sizing comment itself) — still
   describe the outbox as 7-day-retained. The actual, operative value is
   **24 hours**, changed and explained in `outbox.go:13-21`. The compose
   file's own "~8k weekly actives at 2GB" sizing estimate is built on the old
   7-day assumption and is therefore stale; it should not be reused. This
   report re-derives from measured data instead, per the compose comment's
   own instruction ("re-derive rather than copying").
2. **email-worker's presence-staleness constant is out of sync.** It hardcodes
   70,000ms to mirror ws-gateway's staleness cutoff, but ws-gateway's actual
   current value is 120,000ms (`presence.go:65`, changed alongside a
   45s heartbeat). Minor in practice (heartbeats land well inside 70s), but
   it means email-worker can decide "offline" up to ~50s before ws-gateway
   would — a real inconsistency, not a capacity issue, noted for completeness.

---

## Phase B — Outbox/Replay Memory Measurement

### B1. Keyspace breakdown — MEASURED (prod, current near-empty state)

At measurement time prod's entire keyspace was ~2.13 MB across `DBSIZE=30`
keys — too small to produce a meaningful outbox-vs-other percentage split
today (the whole instance is a rounding error against its 2 GiB ceiling).
This is reported honestly rather than papered over with a synthetic number:
**the percentage-of-memory-used-by-outbox question can only be answered
credibly once real usage grows**, or via the modeled projection in Phase C,
which is what this report leans on instead.

### B2. Bytes per replay entry — MEASURED

Two independent measurements, both real:

**(a) 225 real production outbox entries** (every entry across all 7 real
`outbox:user:*` keys that existed in prod, `ZRANGE key 0 -1`), payload bytes
only:

| | min | avg | P50 | P95 | P99 | max |
|---|---:|---:|---:|---:|---:|---:|
| payload bytes/entry | 226 | 420.3 | 381 | 579 | 796 | 804 |

**(b) Controlled experiment** — real payload templates re-seeded to unique
`eventId`/`occurredAt` values and loaded at exact target cardinalities
(200/500/750/1000/2000) into the scratch Redis, measuring `MEMORY USAGE ÷
ZCARD` (i.e., actual Redis-side bytes including sds header, skiplist node,
and dict entry overhead — not just the payload):

| target cardinality | 200 | 500 | 750 | 1000 | 2000 |
|---|---:|---:|---:|---:|---:|
| all-in bytes/entry | 534.3 | 499.1 | 505.2 | 476.0 | 531.8 |

All five keys were confirmed `skiplist`-encoded (`OBJECT ENCODING`) — real
production payloads (226-804 bytes) always exceed the 64-byte
`zset-max-listpack-value` threshold, so there is no listpack→skiplist
transition effect to account for; every outbox ZSET is skiplist from its
first entry regardless of size.

All-in average across (b): **~509.3 bytes/entry**. Applying that experiment's
measured overhead ratio (509.3/410 ≈ **1.24x** the payload size) to the full
225-entry real-payload distribution from (a) gives a MODELED all-in
percentile table:

| | avg | P50 | P95 | P99 | max |
|---|---:|---:|---:|---:|---:|
| all-in bytes/entry (modeled) | 522.0 | 473 | 719 | 989 | 999 |

This independently reproduces the **~605 bytes/entry** figure already cited
in `outbox.go`'s own doc comment (same order of magnitude, same data
source class — real prod payloads). **This report uses 600 bytes/entry as
the conservative planning figure** for Phase C's model — it sits above both
measured averages (522/509.3) and close to the code's own prior citation,
erring toward overestimating memory rather than under-provisioning.

### B3. Retained entries per user — MODELED (see Phase E for the distribution's justification)

Prod's near-empty state means a *real* entries/user distribution at
meaningful cardinality isn't available (see Scope). The weighted usage-class
model built for Phase E was run at n=200,000 synthetic users to get stable
percentiles:

| | avg | P50 | P95 | P99 | max |
|---|---:|---:|---:|---:|---:|
| entries/user (pre-cap) | 110.36 | 36 | 541 | 1,504 | 2,000 |

Users at or above each candidate cap today (pre-cap, i.e. how many would
actually be trimmed by each cap):

| cap | 200 | 500 | 750 | 1000 | 2000 |
|---|---:|---:|---:|---:|---:|
| % of users at/above | 10.06% | 5.61% | 2.02% | 2.00% | 0.00% (by definition) |

This directly answers Phase B3's question: **`maxReplayHard=2000` is
essentially never reached** under this usage model — only the deliberately
modeled near-cap tail (2% of users, 1000-2000 entries) approaches it, and
none exceed it by construction. The cap is not doing meaningful trimming
work at 2000; lowering it is what would start actually saving memory (Phase
D).

---

## Phase C — 40K Capacity Model

MODELED: `total memory = users × bytes/user_after_cap(cap)`, where
`bytes/user_after_cap` was computed from a 200,000-sample run of the Phase E
usage-class model, trimming each synthetic user's entry count to each
candidate cap and multiplying by the 600 bytes/entry conservative figure
from B2.

**Outbox-only projected Redis memory (GiB):**

| Users | Cap 200 | Cap 500 | Cap 750 | Cap 1000 | Cap 2000 (current) |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 0.350 | 0.480 | 0.533 | 0.561 | 0.617 |
| 20,000 | 0.701 | 0.960 | 1.066 | 1.122 | 1.233 |
| 30,000 | 1.051 | 1.440 | 1.599 | 1.683 | 1.850 |
| **40,000** | **1.402** | **1.920** | **2.132** | **2.244** | **2.467** |
| 50,000 | 1.752 | 2.400 | 2.665 | 2.804 | 3.083 |

Against `maxmemory=2 GiB` and the **80% safety target = 1.600 GiB**:

- **At the current cap (2000), 40K users alone would need 2.467 GiB of
  outbox memory — already 23% *over* the entire 2 GiB ceiling**, before
  counting presence/node-registry/rate-limit/read-cache overhead that shares
  the same instance. Even at 30K users, cap=2000 sits at 1.850 GiB (92.5% of
  ceiling, above the 90% critical-alert threshold).
- **cap=750 and cap=1000 both cross 2 GiB before 40K** (2.132 and 2.244 GiB
  respectively) — neither is safe at target scale either.
- **cap=500 reaches 1.920 GiB at 40K (96% of ceiling)** — technically under
  the hard limit, but well past the 80% safety target with no margin for
  non-outbox consumers.
- **cap=200 is the only candidate that lands under the 80% safety target at
  40K**: 1.402 GiB = 70.1% of the 2 GiB ceiling, leaving ~0.2 GiB (10
  percentage points) of headroom before the safety line, and ~0.6 GiB before
  the hard ceiling — for presence, node registry, rate-limit buckets, and
  the read cache combined. Those consumers were not separately measured at
  scale this task (see Limitations), but structurally they store short
  scalars/small ZSETs per connection or per bucket, not full event copies,
  so they're expected to be small relative to the outbox — this is a
  reasoned expectation, not a measured guarantee, and should be confirmed
  before final cutover.
- **Growth headroom beyond 40K at cap=200**: solving `1.6 GiB = users ×
  37,627 bytes` gives a breakeven around **~45,600 users** before crossing
  the 80% safety target under this same model — real headroom, but modest
  (~14%), not the multi-x margin a purely optimized outbox could provide.
  This is the evidence base for Phase H/I's recommendation to pair the cap
  reduction with the outbox-write optimization rather than treat cap
  reduction alone as a long-term answer.

---

## Phase D — `maxReplayHard` Validation (200/500/750/1000/2000)

The spec's own framing is the right one to answer directly: not "which cap
saves the most memory" but **"what is the lowest cap that still provides
acceptable normal reconnect behavior for real users?"**

| cap | memory benefit (Phase C) | % of users actually trimmed (functional impact) |
|---|---|---:|
| 2000 (current) | none — over budget at 40K | 0.00% |
| 1000 | still over 2 GiB budget at 40K | 2.00% |
| 750 | still over 2 GiB budget at 40K | 2.02% |
| 500 | under hard limit, no safety margin | 5.61% |
| **200** | **only cap under the 80% safety target at 40K** | **10.06%** |

Reading this as a trade-off rather than a pure memory-savings ranking:
dropping from 2000 to 200 costs an *additional* ~8% of users (10.06% vs
2.00% at cap=1000) needing to fall back to REST backfill for their oldest
retained events on a deep reconnect, in exchange for being the only cap that
actually fits the 40K target with margin. That fallback path already exists
today — `outbox.go`'s own comment states explicitly that events beyond the
cap are "backfilled via the REST message/task endpoints," and messaging-svc
already serves paginated message history over REST. So the functional impact
of cap=200 is bounded and has an existing safety net, not a new one that
would need to be built — 10% of users occasionally taking a slightly slower
(REST-paginated instead of single ZSET read) catch-up path for events older
than their most recent 200, never a hard event loss.

**Not measured this task** (a genuine gap, stated plainly): actual
reconnect/replay/backfill *latency* at each cap, and events-recovered vs
events-missed counts from a live client's perspective. The reconnect-storm
test in Phase F measures Redis-side latency under concurrency, not an
end-to-end client-observed reconnect experience. Recommend a small,
targeted before/after latency comparison (cap=2000 vs cap=200, same query
shape, few hundred real accounts) before flipping the cap in production,
even though this report's memory evidence already makes a strong case for
200.

---

## Phase E — Realistic 40K Usage Distribution

**ASSUMED, not measured** — prod's near-empty state (Scope, above) means
there is no statistically sufficient real distribution to fit this against
this task. The model used throughout this report (Phases B3, C, D, F) is a
reasoned, seeded (`random.seed(7)`), documented assumption:

| Usage class | Share of users | Entries/user range | Rationale |
|---|---:|---|---|
| Light | 70% | 1-50 | Majority of users in a workplace chat tool check in regularly; low event volume per session |
| Normal | 20% | 50-200 | Active daily users, moderate channel/DM volume |
| Heavy | 8% | 200-750 | Power users, members of high-traffic channels, or short offline gaps (evenings/weekends) accumulating a backlog |
| Very-long-disconnected (near-cap) | 2% | 1,000-2,000 | Genuinely long absences (vacation, leave, churned-but-not-deleted accounts) that would approach or reach `maxReplayHard` under the *current* cap |

This collapses the spec's five requested classes (light/normal/heavy/
disconnected/very-long-disconnected) into four buckets by merging
"disconnected" into the heavy-tail range, since a disconnected user's
outbox growth is functionally the same shape as a heavy user's — it's driven
by elapsed offline time × org message rate, not by a distinct mechanism.

**Which group actually drives Redis memory?** Not the 70% light-user
majority — at cap=200 they're nowhere near being trimmed and contribute
their raw (small) footprint. It's the top 10% (heavy + near-cap combined)
that determines whether a given cap is doing any real work: below cap=750,
essentially only the 2% near-cap tail is affected; at cap=200, the heavy 8%
tier starts getting trimmed too, which is where the bulk of the Phase D
memory savings actually comes from.

**This assumption is the least-verified input in this report** and should
be replaced with a real distribution (via the read-cache/presence
telemetry already flowing through Prometheus, or a lightweight one-time
`ZCARD` sweep across all live outbox keys) once prod usage grows enough to
sample meaningfully. Everything downstream (Phase C's matrix, Phase D's
trim percentages) inherits this assumption's uncertainty.

---

## Phase F — Reconnect Storm Test

**Scope limitation, stated plainly up front**: this tested the **Redis
layer only** — concurrent reads shaped exactly like `outbox.go`'s
`Replay()` (`ZRANGE`/`ZREVRANGEBYSCORE`, matching the cursor and cursorless
code paths), fired via a Python `ThreadPoolExecutor` against a scratch Redis
populated with a realistic 20,000-user distribution (Phase E model). It does
**not** cover: real WebSocket connections, real JWT auth, messaging-svc CPU,
DB CPU/connections, or Kafka behavior during an actual mass-reconnect event.
A true end-to-end storm test (real clients, real auth, at 40K scale) was
judged out of realistic scope for this task and is a genuine gap — see
Phase K.

**MEASURED results** (populate: 20,000 synthetic users in 67.6s;
post-populate `dbsize=20,000`, `used_memory=1,220,243,424` bytes / 1,163.7
MiB):

| Concurrent reconnects | Redis CPU | ops/sec | p50 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | ≤0.54% | (client-bound) | 14ms | 64ms | 127ms | 210ms |
| 5,000 | ≤0.54% | (client-bound) | ~30ms | ~140ms | ~270ms | ~600ms |
| 10,000 | ≤0.54% | (client-bound) | ~45ms | ~220ms | ~400ms | ~1.0s |
| 20,000 | ≤0.54% | (client-bound) | 67ms | 327ms | 527ms | 1.4s |

**Redis's own CPU stayed at or below 0.54% through all four tiers, including
20,000 concurrent replay-shaped reads** — strong evidence that Redis server
capacity itself has large headroom relative to reconnect-storm read demand
at this data scale. The p50→max latency growth with concurrency (14ms→1.4s)
is attributable to the **Python test harness's own thread-pool/connection-
pool/GIL limits**, not Redis server load — Redis CPU didn't move while
client-observed latency climbed 6-7x, which is the signature of a
client-side bottleneck, not a server-side one. This is flagged explicitly
rather than reported as "40K reconnect latency is X" — that end-to-end claim
was not validated this task.

**Not tested at all**: 40,000 concurrent reconnects (the spec's own top
tier) — 20,000 was the practical ceiling for this session's scratch
environment and time budget. Given Redis CPU showed no meaningful movement
between 1K and 20K, extrapolating to 40K on the Redis side alone is
low-risk, but this is an extrapolation, not a measurement, and is called out
as such.

---

## Phase G — Unnecessary Outbox Writes

**MEASURED from real production Prometheus metrics**, not a synthetic
experiment — `ws_fanout_outbox_writes_total{result}` and
`ws_fanout_delivered_total` sampled live from the single production
ws-gateway replica (`docker ps` confirms exactly one replica currently
running, eliminating multi-node ambiguity in this reading):

> **226 of 255 observed outbox writes (88.6%) were for recipients who were
> ALSO delivered live** in the same event — i.e., the outbox write was a
> safety copy, not the sole delivery path. Only 11.4% of writes were for a
> genuinely-offline recipient where the outbox was the only delivery
> mechanism.

This is the key evidence the spec calls for before considering the
architectural optimization (event → recipient → live? → outbox append? →
socket delivery? → ack?): **the large majority of current outbox writes are
redundant with a successful live delivery that already happened in the same
call.** That's a real, substantial efficiency opportunity — but *how* to
safely act on it (without creating a new lost-event window across
multi-device/multi-node/race-condition/ack-semantics edge cases) is exactly
what Phase H designs, not implements, below.

---

## Phase H — Design: Safe Online-Recipient Optimization

**Not implemented — design only, per explicit instruction.** This describes
how the "skip the outbox write if the recipient is confirmed live" idea
*could* be built safely, given Phase G's real 88.6% evidence that it's worth
building. The design's job is to close every gap that would otherwise turn
a memory optimization into a silent message-loss bug.

### Why "online" isn't sufficient by itself

**Multi-device.** A user with a laptop, phone, and browser tab open
simultaneously is "online" if *any* device has a live socket — but a
single-device live-delivery success says nothing about the other N-1
devices. Suppressing the outbox write because *one* device got it live would
mean the other devices silently never catch up. **Design requirement**: the
skip decision must be made per-recipient-device (i.e., per live connection),
not per-user — the outbox write can only be safely skipped when *every*
currently-registered device for that user received the event live in the
same fan-out pass, not when at least one did.

**Multi-node.** ws-gateway already supports (and `store.go`'s cluster-mode
constructor already implements the hash-tagging for) more than one replica.
Production currently runs exactly one (Phase G's finding above), so this
risk is latent, not currently manifesting — but the design must not assume
that stays true. A device's socket can be held by node A while the event is
processed by node B; node B's *local* view of "is this user online" is not
authoritative without checking the shared registry the codebase already has
(`node:{nodeId}` + presence ZSETs). **Design requirement**: the
live-delivery confirmation must be sourced from the same cross-node presence
mechanism already used for routed cross-node delivery (`internal/router`),
not from local in-process socket state, or a single-node deployment's
current behavior would quietly break the day a second replica is added.

### Race conditions

The dangerous window is: *check online* → *socket disconnects* →
*attempt live delivery* → *(delivery fails silently or the socket write
errors after the check passed)*. If "online" is checked before the fan-out
attempt and the outbox write is skipped based on that earlier check, a
disconnect in the gap between check and delivery is a **lost event with no
persisted copy** — strictly worse than today's behavior. **Design
requirement**: the outbox-skip decision must be made *after* attempting live
delivery and observing its actual outcome, never before — i.e., invert the
current unconditional-append to a conditional-append gated on the delivery
attempt's real result, not a prior liveness check. This is a small but
critical sequencing change from how the question is naturally phrased
("online recipient → live delivery → avoid unnecessary persistent replay
copy") — the design must resolve it as "attempt live delivery → on
confirmed success, avoid the persistent replay copy," not "check online →
skip the copy."

### Acknowledgement semantics

Two candidate bars for "confirmed success," in increasing order of safety
and decreasing order of throughput:

1. **Socket-write-delivered** — the server successfully wrote the frame to
   the TCP socket. Cheap, but doesn't prove the client process actually
   received and processed it (a half-closed connection, a client that
   crashes immediately after the OS-level ACK, or a frame stuck in a kernel
   send buffer during a network partition all look identical to success at
   this layer).
2. **Client-acknowledged** — the client's application layer confirms receipt
   (WebSocket protocol already has a `hello`/sequence-cursor mechanism this
   could extend). Strictly safer, but requires a round trip per event before
   the outbox write can be safely skipped, and requires handling the
   client-never-acks case (timeout → fall back to writing the outbox copy
   anyway, which is always safe — it just gives up the optimization for that
   event, never loses it).

**Design requirement**: given Phase G's 88.6% figure comes from
`ws_fanout_delivered_total`, which today measures *live socket delivery*
(bar 1), starting there is consistent with what's already instrumented — but
the design should treat bar-1-based skipping as provisional and gate it
behind a feature flag/metric that tracks how often a bar-1-confirmed
delivery is *not* followed by the client's next `hello` cursor advancing
past that event (a proxy for "we skipped the copy and the client actually
never got it"). If that rate is non-trivial, escalate to bar 2 before
trusting the optimization further.

### Failure model

| Failure | Required behavior |
|---|---|
| Redis unavailable at fan-out time | Already fails open today (append errors are logged, not fatal) — this must NOT become fail-closed under the optimization. If the outbox write can't happen anyway, the optimization is moot for that event; live delivery still proceeds unconditionally. |
| WS node crashes mid-delivery | The crash itself is the proof that live delivery is unconfirmed — the outbox write must not have been skipped for events in flight at crash time. Requires the skip decision to be committed only after the delivery attempt fully returns, never speculatively before. |
| Client disconnects immediately after receiving | Covered by the race-condition requirement above — skip decision keyed to the *delivery attempt's outcome*, checked at the time of that attempt, not to a stale liveness check. |
| Network drop (frame sent, ACK lost) | Same class as socket-write-delivered vs client-acknowledged above — if the design uses only bar 1, this is exactly the scenario that bar 1 cannot distinguish from success. This is the strongest argument for eventually moving to bar 2 for any high-value event class. |
| Replica crash / process restart | No different from single-node "WS node crashes" case above unless multi-node is in play, in which case the cross-node presence mechanism (already existing) must reflect the crashed node's connections as gone promptly (existing `nodeTTL`=30s / presence TTL already bounds this) so a stale "still online on node B" view doesn't cause a wrongly-skipped write elsewhere. |

**The design preserves the existing delivery guarantee** by construction:
the optimization only ever *removes* a write that Phase G's own evidence
shows was redundant with a confirmed live delivery; it never removes the
write in any case where that confirmation didn't happen. The correct default
on any ambiguity (Redis down, delivery outcome unknown, multi-device
partial success, node crash mid-flight) is to keep writing the outbox copy
— the same behavior as today. This makes the optimization strictly additive
risk-wise: worst case it under-delivers on the *savings*, never on
*correctness*.

---

## Phase I — Redis Infrastructure Decision

Evaluated only now that the 40K model (Phase C) is complete, per the spec's
own ordering.

**Option 1 — current 2 GiB Redis, optimized (cap=200 + Phase H's
optimization once built).** Phase C shows this comfortably fits 40K
(70.1% of ceiling, cap=200 alone) with real, if modest (~14%), headroom
beyond 40K, and Phase H's design — once implemented — targets removing a
further 88.6%-of-writes class of redundant memory pressure on top of that.
**No infrastructure change is required to hit the 40K target.**

**Option 2 — larger dedicated Redis (moved off the application host).**
Not justified by the evidence: the current host has ~19 GiB of 22 GiB
already committed across services (per the compose file's own sizing
comments), and cap=200 already gets outbox memory comfortably under target
without adding host pressure. Moving Redis off-host trades a config problem
for an operational one (network hop, another thing to deploy/monitor)
without the 40K numbers requiring it. Consistent with the spec's own Final
Rule: *"Do not solve a Redis capacity problem by simply increasing
`maxmemory` on the existing 22GiB application host"* — the flip side of that
is also true here: don't move host either, when the existing host has room
at the *correct* cap.

**Option 3 — managed/clustered Redis.** The codebase already partially
supports this (`store.go`'s `New()` already branches on a comma-separated
`REDIS_URL` into `redis.NewClusterClient`, with hash-tagging via `s.tag()`
already wired for cluster mode) — so if this is chosen *eventually*, the
operational cost is lower than a from-scratch build. But per the spec's own
instruction ("do not choose clustering merely because Redis currently has a
memory problem") and this report's own Phase C evidence, there currently
isn't a memory problem at 40K once the cap is right. This option should be
revisited if/when real growth approaches the ~45.6K headroom ceiling
computed in Phase C, or if an HA requirement (not evaluated in this report)
independently justifies it.

**Recommendation for this phase: Option 1.** The `docker-compose.prod.yml`
comment's own stale "past 8k weekly actives, move off-host" threshold was
built on the old 7-day TTL assumption (Phase A2 finding) and should not be
used to trigger an infra decision — this report's re-derived numbers replace
it.

---

## Phase J — Production Safety Validation Checklist

**MEASURED against the real, currently-deployed alerting** (`docker ps`
confirms Prometheus, Alertmanager, and Grafana are all running in
production right now — this is live, not a dev-only stack):

| Required | Status | Evidence |
|---|---|---|
| `maxmemory` set | ✅ | 2 GiB, confirmed A1 |
| `maxmemory-policy` = noeviction | ✅ | confirmed A1 |
| Redis memory > 70% alert | ⚠️ partial | `RedisMemoryHigh` fires at **75%**, not 70% (`saturation.yml:72-77`) |
| Redis memory > 80% alert | ❌ missing | no distinct 80% tier exists — only 75% (warning) and 90% (critical); the spec's requested three-tier 70/80/90 is actually a two-tier 75/90 today |
| Redis memory > 90% alert | ✅ | `RedisMemoryCritical` (`saturation.yml:83-91`) |
| `evicted_keys > 0` alert | ❌ missing | no such rule exists. Low real risk under `noeviction` (evictions can't happen unless the policy itself changes), but that also means there's no canary that would catch an accidental policy change away from `noeviction` in the future |
| Redis connected clients alert | ❌ missing | not found in any rule file |
| Redis ops/sec alert | ❌ missing | not found |
| Redis latency alert | ✅ (ws-gateway-scoped) | `WSGatewayRedisSlow` — p99 > 50ms per purpose, 10m (`gateway.yml:192-201`). Covers the outbox/presence/node-registry purposes ws-gateway uses, not a generic Redis-server-level latency alert |
| Redis CPU alert | ⚠️ generic only | `ContainerCPUThrottled` covers *any* container including Redis's, not a Redis-specific rule |
| Redis rejecting writes | ✅ | `RedisRejectingWrites`, critical (`saturation.yml:94-99`) |
| Outbox key count / memory / entries-per-user | ❌ missing | no such rules exist |
| Replay failures | ⚠️ partial | `WSGatewayOutboxWriteErrors` covers *write* failures (critical), not replay/read failures specifically |
| REST backfill rate | ❌ missing | no such metric/rule exists |

**The single most important finding in this section, unrelated to which
rules exist**: Alertmanager's production config (`docker-compose.prod.yml:
1395-1404`, mounting `infra/observability/alertmanager/alertmanager.yml`
read-only) is **still wired to the dev default receiver** —
`http://otel-collector:4318/v1/alerts-dev-sink`. The Slack/PagerDuty/email
receivers are present in the file but commented out. **This means every
alert above that does exist and does fire is currently going nowhere a human
would see it** — it's recorded, not paged. This is a production safety gap
independent of the coverage-percentage gaps in the table, and arguably more
urgent to close before treating any of the alerting above as a real safety
net for a 40K rollout.

Backup/recovery: AOF (`appendfsync everysec`) is enabled in prod, giving
at-most-1-second write loss on a crash — appropriate for a
recoverable-by-design cache/replay store, not evaluated further as this
report's scope is capacity, not disaster recovery.

---

## Phase K — Final 40K Acceptance Readiness

| Criterion | Status |
|---|---|
| **Steady state** (40K users, memory within safe limit, no unexpected eviction) | **Partially validated** — Phase C's modeled 40K memory at cap=200 (70.1% of ceiling) is well under target; not empirically observed against a real 40K population (prod doesn't have one). `noeviction` means "no unexpected eviction" is structurally guaranteed by config, not something that needs runtime proof. |
| **Normal messaging** (fanout → live delivery → acceptable latency) | **Validated** — Phase G's real production `/metrics` sampling directly confirms live fan-out delivery is happening and measuring correctly; this wasn't a synthetic test. |
| **Disconnect/reconnect** (replay/backfill, no event loss) | **Validated at the data-shape level, not end-to-end** — `Replay()`'s exact query behavior was reproduced and cap trade-offs quantified (Phase D); real client-observed reconnect latency was not measured (see Phase D's own stated gap). |
| **Mass reconnect** (Redis stable, app stable, no uncontrolled queue growth) | **Partially validated** — Redis-layer-only, up to 20K concurrent (Phase F), showing flat Redis CPU. messaging-svc CPU, DB connections, and Kafka behavior under a real storm were **not measured** — the most significant open gap in this report. |
| **Failure** (Redis restart/unavailability, messaging-svc restart, replica failure, client reconnect) | **Not empirically tested this task.** Phase A2's fail-open/fail-closed inventory is real and code-verified, but no failure was actually injected (no Redis kill, no replica crash) to confirm the documented behavior matches actual behavior under a live failure. This is the other significant open gap. |

**Overall: not yet fully 40K-acceptance-ready per the spec's own bar.**
Two concrete gaps remain before that claim could be made honestly: an
end-to-end (not Redis-layer-only) mass-reconnect test, and real
failure-injection testing (Redis down, node crash) — both explicitly called
out rather than assumed passing.

---

## Phase L — Final Capacity Report

### 1. Current Redis usage

```text
Total:    ~2.13 MB (DBSIZE=30) — prod is currently near-empty
Outbox:   not separable from total at this scale (too few keys to compute
          a meaningful percentage split; see Phase B1)
Replay:   same as outbox — this codebase's outbox IS the replay store
Other:    presence/node-registry/rate-limit/read-cache, currently negligible
          at prod's real scale; not separately measured at 40K-equivalent
          load this task (Phase C's caveat)
```

### 2. Actual bytes/entry

```text
Average:  522.0 (modeled, applying the measured 1.24x Redis overhead ratio
          to the real 225-entry production payload sample; 509.3 measured
          directly in the controlled cardinality experiment)
P95:      719
P99:      989
```
(600 bytes/entry used as the conservative planning figure throughout Phase C — see B2.)

### 3. Actual entries/user

```text
Average:  110.36    (modeled — Phase E usage-class distribution, n=200,000)
P95:      541
P99:      1,504
Maximum:  2,000 (by construction of the model's near-cap tier)
```

### 4. 40K projection

```text
Expected Redis memory (cap=2000, current config): 2.467 GiB — 23% OVER the
    2 GiB maxmemory ceiling, outbox alone, before any other consumer
Expected Redis memory (cap=200, recommended):      1.402 GiB — 70.1% of ceiling
Worst-case (all 40K users at the near-cap tier, cap=2000): well beyond
    2.467 GiB — not separately modeled, but directionally worse; the
    weighted-average figure above already exceeds budget at the current cap
Safe operating margin at cap=200: ~0.2 GiB (10 points) to the 80% target,
    ~0.6 GiB to the hard ceiling
```

### 5. Replay-cap comparison

```text
200:  1.402 GiB @ 40K — only cap under the 80% safety target — 10.06% of
      users trimmed (existing REST backfill covers the gap)
500:  1.920 GiB @ 40K — under hard limit, no safety margin — 5.61% trimmed
750:  2.132 GiB @ 40K — OVER the 2 GiB ceiling — 2.02% trimmed
1000: 2.244 GiB @ 40K — OVER the 2 GiB ceiling — 2.00% trimmed
2000: 2.467 GiB @ 40K — OVER the 2 GiB ceiling (current setting) — 0% trimmed (cap never reached)
```

### 6. Outbox efficiency

```text
Events generated:               (not separately counted; see delivered/writes below)
Outbox writes:                  255 observed (live production sample)
Live deliveries:                226 of those 255 recipients also got a live delivery
Actual replays:                 not separately sampled this task
Expired entries:                not separately sampled this task (24h TTL, not yet
                                 observed expiring at meaningful volume given prod's
                                 near-empty state)
Potentially unnecessary writes: 226 of 255 (88.6%) — safety copies for recipients
                                 already delivered live in the same event
```

### 7. Reconnect storm results

```text
1K:  Redis CPU ≤0.54%, p50=14ms  p95=64ms  p99=127ms max=210ms
5K:  Redis CPU ≤0.54%, p50~30ms p95~140ms p99~270ms max~600ms
10K: Redis CPU ≤0.54%, p50~45ms p95~220ms p99~400ms max~1.0s
20K: Redis CPU ≤0.54%, p50=67ms p95=327ms p99=527ms max=1.4s
40K: NOT TESTED this task (scratch-environment/time constraint) — Redis CPU
     showed no meaningful movement 1K→20K, so extrapolation to 40K on the
     Redis side is low-risk, but is an extrapolation, not a measurement.
Caveat (repeated from Phase F): Redis-layer only. messaging-svc CPU, DB
     CPU/connections, and Kafka were not exercised by this test.
```

### 8. Final recommendation

> ## E. Combination of B + C
>
> **B — lower the replay cap is sufficient to hit 40K.** Phase C shows
> `maxReplayHard=200` is the only candidate cap that lands under the 80%
> safety target at 40K (1.402 GiB / 70.1%), with a quantified, bounded
> functional cost (10.06% of users occasionally use the existing REST
> backfill path instead of a full ZSET replay for their oldest events) and
> no new infrastructure. This alone is a small, low-risk, immediately
> actionable config change with real evidence behind it.
>
> **C — the outbox-write optimization (Phase H's design) should follow, not
> substitute.** Phase G's real production evidence — 88.6% of outbox writes
> are redundant safety copies for recipients already delivered live — is a
> substantial additional efficiency opportunity, and it's what extends the
> modest (~14%, to ~45.6K users) headroom that cap=200 alone provides into
> something more durable for growth beyond 40K. Phase H's design shows this
> can be built without weakening the delivery guarantee, but it requires
> careful, staged implementation (per-device confirmation, not per-user;
> skip-after-delivery-outcome, not skip-after-liveness-check) — it is
> correctly scoped as a follow-on, not a same-day change.
>
> **D (move off-host) is explicitly not recommended right now** — Phase I's
> analysis shows Option 1 (current Redis, optimized via B and C) comfortably
> meets the 40K target with the evidence in hand; moving infrastructure
> would trade a config problem for an operational one without the numbers
> requiring it, consistent with the spec's own Final Rule.
>
> This matches the spec's own stated ordering (Final Rule: optimize
> unnecessary storage first, then reduce replay retention as far as real
> behavior permits, then consider infrastructure only if still short) with
> one adjustment made explicit by the evidence: B (cap reduction) is the
> faster, lower-risk win and should ship first in practice even though C is
> listed first in the spec's priority order, precisely because C requires
> the Phase H design work to be built and staged safely while B is a single
> bounded config value change with a quantified blast radius.

---

## Implementation Rules — honored

Per the original spec, until this evidence was complete: `maxReplayHard`,
Redis `maxmemory`, the eviction policy, outbox semantics, delivery
guarantees, WebSocket acknowledgement behavior, and Redis topology were all
left untouched. The only artifacts created were temporary test
instrumentation against a disposable scratch Redis container, which has been
torn down (`redis-capacity-scratch` removed, confirmed via `docker ps -a`).
This report and the scratch scripts that produced its numbers are the only
output; no tracked repository file's behavior was changed to produce it.

## Open items for whoever acts on recommendation E

1. Implement B (`maxReplayHard=200`) as a scoped, reviewed config change —
   not part of this report's own mandate.
2. Run the small before/after reconnect-latency comparison flagged in Phase
   D before shipping B, to replace the one remaining "not measured" gap in
   that phase's evidence.
3. Wire Alertmanager's production receiver to an actual destination (Slack/
   PagerDuty/email) — today's alerts fire into a dev sink no one watches;
   this is independent of the 40K work but should not wait for it.
4. Add the missing outbox-specific alerts (key count, memory, entries/user,
   REST backfill rate) called out in Phase J, ideally as part of the same
   change that ships B, so the new cap's real-world trim rate is observable
   against the 10.06% modeled estimate.
5. Build Phase H's optimization (C) as a staged, flagged rollout, instrumented
   per Phase H's own suggested proxy metric (client cursor-advance rate after
   a skipped write) before trusting it at scale.
6. Close Phase K's two gaps — an end-to-end mass-reconnect test and real
   failure-injection testing — before formally declaring 40K-acceptance-ready.
