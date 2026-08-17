# BlissWork optimization prompts for Claude Code

**Refreshed 2026-08-17 against branch `VPS-Shristi`.**

Prompts for the work that is **actually outstanding**, written against real
paths and the real deployment. Numbering matches the phases in
`QUICK_START_OPTIMIZATION.md`; the evidence is in `BOTTLENECK_ANALYSIS.md`.

> **Why this file shrank from 1,458 lines to this.** The previous version
> contained 17 prompts generated from a stale snapshot of the repo. Nine
> described work that had already shipped — OTEL, Prometheus, log aggregation,
> PgBouncer, partitioning, the outbox/idempotency pattern, CDN cache headers,
> the Helm chart, ws-gateway scaling. Handing those to Claude Code would have
> produced a second, worse implementation of a working system.
>
> The rest were scoped for infrastructure that does not exist: 30 Postgres
> shards, 30 Kafka brokers across three regions, nine-node Redis Cluster,
> MirrorMaker2, Route 53 geo-routing — against a stack that runs on **one VPS
> under docker-compose**. One prompt specified a k6 run with 50 million virtual
> users, which cannot be executed on any hardware.
>
> Retired prompts are listed at the bottom with the reason, so nobody
> reintroduces them.

## Before using any prompt here

Point Claude Code at `Bliss-Work/INFRASTRUCTURE.md` first. It is the source of
truth for what has landed and it explains the *reasoning* behind constraints
that look arbitrary — why PgBouncer is Kubernetes-only, why LiveKit runs
host-networked and single-node, why `WS_ADVERTISE_ADDR` matters in both fan-out
modes. Prompts that ignore those notes produce changes that get reverted.

---

## 1.1 — Add a read cache

**Status:** not started · **Impact:** highest available per unit of work

```
BlissWork has no read cache anywhere in the platform. Redis currently serves
only presence, the replay outbox, the node registry and rate-limit buckets, so
every channel list, message page, inbox render and profile lookup goes to the
single Postgres primary.

Add a read cache for exactly two entities to start:

1. Channel rosters (messaging-svc)
2. user_projection (the per-user denormalised row read on nearly every render)

Requirements:

- Cache in the service that OWNS the entity. Do not add a cross-service
  invalidation bus — at two keys that is ceremony, and no two services cache
  the same entity yet.
- Invalidate synchronously on write, in the same code path as the mutation.
  A roster changes on member add/remove; user_projection changes on profile
  and membership updates.
- TTL is a backstop, not the mechanism: set it in the low seconds so a missed
  invalidation self-heals fast.
- Key format: {service}:{entity}:{id}:v{n}. Include the version segment so a
  schema change can invalidate wholesale by bumping n.
- Cache MISS must be indistinguishable from a cache-disabled deployment.
  Gate on an env var (READ_CACHE_ENABLED, default off) so this can ship dark
  and be flipped per environment, matching how stages 3-5 ship.
- Fail open. A Redis error is a cache miss and a metric, never a 500 — Redis
  in this deployment is already the thing most likely to be full.

DO NOT cache the inbox paths. They are read-after-write: a user must see the
message they just sent. That is precisely why those reads were deliberately
kept OFF the read replica (see messaging-svc/cmd/server/main.go:101). A cache
there reintroduces the bug the replica work avoided.

Metrics: hit/miss counters per entity and a hit-ratio recording rule alongside
the existing ones in infra/observability/prometheus/rules/.

Redis is at maxmemory 2gb with noeviction, and the replay outbox is already
sized in weekly actives against that budget. State in your summary how much
memory the cache adds at 10k DAU, and whether that fits.
```

---

## 1.2 — Split the frontend bundle

**Status:** not started · **Impact:** the only item users feel directly

