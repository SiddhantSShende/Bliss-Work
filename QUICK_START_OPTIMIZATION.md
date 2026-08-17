# BlissWork optimization — where to start

**Refreshed 2026-08-17 against branch `VPS-Shristi`.**

Read `BOTTLENECK_ANALYSIS.md` first for the evidence behind this ordering, and
`Bliss-Work/INFRASTRUCTURE.md` for what has already landed. This file is only
the sequence.

> **What changed in this refresh.** The previous version opened with "Phase 1:
> Observability Foundation (Week 1)" — OTEL, Prometheus, structured logging.
> All of it had already shipped and is running in production. Following it would
> have spent a week rebuilding a working system. The phases below are the work
> that is actually outstanding.

---

## The one-paragraph version

Observability, the outbox pattern, partitioning, read replicas, the Helm chart
and the routed-delivery rewrite are **done**. What is left splits three ways:
one cheap application-layer win nobody has taken (**a read cache**), one
provisioning job that is pure durability (**Kafka off the single broker**), and
a pile of built-but-disabled machinery that **nobody has run under load**. Do
them in that order. Everything past that is sharding, and sharding is a
multi-quarter project that should not start until a load run says it must.

---

## Phase 1 — Take the free win (days, not weeks)

### 1.1 Add a read cache

**Effort:** 2-3 days · **Impact:** highest available per unit of work · **Risk:** low

There is no read cache anywhere in the platform. Redis serves presence, the
replay outbox, the node registry and rate limits, and nothing else — so every
channel list, message page, inbox render and profile lookup hits the single
Postgres primary.

Start narrow:

- **Channel rosters** — hot, small, tolerate seconds of staleness
- **`user_projection`** — same shape, read on nearly every render

Invalidate on write from the service that owns the mutation. Do **not** build
the Kafka-topic invalidation bus the old version of this document specified;
at two cache keys it is ceremony, and the cross-service invalidation problem
does not exist until more than one service caches the same entity.

**Leave alone:** the hot inbox paths. They are read-after-write — a user must
see the message they just sent — which is exactly why they were kept off the
read replica. A cache there reintroduces that bug.

**Prompt:** 1.1 in `CLAUDE_OPTIMIZATION_PROMPTS.md`

### 1.2 Split the frontend bundle

**Effort:** 1 day · **Impact:** the only item users feel directly · **Risk:** low

The production build is a single **1.45 MB** `index-*.js` containing all 30
routes, the LiveKit call UI and the integrations hub. Everyone downloads all of
it to reach a login form. There is exactly one `import()` in the whole app
(exceljs, behind Export Tasks) and no `manualChunks`.

Route-level `React.lazy` for the authenticated routes, a vendor chunk for
React/router, and a size budget in CI so it does not regress.

**Prompt:** 1.2

---

## Phase 2 — Stop losing data (provisioning, not code)

### 2.1 Kafka off the bundled broker

**Effort:** provisioning + one env var · **Impact:** durability · **Risk:** low

One broker at `RF=1` loses in-flight events on restart. This is the most urgent
durability gap in the system and there is **no application work left** — SASL_SSL
is wired at all 17 client call sites, producers use `acks=all`, and
`min.insync.replicas` derives from RF.

Provision a managed 3-broker cluster, set `REPLICATION_FACTOR=3`, re-run
`infra/kafka/create-topics.sh`.

While you are there: `NOTIFICATION_PARTITIONS` is already supported by that
script and is the topic that needs the headroom.

**Prompt:** 2.1

### 2.2 Batch the four remaining Python consumers

**Effort:** 1 day · **Impact:** removes a per-message round-trip ceiling · **Risk:** low

`task-svc`, `telemetry-svc`, `email-worker` and `integrations-svc` each commit
one message at a time. `notification-svc` was fixed in Stage 11 and is the shape
to copy verbatim — including how it keeps guarantees intact.

**Prompt:** 2.2

---

## Phase 3 — Turn on what is already built, in order

Stages 3, 4 and 5 ship off by default and **none has been exercised under load.**

**The order is not negotiable:**

1. **Stage 3 — routed delivery.** `WS_FANOUT_MODE=routed` + `WS_ADVERTISE_ADDR`.
   Both fan-out modes may run at once (delivery is idempotent, clients dedupe on
   `eventId`), so gateways flip one at a time with no flag day.
2. **Stage 4 — Redis cluster.** Comma-separated `REDIS_URL`. **Only after
   Stage 3.** Classic Redis pub/sub reaches every node of a cluster whatever the
   channel hashes to, so clustering a broadcast workload divides none of it.
3. **Stage 5 — LiveKit/coturn on Kubernetes.** Only relevant on the Helm path.

### 3.1 Enable the ws-gateway pod metric at the same time

Raising the HPA ceiling to 60 pods achieved nothing on its own: the autoscaler
still scales on CPU, which is nearly uncorrelated with how full a gateway pod
is. The fleet sits at `min: 3` while pods fill and refuse connections.

"Raise max" and "give it a metric that tracks sockets" are one change.

**Prompt:** 3.1

---

## Phase 4 — Measure, then decide

### 4.1 Build a load-test suite

**Effort:** 2-3 days · **Impact:** turns every number in these docs into a fact

There is no k6, locust or JMeter anywhere in the tree. Stages 3-6 are tested
against fakes and the Redis cluster path has never met a cluster. Every capacity
figure in these documents is **arithmetic, not measurement**.

Scale the test to the deployment you actually have — the old version of this
document specified a k6 run with 50 million virtual users, which is not a thing
that can be executed. Target the documented ceilings instead: ~10k DAU on
compose, ~300k DAU on Helm with a managed data tier.

**Prompt:** 4.1

### 4.2 Then re-rank

Phases 1-3 are ordered from a source audit. A load run is what promotes that
from ranked opinion to ranked fact, and it is the input to deciding whether
Phase 5 starts at all.

---

## Phase 5 — The multi-quarter work (do not start early)

Each of these needs a decision before it needs an engineer:

| Work | Blocked on |
|---|---|
| Telemetry off the OLTP primary | Choosing a columnar store |
| Full-text search | Design over encrypted `body_enc` — worth starting **before** sharding |
| Presence subscriptions | Product decision: whose presence does a client actually display? |
| Async Vault/KMS calls | Only if `DATA_KEK_PROVIDER=kms` is ever set. Latent today, but must land **before** that flip |
| **Postgres sharding** | The actual wall. Also needs a ruling on `RedeemInvite`, which routes by token hash with no `org_id` |

**Not on this list:** multi-region Kafka with MirrorMaker2, Route 53 geo-routing,
30-shard Postgres topologies, Redis Cluster across three regions. The previous
version of this document scheduled all of it. It is real work for a real
company at a real scale — it is not work for a stack that currently runs on one
VPS under docker-compose, and writing it into a roadmap made the roadmap
unusable.

Revisit when a load run says the Helm path with a managed data tier is
saturating. That is the ~1M DAU rung, and it is a fundable milestone. The
billion is a direction.
