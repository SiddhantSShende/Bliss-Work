# BlissWork bottleneck analysis

**Audited 2026-08-17 against branch `VPS-Shristi`.** Every claim below was
checked against the source tree, not inferred from the roadmap.

## How this document relates to the others

`Bliss-Work/INFRASTRUCTURE.md` is the source of truth for **what has landed**.
It is maintained by whoever does the work and it is accurate; its
"Status: what has actually landed" section (line 160 onward) is the honest
record, and this file does not restate it.

This file answers a different question: **what binds next, and in what order.**
Where the two disagree, INFRASTRUCTURE.md wins on status and this file wins on
sequencing — because sequencing is what the previous version of this document
got wrong.

> **The previous version of this file was generated from a stale snapshot** and
> listed "No Observability Wiring", "No Database Connection Pooling" and
> "No Exactly-Once Processing Guarantees" as critical. All three had already
> shipped. It also ordered the work Postgres-first, which is the wrong order —
> see "Why the old ordering was wrong" at the bottom.

---

## Already done — do not re-do these

Listed only because the previous version of this document called for them.
Evidence is a path you can check.

| Previously listed as missing | Reality |
|---|---|
| OTEL not wired into code | Wired in 36 files. `services/*/app/tracing.py`, `services/messaging-svc/internal/tracing/`, collector + Tempo in `docker-compose.prod.yml` |
| No Prometheus metrics | 26 files instrumented. `/metrics` on Go services, Prometheus + Alertmanager + Grafana + 4 exporters in prod compose, 3 rule files in `infra/observability/prometheus/rules/` |
| No log aggregation | Loki in prod compose; structlog with `request_id` across Python services |
| No connection pooling | PgBouncer at `deploy/helm/taskboard/templates/pgbouncer.yaml`, `enabled: true`. **Kubernetes only** — deliberately not in compose, see INFRASTRUCTURE.md:188 |
| No table partitioning | `inbox_items` HASH×64 on `owner_user_id` (`messaging-svc/migrations/0003`); telemetry RANGE on `occurred_at` (`telemetry-svc/migrations/0001`) |
| No exactly-once / idempotency | Outbox + DLQ in all 8 services; `event_id` UUIDv7 dedup; `FOR UPDATE SKIP LOCKED` in real transactions |
| No CDN cache headers | `infra/caddy/Caddyfile:229` — `/assets/` is `max-age=31536000, immutable`; HTML is `no-cache` |
| No K8s manifests | Full chart: hpa, pdb, networkpolicy, ingress, cronjob, pgbouncer, livekit, coturn |
| Single ws-gateway, no scaling story | `delivery-svc` routed fan-out, node registry, in-process route cache, presence heartbeat ZSETs. Built; `WS_FANOUT_MODE=routed` is off by default |
| No read replicas | `MESSAGING_DATABASE_REPLICA_URL`, opt-in per call site (`messaging-svc/cmd/server/main.go:101`) |

---

## 🔴 Binds first

### 1. There is no read cache anywhere in the platform

**Evidence:** Redis holds presence, the replay outbox, the node registry and
rate-limit buckets — and nothing else. Not one read path in any of the eight
services is cached. `internal/ttlcache` exists but is ws-gateway-local and
caches routing metadata, not query results.

Every channel list, message page, inbox render and profile lookup goes to the
single Postgres primary. At chat read/write ratios this is the **largest single
multiplier available**, and it costs less than any infrastructure on this page.

**Start with:** channel rosters and `user_projection` — hot, small, and
tolerant of seconds of staleness.

**Watch out for:** the read-after-write paths. The hot inbox deliberately stays
on the primary because a user must see the message they just sent; a cache there
reintroduces exactly the bug the read-replica work avoided.

### 2. Kafka is one broker at RF=1

**Evidence:** `infra/kafka/create-topics.sh:22` — `RF="${REPLICATION_FACTOR:-1}"`,
and prod compose runs a single `kafka` container.

In-flight events are lost on restart. This is the most urgent **durability** gap
in the system, and it is the one item here that is pure provisioning: the
client-side work is finished (SASL_SSL at all 17 call sites, `acks=all`,
`min.insync.replicas` derived from RF). Provision a managed 3-broker cluster,
set `REPLICATION_FACTOR=3`, done.

### 3. The staged migrations ship off by default

Stages 3, 4 and 5 are built and disabled. Nothing has been exercised under load.

**Order matters:** route fan-out (Stage 3) *before* sharding Redis (Stage 4).
A cluster applied to a broadcast workload distributes the amplified load rather
than removing it.

### 4. The frontend ships as one 1.45 MB chunk

**Evidence — the actual build output in `apps/web/dist/assets/`:**

| File | Size | What it is |
|---|---|---|
| `index-Bz0r4mqE.js` | **1,485,567 B** | The entire app: all 30 routes, call UI, integrations |
| `exceljs.min-DX9i2rwU.js` | 940,194 B | The **only** lazy chunk in the app |
| `index-BZs9vlHF.css` | 69,461 B | |

`packages/app/src/App.tsx` statically imports all 30 routes. There is exactly
one `import()` in application code (`lib/xlsx/workbook.ts`, behind Export Tasks)
and no `manualChunks` in `apps/web/vite.config.ts`.

> **This corrects INFRASTRUCTURE.md:140**, which excludes frontend work on the
> grounds that "the Vite build already splits by route." It does not. That claim
> should be removed — it is the reason this never got looked at.