```
The BlissWork production build ships as ONE 1.45 MB chunk. Verify before
changing anything:

  cd Bliss-Work && npm run build --workspace @taskboard/web
  ls -la apps/web/dist/assets/

Current output: index-*.js at 1,485,567 bytes containing all 30 routes, the
LiveKit call UI and the integrations hub; exceljs at 940 KB is the ONLY lazy
chunk in the app (lib/xlsx/workbook.ts, behind Export Tasks).

packages/app/src/App.tsx statically imports all 30 routes from ./routes/.
apps/web/vite.config.ts has no manualChunks.

Do:

1. Route-level React.lazy + Suspense for the authenticated routes in App.tsx.
   Keep the pre-auth routes (Login, Onboarding, InviteAccept, ForgotPassword,
   ResetPassword, VerifyEmail) in the main chunk — they are the first paint and
   lazy-loading them adds a round trip to the critical path.

2. Split the heavy features that are not on the common path: the call UI
   (CallRoom, CallControls, ScreenSharePopup, JoinCallView, Meetings — these
   pull LiveKit), Integrations, and Search.

3. manualChunks in vite.config.ts: a stable vendor chunk for react, react-dom
   and react-router-dom so a deploy does not invalidate it.

4. Reuse the existing chunk-load failure handling. packages/app/src/lib/
   chunkReloadRecovery.ts ALREADY exists for exactly this: when a deploy
   removes a chunk a newer build no longer has, the dynamic import 404s. It was
   written for the exceljs import. Every new lazy boundary must be covered by
   it — this is the one way route splitting breaks in production, and the fix
   is already in the tree.

5. Size budget in CI (Bliss-Work/.github/workflows/ci.yml): fail if the entry
   chunk exceeds a threshold you set from the post-split measurement. Do not
   invent a target from a blog post; measure, then set the budget just above it.

Report before/after byte sizes for the entry chunk from a real build.

Note: INFRASTRUCTURE.md:140 currently claims "the Vite build already splits by
route" and excludes frontend work on that basis. It does not split by route.
Correct that line as part of this change.
```

---

## 2.1 — Kafka off the bundled broker

**Status:** not started · **Impact:** durability · **Application work: none**

```
BlissWork runs a single Kafka container at RF=1 (infra/kafka/create-topics.sh:22,
RF="${REPLICATION_FACTOR:-1}"). In-flight events are lost on broker restart.

The client-side work is DONE — do not redo it. SASL_SSL is wired at all 17
client call sites across 8 services (Go via internal/kafkaauth, Python via
app/kafka_security.py), producers use acks=all, and min.insync.replicas is
derived from RF.

This task is provisioning plus configuration:

1. Document what a managed 3-broker cluster needs from this stack: the SASL
   mechanism and credentials the existing clients expect, the TLS trust chain,
   and which env vars carry them (they already exist — find them, do not add
   new ones).
2. Set REPLICATION_FACTOR=3 and re-run infra/kafka/create-topics.sh. Confirm
   min.insync.replicas lands at 2 for RF=3.
3. Size NOTIFICATION_PARTITIONS. The script already supports it separately from
   the baseline count. Notifications are the highest-fan-out topic; partitions
   can be increased online but NEVER decreased, so size up front.
4. Write the cutover: this is a live system, so the sequence and the rollback
   both matter. Migrating topics between clusters is not a config flip.
5. Update .env.prod.example and the Helm values with the new settings and a
   note on which is authoritative for which deployment path.

Do not add brokers to docker-compose.prod.yml. A three-broker cluster on one VPS
provides no additional durability — it shares a disk and a kernel with the thing
it is supposed to survive.
```

---

## 2.2 — Batch the remaining Python consumers

**Status: DONE 2026-08-17.** Three consumers batched; 516 unit tests green
(telemetry-svc 58, task-svc 139, integrations-svc 319).

Two corrections to what this prompt originally said:

- **It was three services, not four.** `email-worker` already batched, in both
  of its consumers — `relay_consumer.py:190` and `worker.py:141`, each
  `getmany(timeout_ms=1000, max_records=100)`. It was listed here in error.
- **The two shapes are not the same change**, and this is the part worth
  keeping. telemetry-svc writes a row for nearly every event it sees, so
  batching means merging transactions — and that makes a failure cost 200
  events instead of 1 unless the loop rewinds, so it seeks back to the batch's
  first offset on failure. task-svc and integrations-svc act on a handful of
  event types but still paid a synchronous offset commit per ignored message;
  there the win is the acknowledgement, their handlers keep their own
  transactions, and a failure still costs exactly one event. Batching what the
  workload actually wastes is the point; applying one template to all three
  would have been a correctness regression in two of them.

Also found: `consumed_events.event_id` is a `uuid` column, so an eventId that
was not a UUID raised a DataError that never committed — a poison message that
blocked its own partition indefinitely. Skipped now.

**Verified against a real Postgres 17.10** (scratch container, isolated from the
running prod stack; removed afterwards):