Everyone downloads the video-call stack and the integrations hub to reach a
login form. This is cheap to fix and it is the only item on this page that
users feel directly.

---

## 🟡 Binds next

### 5. Four Python consumers still commit per message

`task-svc`, `telemetry-svc`, `email-worker`, `integrations-svc` — each does
fetch → DB transaction → synchronous offset commit, one message at a time.
`notification-svc` was fixed in Stage 11 (200 messages / 25 ms linger, one
transaction, one commit) and is the shape to copy:
`services/notification-svc/internal/consumer/consumer.go`.

Guarantees are unchanged by batching: offsets follow the transaction,
redelivery stays idempotent via `event_id`, poison messages skip out of the
batch rather than failing it.

### 6. The ws-gateway HPA ceiling is unreachable

`values.yaml` raises `max` to 60 pods (1.5M sockets), but the autoscaler still
scales on **CPU**, which is close to uncorrelated with how full a gateway pod is
— a socket costs memory and two goroutines and almost no CPU while idle.

The fleet will sit at `min: 3` while pods fill and start refusing connections.
Raising `max` and enabling the `podMetric` block are one change, not two. The
values file says so at line 169; it is called out here because a ceiling that
cannot be reached reads as capacity that does not exist.

### 7. Telemetry beacons write synchronously into the OLTP primary

`POST /telemetry/beacon` opens a transaction, touches the session row, inserts
the batch and commits — inline on the request, on the highest-QPS surface in the
product.

Range partitioning by day is the right first step and buys cheap pruning, but at
the volumes this document is about, behavioural telemetry does not belong in the
primary at all: accept to Kafka, batch-load to a columnar store, keep the
rollups. **Blocked on choosing the store.**

### 8. Org-wide presence is one Redis key per org

Stage 7 removed the N-way read amplification; the underlying shape survives. A
presence transition in a very large org still reads that org's entire online
set, and a big org is a hot slot that no amount of sharding relieves.

The fix is a presence *subscription* — clients declare whose presence they are
displaying (the people in view, not the org) and the publisher intersects
against that. **That is a product decision as much as a storage one.**

---

## 🟢 Needs a decision before it needs code

### 9. No full-text search exists

No `tsvector`, no `pg_trgm`, no external index. Users will expect to search
their messages, and retrofitting search across an encrypted-at-rest
`messages.body_enc` is a design problem worth starting **before** sharding
rather than after.

### 10. A blocking Vault call on the event loop, if KMS is ever enabled

`crypto.py` in auth-svc, task-svc, telemetry-svc and integrations-svc calls
`httpx.post` — the **synchronous** client — to wrap and unwrap per-org data
keys. One uvicorn worker per pod means one event loop, so a blocking call stalls
every other in-flight request on that pod.

**Latent, not live:** `DATA_KEK_PROVIDER` defaults to `dev`. Enabling KMS means
moving to `httpx.AsyncClient` (or `asyncio.to_thread`, as the Argon2 hashing
already does) **first**.

### 11. Postgres sharding — the actual wall

A multi-quarter project. Every table carries `org_id`, which is the hard part
done, with one exception found during the calls work: `RedeemInvite` looks up a
meeting invite by token hash alone, because the redeemer's org is deliberately
irrelevant — that is what makes cross-org meeting links work. Under org
sharding there is no `org_id` to route it by.

Needs either a small global directory mapping `token_hash → org_id`, or the
shard encoded into the token (cheaper, but leaks topology into a credential and
constrains resharding). The same question applies to every future cross-org
feature; decide it once.

### 12. Nothing above has been measured

There is no k6, locust or JMeter suite in the tree. Stages 3-6 are tested
against fakes; the Redis cluster path has never met a cluster. **Every capacity
number in these documents is arithmetic, not measurement.**

A staging load run is the gate on believing any of it — and it is what turns
this list from ranked opinion into ranked fact.

---

## Why the old ordering was wrong

The previous version put Postgres sharding first, following the original
roadmap. A source audit of the real-time tier found the binding constraint was
not infrastructure at all: every gateway pod subscribed to Kafka under its **own
consumer group**, so every pod received 100% of every event and discarded what
it did not hold. Adding a pod added load instead of relieving it.

Buying infrastructure against that shape distributes an amplified load rather
than removing it. A second audit then found the deployed ceiling was **Redis
memory**, by roughly two orders of magnitude — not Postgres.

The lesson generalises, and it is why item 12 exists: rank by what the source
says binds, then confirm with a load run. Do not rank by what a reference
architecture says is important.

---

## The honest ceiling

Reproduced from INFRASTRUCTURE.md because every priority call on this page
depends on it:

| Configuration | Comfortable | Ceiling | What gives out |
|---|---|---|---|
| Compose, one VPS, hatches off, Redis at 400mb | ~500 WAU | ~1.5-3k WAU | Redis fills; presence AND replay fail together |
| Same, with Stage 11's Redis sizing (2gb) | ~10k DAU | ~50k DAU | Postgres at 2 CPU with no read cache |
| Helm, managed data tier, hatches on | ~300k DAU | ~1M DAU | The application-layer gaps above |

**1B DAU is not 1M concurrent, and conflating them has produced bad capacity
decisions here before.** At 20-40 min/day of engagement, 1B DAU is 10-30M
concurrent sockets; 1M concurrent is 30-100M DAU.

1M concurrent is a fundable milestone that lands on the sharding rung. The
billion is a direction, not a plan.