- telemetry-svc integration suite: **16 passed**, migrations applied clean
- integrations-svc integration suite: **37 passed**
- task-svc: no integration suite exists (139 unit tests, 0 integration)
- `_claim_many` exercised directly through the real asyncpg path — 7 checks:
  list-of-strings binding to `CAST(:eids AS uuid[])`, `ON CONFLICT DO NOTHING`
  returning only genuinely-inserted rows, full redelivery claiming nothing,
  partial overlap claiming only the new id, `DISTINCT` collapsing an in-batch
  duplicate, a 200-id batch, and durability of the write.

<details>
<summary>Original prompt</summary>

```
Four Python consumers in BlissWork still process strictly one message at a time
— fetch, DB transaction, synchronous offset commit:

  services/task-svc/app/consumer.py
  services/telemetry-svc/app/consumer.py
  services/email-worker/app/relay_consumer.py
  services/integrations-svc/app/org_consumer.py

notification-svc was already fixed and is the model. Read
services/notification-svc/internal/consumer/consumer.go first — including its
comments, which explain why it batches at 200 messages / 25 ms linger and how
it preserves guarantees. Copy that shape.

The guarantees that must survive batching:

- Offsets follow the transaction. The offset commit happens after the DB commit,
  never before, so a crash redelivers rather than silently drops.
- Redelivery stays idempotent via the existing event_id dedup.
- A poison message is skipped OUT of the batch, not allowed to fail the batch.
  Getting this wrong converts one bad event into a stalled consumer group.

Each service has an existing test for startup and offset behaviour
(test_outbox_kafka_startup.py and siblings) — extend rather than replace, and
add a test that a poison message in the middle of a batch does not take the
other 199 with it.

email-worker is the one to be careful with: its offset must not advance
mid-SMTP-send, which is a stronger constraint than the others have. Its current
comment at relay_consumer.py:132 explains why. Batch it last, or leave it and
say so.
```

</details>

---

## 3.1 — Enable routed delivery and the pod metric

**Status:** built, off by default · **Nothing here has run under load**

```
BlissWork ws-gateway has routed delivery built and disabled. Enabling it is a
rollout, not a code change — the work is the sequence and the verification.

ORDER IS NOT NEGOTIABLE:

1. Stage 3 (routed fan-out) BEFORE Stage 4 (Redis cluster). Classic Redis
   pub/sub is delivered to every node of a cluster whatever the channel name
   hashes to, so clustering a broadcast workload divides none of the work. See
   INFRASTRUCTURE.md Stage 4 and Stage 7.

Produce a rollout plan covering:

- Enabling WS_FANOUT_MODE=routed plus WS_ADVERTISE_ADDR. Note that
  WS_ADVERTISE_ADDR now matters in BOTH modes and node registration is
  unconditional — a multi-pod fleet without it cannot connect a call between
  two users on different pods.
- Flipping gateways one at a time. Both paths may run simultaneously: delivery
  is idempotent and clients dedupe on eventId, so there is no flag day.
- What to watch during the flip. The metrics already exist: the fan-out
  amplification pair (ws_fanout_discarded_total / ws_fanout_recipients_total),
  ws:route_cache:hit_ratio, connection rejections split by cap, and the rules in
  infra/observability/prometheus/rules/gateway.yml.
- The rollback, and what makes it safe.

Separately, and in the SAME change:

The ws-gateway HPA has min 3 / max 60 in deploy/helm/taskboard/values.yaml, but
the autoscaler still scales on CPU. A WebSocket is connection-bound, not
CPU-bound — it costs memory and two goroutines and almost no CPU while idle. So
the fleet sits at min while pods fill and start refusing connections, and the
ceiling of 60 is unreachable.

Enable the podMetric block so scaling tracks socket count. The values file
documents this at line 169. Raising the ceiling and giving the autoscaler a
metric that tracks sockets are ONE change — shipping either alone accomplishes
nothing.
```

---

## 4.1 — Build a load-test suite

**Status:** not started · **Impact:** turns the capacity numbers into facts

```
BlissWork has no load testing of any kind — no k6, locust or JMeter in the tree.
Stages 3-6 of the scaling work are tested against fakes, and the Redis cluster
path has never met a cluster. Every capacity number in INFRASTRUCTURE.md,
BOTTLENECK_ANALYSIS.md and QUICK_START_OPTIMIZATION.md is arithmetic.

Build a k6 suite that targets the ceilings this stack actually claims:

  Compose, one VPS, Stage 11 Redis sizing:  ~10k DAU comfortable, ~50k ceiling
  Helm, managed data tier, hatches on:      ~300k DAU comfortable, ~1M ceiling

Scenarios, weighted to real usage rather than evenly:

  - Inbox read (keyset pagination) — the dominant read
  - Channel list and message page — the paths a read cache would serve
  - Message send — the write that fans out
  - WebSocket connect, hold, receive — the connection-bound tier
  - Login — sized for peak sign-in, not steady DAU

What this suite must answer, because these are the open questions:

1. Does routed fan-out actually reduce per-pod load as the fleet grows? Compare
   WS_FANOUT_MODE=broadcast against routed at 2+ gateway pods. This is the
   central claim of the entire staged rewrite and it has never been measured.
2. Where does Redis memory actually land per weekly-active user? The 700 B/member
   outbox figure is the assumption most likely to be wrong, and the whole
   capacity table rests on it. Measure with INFO memory and ZCARD on live outbox
   keys.
3. What is the real read/write ratio on the paths prompt 1.1 caches? That sets
   the cache's actual value.

Scale to hardware you have. Ramp, sustain, ramp down; run it against staging,
never production. Record results as a committed baseline file so the next run is
a comparison rather than a fresh opinion.

Do NOT write a test that specifies millions of virtual users. The previous
version of this document called for 50M VUs, which no load generator can
produce and which made the whole suite unbuildable. Generate load proportional
to the target and extrapolate honestly, stating the extrapolation.
```

---

## Retired prompts

Removed because the work has shipped. Listed so nobody regenerates them.

| Old prompt | Why retired |
|---|---|
| 6.1 OpenTelemetry instrumentation | Wired in 36 files; collector + Tempo in prod compose |
| 6.2 Prometheus metrics & alerting | 26 files instrumented; Prometheus, Alertmanager, Grafana, 4 exporters, 3 rule files all running |
| 6.3 Distributed logging | Loki in prod compose; structlog with `request_id` |
| 1.2 PgBouncer | `deploy/helm/taskboard/templates/pgbouncer.yaml`, on by default. Kubernetes-only **on purpose** — INFRASTRUCTURE.md:188 |
| 1.4 Partitioning | `inbox_items` HASH×64; telemetry RANGE by `occurred_at` |
| 3.2 Idempotency / exactly-once | Outbox + DLQ in all 8 services, `event_id` UUIDv7 dedup, `FOR UPDATE SKIP LOCKED` in real transactions |
| 5.2 CDN & caching strategy | `infra/caddy/Caddyfile:229` — immutable hashed assets, `no-cache` HTML. CDN in front is provisioning, not code |
| 8.1 Kubernetes manifests | Chart complete: hpa, pdb, networkpolicy, ingress, cronjob, pgbouncer, livekit, coturn |
| 4.1 ws-gateway scaling | Built: `delivery-svc`, node registry, route cache, cookie affinity in ingress. Enabling it is prompt 3.1 |
| 4.2 Presence & typing | Heartbeat-scored ZSETs, 45s/120s window, amortized EXPIRE, in-process route cache. The **remaining** issue is org-key hot-slotting, which is a product decision — see BOTTLENECK_ANALYSIS.md item 8 |

Removed because they are disproportionate to the deployment:

| Old prompt | Why retired |
|---|---|
| 1.1 Postgres sharding by org_id | Real, and the actual wall — but a multi-quarter project, not a prompt. Design lives in INFRASTRUCTURE.md, including the unresolved `RedeemInvite` cross-org routing question |
| 2.1 Distributed Redis architecture | Cluster-capable client already built and off by default (Stage 4). Nine nodes across three clusters is not a one-VPS topology |
| 2.2 Kafka-based cache invalidation | Presupposes a cache that does not exist. Revisit if a second service ever caches the same entity — see prompt 1.1 |
| 2.3 Redis session storage | Sessions already work through JWT + refresh cookie with JWKS. This is a rewrite in search of a problem |
| 3.1 Multi-cluster Kafka + MirrorMaker2 | Three regions × 10 brokers. The stack has one region and one broker; fixing RF=1 is prompt 2.1 |
| 3.3 Consumer group scaling | Partition sizing already supported by `create-topics.sh`; HPA already in the chart. The real remaining item is prompt 2.2 |
| 5.1 Code splitting | **Kept** — rewritten as prompt 1.2 against the measured 1.45 MB bundle |
| 7.1 Load testing | **Kept** — rewritten as prompt 4.1 without the 50M virtual users |
| 8.2 Multi-region failover | Route 53 geo-routing across three regions, for a single VPS |
