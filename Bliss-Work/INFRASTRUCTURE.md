# Infrastructure roadmap for Task-Board at scale

## Why this document exists

The production-hardening PR that lands these tests + middleware does the
**application-layer** work for going to production: rate limits, security
headers, error envelopes, panic recovery, DB retry, request-id correlation,
pagination, and a comprehensive test suite.

**That is not enough to serve 1 billion DAU.** No single Postgres / Kafka /
Redis cluster does. The work in this document is the infrastructure-layer
follow-up. None of it is achievable inside the application repository alone —
it requires platform tooling, deployment automation, and SRE involvement.

This file is intentionally not a checklist of TODOs; it is a deployment guide
for the team that owns the production environment. Numbers are rough order-of-
magnitude estimates to help capacity-plan, not commitments.

## What scales linearly with users

| Concern | Approach |
|---|---|
| Stateless services (auth, task, messaging, notification) | Horizontal autoscale on CPU + p99 latency; HPA with min replicas per region |
| ws-gateway (stateful: holds the open socket) | Horizontal autoscale + sticky load-balancing by `userId` (consistent hash); cross-pod delivery is routed through the node registry, so it costs by traffic rather than by pod count — set `WS_ADVERTISE_ADDR` on every pod |
| Vite SPA build (`apps/web`) | Static, push to CDN (Cloudfront / Fastly); `index.html` short-TTL, hashed assets long-TTL |
| Refresh-cookie traffic | All session bootstrap goes through auth-svc; size that fleet for peak sign-ins, not steady DAU |

## What needs deliberate sharding

### Postgres (the actual bottleneck)

A single Postgres instance handles ~10k writes/sec on premium hardware. At
1B DAU with even modest engagement the messaging-svc and notification-svc
hot tables (`thread_messages`, `inbox_items`, `notifications`) will saturate
that within minutes.

Sharding strategy: **shard by `org_id`**. Every table in the schema already
carries `org_id` (verified — see migrations) so the application layer doesn't
have to learn cross-shard queries. Use either:

- **Citus** (managed via Azure or self-hosted): transparent shard routing,
  pgxpool talks to the coordinator. Lowest application impact.
- **Application-level routing**: a small `shard_for(orgId)` helper in each
  service; per-shard pgxpool. More code but no vendor lock-in.

Read replicas per shard for the inbox/thread list endpoints — these are
heavy reads and tolerate ~1s replica lag.

PgBouncer in **transaction pooling mode** in front of every shard so the
service pods aren't capped on Postgres backend slots.

### Kafka

The notification topic fans out to every subscriber of every event — at
1B DAU this is the highest-volume topic by orders of magnitude.

- **Cross-region replication is NATS JetStream, not MirrorMaker2** — see
  `docs/CROSS-REGION.md` and `services/region-bridge`. Producers write to the
  region-local Kafka cluster; the bridge exports locally-produced events onto a
  per-region JetStream stream, and every peer sources it. Kafka stays the
  in-region bus and no service knows the bridge exists, which is also how it is
  rolled back (turn it off). Loop freedom is structural — a region's outbound
  stream carries only its own subject space — and re-asserted per message by an
  origin stamp, so an active-active mesh cannot replicate in circles.
- **Tiered storage** (Confluent Tiered Storage or Apache Kafka 3.6+ KIP-405):
  long retention without paying for hot disk.
- **Partition counts**: notification topic 200+ partitions sized for the
  consumer group; messaging topics can stay at ~32.
- Idempotent producers everywhere (we already do this — verified by the
  existing `event_id` UUIDv7 + outbox claim-once pattern).

### Redis

- **Cluster mode** for rate-limit hot keys. Our current limiter is
  in-process per-pod (see `services/messaging-svc/internal/middleware/ratelimit.go`);
  for an honest distributed rate limit, switch to `github.com/go-redis/redis_rate`
  pointed at the Redis cluster, fail-open if the cluster is unreachable.
- **Separate Redis cluster for presence/ws-gateway** — different access
  pattern (high write, low keyspace per pod) and you don't want a noisy
  neighbour effect from the rate limiter.

## What needs an edge

- **CDN** for the Vite build (already mentioned).
- **WAF**: layer Cloudflare rules / AWS WAF in front of the ALB. The
  application-layer rate limit we ship is the second line of defence — the
  edge handles the volume floor.
- **TLS termination at the edge** with HSTS preload. Internal mesh can stay
  on plain HTTP behind mutual VPC isolation.
- **Regional failover** via DNS-based health checks.

## What needs observability

- **OpenTelemetry**: `OTEL_EXPORTER_OTLP_ENDPOINT` is already in `.env.example`
  but not wired into the application code. To wire:
  - Python: `opentelemetry-instrumentation-fastapi` auto-instruments FastAPI,
    SQLAlchemy, httpx. Bootstrap in lifespan startup.
  - Go: `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` for
    the HTTP entry point, `otelchi` for the chi router.
  - Deploy an OTEL Collector sidecar / DaemonSet; export to whatever the
    observability vendor is.
- **Prometheus** `/metrics` endpoints:
  - Go: `github.com/prometheus/client_golang/prometheus/promhttp`. Add
    counters for `messaging_messages_sent_total`, histograms for
    `*_request_duration_seconds`, gauges for `*_circuit_breaker_state`.
  - Python: `prometheus-fastapi-instrumentator`.
- **Distributed log aggregation**: structured JSON logs already include
  `request_id` (after this PR). Pipe to Loki / Splunk / Datadog; the
  request-id is the join key between services.
- **APM tracing dashboard**: `traceId` propagated by OTEL gives a single
  view of `web → auth → task → messaging` for any user-visible action.

## What needs orchestration

- **Kubernetes** with per-service Deployments + HPAs. Min replicas per region;
  use a custom metric (`messaging_request_duration_p99`) for autoscaling
  rather than just CPU.
- **PodDisruptionBudgets** so a node-drain doesn't take down a quorum.
- **Topology spread** across AZs so a zone failure leaves a serving fleet.
- **Network policies** locking down inter-service calls to expected paths.

## What needs operational hygiene

- **Secrets**:
  - Rotate the Ed25519 keypair quarterly with overlapping JWKS publication
    (verifier services already cache JWKS; bumping the kid is the only
    change).
  - All secrets out of `.env` files; deploy via Vault / AWS Secrets Manager.
  - Never log access tokens (verified — our structlog config doesn't
    structure the Authorization header).
- **Compliance**:
  - Separate `audit.v1` Kafka topic (already declared in
    `packages/shared/src/types/events.ts`); pipe to immutable storage
    (S3 Glacier / Azure immutable blob) for the retention period the
    legal team requires.
  - PII handling: `users` table contains email + display name; classify in
    the data catalog as PII and ensure data-subject access requests have a
    documented runbook.
- **Backup / DR**:
  - Per-shard Postgres backups (continuous + nightly snapshot).
  - Kafka topics replayable for at least 7 days (tiered storage helps here).
  - Cross-region snapshot replication.

## What's intentionally not in this document

- ~~Frontend code splitting / bundle size optimisation. The Vite build already
  splits by route; bundle size monitoring is a separate concern.~~

  **This was false, and being written down is why it went unexamined for so
  long.** The Vite build did not split by route: `App.tsx` statically imported
  all thirty routes, there was exactly ONE dynamic import in application code
  (the Excel export), and no `manualChunks`. The result was a single 1.45 MB
  entry chunk — every visitor downloaded the video-call stack and the
  integrations hub to reach a login form.

  Now fixed (see Stage 13). Kept here struck through rather than deleted,
  because the failure was not the bundle; it was a confident claim in a
  document people trust, which is a thing worth leaving visible.
- Cost / budget. Numbers vary by cloud vendor and contract.
- Specific vendor recommendations. Pick the one your team already knows.

## Migration order

If you have to do this in stages (you will):

1. **Observability first** — you can't operate what you can't see. Wire OTEL
   + Prometheus before you scale anything else.
2. **CDN + WAF** — cheap, big return.
3. **Postgres read replicas** (within the existing shard) — buys headroom
   while you plan sharding.
4. **Postgres sharding** — the biggest lift, plan for a multi-quarter project.
5. **Kafka multi-cluster** — only when you have multi-region traffic.
6. **ws-gateway sticky-session** — needed once you have >1 pod serving WS.

---

## Status: what has actually landed

Written down because "the roadmap says X" and "X is done" are different claims,
and this document previously only made the first one.

### Done

- **Multi-replica safety.** Four outbox pollers now claim rows with
  `FOR UPDATE SKIP LOCKED` (the two Go ones inside a real transaction, without
  which the clause is decorative); the telemetry session sweeper takes a
  transaction-scoped advisory lock; telemetry's rate limiter uses Redis instead
  of counting per-pod. These were correctness bugs, not optimisations — running
  two replicas before them multiplied Kafka volume and raced `published_at`.
- **ws-gateway presence expires.** Heartbeat-scored ZSETs reaped on read,
  replacing SADD/SREM plus a startup sweep of every `presence:*` key. That sweep
  was the single hardest blocker to a second gateway pod: it would have logged
  out everyone connected to the first.
- **Load-balanced edge, and a fleet behind it.** The edge used to name exactly
  one container per service, so every request in the platform reached a single
  process and the only lever against load was a bigger box. Both Caddyfiles now
  resolve each compose service name to the address of *every* container behind
  it (`dynamic a`, refreshed every 10s) and distribute with `least_conn`, and
  `docker-compose.prod.yml` runs two replicas of each stateless HTTP service —
  so a restart is a rebalance rather than an outage, and
  `up -d --scale task-svc=4` is picked up at the edge with no config change.

  The trade is explicit: Caddy does not run ACTIVE health probes against
  dynamically-resolved upstreams, so the `/readyz` polling this bullet used to
  describe is gone. It is replaced by passive ejection (`max_fails` /
  `fail_duration`) plus `lb_try_duration`, which re-dispatches a refused request
  to another replica instead of returning a 502 — worse than a probe at one
  replica, much better at two, and two is the point. `/readyz` still gates
  compose dependency ordering and the Kubernetes readiness probe.
- **Helm chart completed.** telemetry-svc and integrations-svc were missing
  entirely; `/presence`, `/turn-credentials` and the JWKS path had no ingress
  route at all, so a Kubernetes deploy had no presence and no WebRTC calls.
  Maintenance CronJobs added — the rollup, prune and attachment GC simply never
  ran on Kubernetes, silently.
- **Observability in production.** The OTEL collector, Prometheus, Alertmanager,
  Tempo, Loki and Grafana existed only under a dev compose profile. Production
  ran with no metrics, no traces and no alerting.
- **PgBouncer on by default — ON KUBERNETES ONLY.** `pgbouncer.enabled: true` in
  `values.yaml`. The compose stack has **no pooler at all**, and compose is what
  the VPS actually runs, so the live system connects services straight to
  Postgres. Connection slots are therefore the budget that bounds the compose
  fleet. At the two replicas each now runs, the pools sum to 128 against
  `max_connections=200` (6 HTTP services x 10 x 2, plus email-worker's 8) — real
  headroom, and a hard ceiling not far above it: each additional replica of a
  service costs another 10 slots, so roughly 4 replicas each exhausts the budget.

  Still deliberately not "fixed" by adding PgBouncer to compose, but the reason
  has narrowed. It used to be "on a single box you do not scale replicas", which
  is no longer true. It is now simply that 200 backends would not be healthy on
  8 cores anyway: past ~4 replicas each, the box is the constraint and the answer
  is the Helm path (where the pooler already exists), not a pooler bolted onto
  compose at the cost of a second TLS hop.

  Safe in either path because every org-scope GUC is
  `set_config(..., is_local => true)` and every advisory lock is `_xact_`-scoped.
  Keep it that way; session-level state breaks silently under transaction pooling.
- **CDN-ready cache headers.** `/assets/` (content-hashed) is a year and
  immutable; unhashed public files stay short.
- **Object storage for attachments, behind a `MEDIA_BACKEND` flag.**
  `internal/blob` is now an interface with two implementations: the filesystem
  (default, unchanged) and any S3-compatible bucket. Local disk was the last
  thing pinning messaging-svc to one replica — two pods do not share a volume,
  so one accepts an upload and the other 404s the download. The S3 layout is
  byte-for-byte the filesystem layout, so `attachments.storage_path` resolves
  either way and the migration rewrites no database rows
  (`scripts/migrate-blobs-to-s3.sh` copies and verifies; it deletes nothing, so
  the rollback is flipping the flag back). Verified against a real MinIO in CI,
  including ranged reads — a bucket that could not seek would break video
  scrubbing. **Still defaults to `fs`**: flipping it without migrating first
  points a live deployment at an empty bucket.
- **Group calls on an SFU, which adds a stateful service to the topology.**
  Calls used to be one peer connection between two sockets, with no database row
  at all. Channel calls and meetings need a roster, so they get one
  (`0015_calls.sql`), and they need media fan-out that survives a third
  participant, so media goes to LiveKit rather than a full mesh — mesh makes
  every client upload N-1 copies of its own camera, which is the client's uplink
  and is what breaks around five people. Three consequences for operations, all
  of them things that fail confusingly if missed:
  - **The SFU runs with host networking** (a contiguous 200-port UDP range is not
    expressible as docker port publishing), so it is *not* on the compose bridge
    and cannot resolve any service name. It runs single-node for exactly that
    reason: LiveKit's multi-node mode needs a Redis it cannot currently reach.
  - **50000-50200/udp and 7881/tcp must be open** (`harden-host.sh` does it). A
    closed UDP range produces a call that connects, lists participants, and
    carries no media — it reads as an application bug and is not one.
  - **The edge routes `/livekit`** to that host-networked SFU, ahead of the WAF
    for the same reason `/ws` is: Coraza's response wrapper eats the
    `101 Switching Protocols` line.
  Authorization stays entirely in messaging-svc, which mints a short-lived,
  room-scoped token only after checking Postgres; LiveKit holds no authorization
  state of its own. `LIVEKIT_API_SECRET` is therefore a credential of database
  weight — it can mint anyone into any room. Meeting invite links are the one
  cross-org door in the product, and the RLS work that makes that safe without
  weakening org isolation globally is described in `0015_calls.sql`.
- **Kafka `min.insync.replicas`.** Every producer already used `acks=all`, which
  on its own still acknowledges against a lone surviving replica. Now derived
  from RF, so RF=3 requires a real quorum.

### Scalability work, staged

A source audit of the real-time tier found that the binding constraint was not
infrastructure but a design choice in the gateway: every pod subscribed to Kafka
under its OWN consumer group, so every pod received 100% of every event and
discarded what it did not hold. Adding a pod added load to Kafka and Redis
instead of relieving it. The work below is staged around removing that.

**Stage 1 — the current tier, made honest.** Done.

- messaging-svc's outbox publisher batched. It claimed 100 rows then wrote them
  one at a time, each waiting out the producer's 50 ms batch timeout — roughly
  20 events/sec, the producer-side ceiling on every event in the product.
  notification-svc had always done this correctly and was the model.
- `sendChanCap` cut from 512 to 64. A buffered channel allocates its ring
  eagerly, so 512 cost 12 KB per socket before anything was queued; measured,
  a connection went from **13,855 to 2,079 bytes**. `WS_MAX_CONNECTIONS=50000`
  against a 384M limit was unreachable — the pod was OOM-killed around 13k, so
  the cap that exists to refuse connections cleanly never fired. Memory limits
  now move with the cap and both files say so.
- **Kafka SASL_SSL wired at every client.** All 17 of them across 8 services,
  which is rather more than the "five call sites" an earlier note estimated:
  Go via `internal/kafkaauth`, Python via `app/kafka_security.py`. Unset means
  PLAINTEXT; a SASL protocol with no credentials is a startup error rather than
  a silent fallback.

**Stage 2 — instrumentation.** Done. The gateway had two metrics, neither of
which said anything about the constraint above. It now exports the fan-out
amplification pair (`ws_fanout_discarded_total` / `ws_fanout_recipients_total`),
connection rejections split by which cap was hit, Redis ops split by purpose,
send-buffer depth, and TURN availability. `rules/gateway.yml` records the
amplification ratio and alerts on the actionable cases. The ratio is a recording
rule, not an alert: it measures the architecture, so paging on it would fire
forever.

**Stage 3 — routed delivery.** Built, off by default.

`delivery-svc` (a second binary in the ws-gateway module — same bounded context)
reads the stream once under a shared consumer group, computes recipients once,
writes the outbox once, and pushes each gateway only its own users. The routing
table already half-existed: `presence:u:<userId>` holds `nodeId:connId`, so only
a node-address map was missing. Enable with `WS_FANOUT_MODE=routed` plus
`WS_ADVERTISE_ADDR`. Both paths may run at once — delivery is idempotent and
clients dedupe on `eventId` — so gateways flip one at a time with no flag day.

**Stage 4 — Redis tier.** Built, off by default.

Cluster-capable client (several comma-separated URLs in `REDIS_URL`), with the
two cross-slot operations fixed — `TouchPresence` used a transactional pipeline
across two keys that hash differently, and `NodeAddrs` used `MGET`; both would
have failed with CROSSSLOT. Keys are hash-tagged **only** in cluster mode, so a
single-node deployment needs no key migration and keeps its replay history. The
presence heartbeat was decoupled from the websocket ping (one number had been
doing two unrelated jobs) and moved to 45s inside a 120s window with amortized
`EXPIRE` — roughly a **4× cut in presence write traffic**.

**Stage 5 — media tier.** Built, off by default.

LiveKit and coturn were **entirely absent from the Helm chart**: no Deployment,
no `LIVEKIT_*`, no coturn. messaging-svc's minter therefore reported itself
unconfigured and `/calls/{id}/token` answered 503, so a Kubernetes install had
no group calls at all — the same class of gap this document records fixing for
telemetry-svc and integrations-svc. Both now have manifests (`livekit.yaml`,
`coturn.yaml`), with LiveKit's multi-node Redis available because the compose
constraint that forces single-node there does not apply on Kubernetes.

The TURN relay range went from **41 ports to ~20,000**. coturn allocates one UDP
port per session, so the old range was about twenty concurrent relayed calls for
the entire platform — and because only the 10-20% of calls that cannot traverse
NAT need a relay, exhausting it presents as a load-dependent minority of calls
that connect and carry no media. `harden-host.sh` was pinned to the old range
and had to move with it.

**Stage 6 — Postgres.** Read replicas built; sharding designed, not built.

messaging-svc takes an optional `MESSAGING_DATABASE_REPLICA_URL` and routes a
deliberately-chosen set of lag-tolerant reads to it. The rule is that the
question is not "is this a read" but "would this be wrong if it returned state
from a second ago" — so the hot inbox paths deliberately stay on the primary,
because they are read-after-write and a lagging replica would hide a message the
user just sent. Every call site opts in individually; there is no blanket
switch.

**Stage 7 — RTC signalling and presence off Redis pub/sub.** Done, and on by
default. Unlike stages 3-6 there is no flag: pub/sub was strictly worse on every
axis, so there is nothing to migrate between and no rollback worth keeping.

Both paths were broadcasts. Signalling published to `rtc:user:<id>` and every
gateway ran `PSUBSCRIBE rtc:user:*`, so each node received every signalling frame
in the platform and discarded the ones it could not deliver — pattern
subscriptions being the most expensive kind Redis offers. Presence was worse
than it looked: one shared `presence:events` channel carried every transition to
every node, and **each node then ran its own `OnlineUserIDs`** for the affected
org. One person's avatar flipping in a 10,000-seat organisation meant twenty
nodes each reaping and reading a 10,000-member sorted set. The Redis read
amplification was N times the transport amplification.

Both now resolve recipients **once**, at the publisher, and push only to the
nodes that actually hold them (`internal/push.Fanout`) — the same routing table
Stage 3 built, applied to the two paths that were still broadcasting. Sockets on
the publishing node are served in process and that node is excluded from the
push targets, so nobody is delivered to twice. Many recipients on one node
travel as a single request carrying one copy of the payload.

This was also the prerequisite for Stage 4 being worth anything: classic Redis
pub/sub is delivered to every node of a cluster whatever the channel name hashes
to, so sharding Redis would have divided none of this work.

Consequently **`WS_ADVERTISE_ADDR` now matters in both fan-out modes**, and node
registration is unconditional. A multi-pod fleet without it cannot connect a
call between two users on different pods. It is set unconditionally in the Helm
values; single-gateway deployments can still leave it unset, since there every
socket is local.

The cost moved rather than vanishing: the publisher pays for the recipient
lookup on the connect/disconnect path instead of every node paying afterwards.
That is a strictly smaller total, but a very large org still makes one large
read per transition. Bounding **that** is a data-model question — a presence
subscription rather than an org-wide broadcast — and is not solved here.

**Stage 8 — the signalling hot path.** Done, and on by default.

Routing every frame properly (Stage 7) made a second problem visible. A
signalling frame asks two questions before it can move: is the destination a
same-org online peer, and what address reaches the node holding them. Both were
a Redis round trip, on **every frame** — and signalling is bursty in a way that
makes that expensive. A call setup is an offer, an answer, and then twenty to
forty trickled ICE candidates per side within a few seconds, all addressed to
the same peer. Typing hints have the same shape. At the per-connection cap of
200 frames/second, one socket could issue several hundred Redis operations per
second re-asking questions whose answers had not changed.

Both are now cached in-process (`internal/ttlcache`), which takes a cross-node
frame from three Redis round trips to roughly zero and a local one from one to
zero. The two caches rest on quite different arguments, and the difference is
the point:

- **Node address** (`node id → URL`, TTL a third of the registration TTL). Not a
  staleness trade at all. A node id is a UUID minted at process start and
  `RegisterNode` only ever writes the same address under it, so the mapping is
  immutable for the node's life — there is no second value it could have become.
  The only thing a cache can miss is a node that has *died*, and that answer was
  already stale by up to the registration TTL. A push that fails invalidates the
  entry, so a dead pod is forgotten on first evidence rather than on expiry.
- **Same-org peer check** (TTL 3s, positives only). This one *is* a staleness
  trade, and it is small because the underlying read was never fresh: org
  presence is a heartbeat-scored set with a 120-second window, so the answer was
  already up to two minutes behind reality. Three seconds on top of 120 changes
  nothing a client can observe — a peer who vanishes mid-call is detected by ICE
  and DTLS timeouts, not by this. Denials and errors are never cached, so the
  cache can only ever repeat an allow it had already granted within the TTL; it
  can neither manufacture a refusal nor widen who is reachable.

The cache key for the peer check is `org + user`, not `user`. That is the
security property, and it has a test: keyed on the user alone, one legitimate
same-org call would poison the cache into admitting every other org's traffic to
that person.

`signal.Dispatcher` now takes a `PresenceChecker` interface rather than a
concrete `*store.Store`. The cross-org gate is the entire security boundary for
signalling and, against a concrete store, the only case reachable in a test was
"Redis is down" — the cases that matter (same-org allowed, cross-org refused,
and the cache preserving both) all needed the seam.

`ws:route_cache:hit_ratio` records whether it is working.

**Stage 9 — the waiting room stops polling.** Done.

`POST /calls/{id}/token` is the gate in front of media, and it re-decides access
from the database every time — deliberately, because that is what makes removal
from a channel actually take effect. The waiting room turned that correct
decision into a load generator: everyone held in a lobby called it on a five
second timer, so the cost scaled with the number of people waiting. A
five-hundred person all-hands sitting on a late host was a hundred access
decisions a second, indefinitely, on the primary.

Two things were wrong, and the second is the one that mattered:

- **The decision was chattier than it needed to be.** A single poll cost about
  nine round trips. The two `set_config` calls that open every call-path
  transaction are now one statement; the call row and the caller's seat in it
  are read together rather than as two queries; `canStartCallTx` is handed the
  role its caller had already fetched instead of re-fetching it; the redundant
  second channel-membership check on the auto-enrol path is gone; and knowing
  the lobby mark up front lets a repeat poll skip its `UPDATE` entirely, which
  leaves the whole transaction **read-only**. Roughly nine round trips to four,
  and one fewer on every other call endpoint too.
- **It should not have been polling at all.** `startCall` already fans
  `call.started` out to the whole roster through the outbox, and two comments —
  one in the hook, one on the API client — described the client as listening for
  it. **Nothing did.** The event was emitted, the type was defined, and no
  subscriber existed, so the poll was the only mechanism and had to be fast
  enough to be one. The hook now subscribes while it is in a lobby, and the
  timer drops to 30s as the backstop it was always documented to be.

The event is treated as a hint, not an authorisation: it says the call is open,
not that this person may enter, so the client still re-mints and the server still
decides. Practically, a lobby now costs one access decision on arrival, one when
the call opens, and one every thirty seconds only if the socket is down.

**Stage 10 — the last unbounded listing.** Done.

`GET /channels/open` — Browse — returned EVERY open channel in the organisation
with no `LIMIT`. It is the one listing whose population is set by how large the
customer is rather than by anything a person does, and the rows are dearer than
they look: each carries a `LATERAL` lookup of its last message and is then
decrypted individually in Go. An org with fifty thousand channels paid all of
that to render one screenful.

Now paged with `?limit=&offset=` (default 50, hard max 200), clamped in the
store as well as at the HTTP layer because the ceiling has to hold for every
caller and not only the one that arrived through a URL. The `ORDER BY` gained
`c.id` as a tiebreaker — without a total ordering, two channels sharing a
timestamp can swap places between pages, which is how a paged reader silently
skips one row and sees another twice. The client uses `useInfiniteQuery` with a
Load more control, so nothing became unreachable.

Its sibling `ListChannels` is deliberately left unpaged: it returns the caller's
OWN memberships, which the sidebar needs in full and which a person bounds by
joining a human number of channels.

**Stage 11 — the constraints that bound BEFORE Postgres.** Done.

A second source audit, aimed at the question "what actually breaks first", found
that the ceiling on the deployed stack was not Postgres and not the gateway. It
was Redis memory, by roughly two orders of magnitude, plus three application-
layer costs that no amount of infrastructure removes.

- **Redis `maxmemory` was 400mb, and the outbox is sized in weekly actives.**
  The replay outbox stores FULL EVENT COPIES, one per recipient, trimmed at 2000
  on a 7-day TTL that is refreshed on every append — so the resident population
  is everyone active in the last week, not everyone online now. At ~700 B per
  ZSET member all-in and 50 events/day, that is ~245 KB per user per week: 400mb
  held roughly **1,500 weekly actives**, against a `WS_MAX_CONNECTIONS` of
  25,000. And because `noeviction` applies to the whole keyspace, filling it
  takes presence, the node registry and the shared rate-limit buckets down with
  the outbox — a presence outage and a replay outage in the same instant, not
  merely lost catch-up history. Now 2gb/3G, which is as far as a 22 GiB box goes
  with Postgres at 6144M; past ~8k weekly actives the answer is Redis off-host,
  not a bigger number. Redis CPU also went 0.50 → 2.00, which is not yet binding
  (presence is ~1.4k ops/sec today) but caps the next 10x if left.

- **Channel fan-out was O(N²) in roster size, in BOTH fan-out modes.**
  messaging-svc computes a channel's full member list on every send and ships it
  inside the event; the gateway then wrote that whole event, roster included,
  into every recipient's outbox. One message to a 10,000-member channel was a
  ~390 KB payload stored 10,000 times — **~3.9 GB of Redis for a single "hello
  everyone"**. Stage 3 does not fix this: routed delivery removes the per-POD
  duplication but passes the same bytes to `AppendOutboxMulti`. Recipients are
  now resolved from the original event and the routing metadata stripped before
  anything is stored or transmitted (`internal/contract.DeliveryPayload`), so
  the cost is O(N). `members` became `.optional()` on the shared schemas to
  match: it is present on the bus and absent on delivery, and no client ever
  read it.

- **Every service ran migrations at boot with no lock.** Idempotent DDL is not
  concurrency-safe DDL: two pods issuing `CREATE INDEX IF NOT EXISTS` on the
  same relation deadlock rather than both no-op, and rolling deploys and HPA
  scale-ups start pods together by design. All six runners now take
  `pg_advisory_xact_lock`. The two Go ones also moved inside a transaction,
  without which the lock would have been decorative — the same trap the outbox
  pollers' `FOR UPDATE SKIP LOCKED` had before it got a real transaction. The
  runs are now atomic as a side effect, which is an improvement: a half-applied
  schema is no longer reachable.

- **notification-svc consumed strictly one message at a time.** Fetch, a DB
  transaction, then a synchronous offset commit — three round trips per event
  with no pipelining, on the highest-volume topic in the platform, and a ceiling
  that adding replicas could not lift because group parallelism is bounded by
  partition count. Now batched (200 messages / 25 ms linger) into one
  transaction and one offset commit. Guarantees are unchanged: offsets follow
  the transaction, redelivery is idempotent via the existing `event_id` dedup,
  and a poison message is skipped out of the batch rather than failing it.

- **ws-gateway's HPA ceiling was 12 pods**, i.e. 300k sockets — the fleet's real
  limit whatever the cluster size. Now 60. **This achieves nothing on its own**:
  the autoscaler still scales on CPU, which is nearly uncorrelated with how full
  a gateway pod is, so the `podMetric` block has to be enabled for the ceiling
  to be reachable.

The remaining Python consumers (task-svc, telemetry-svc, email-worker,
integrations-svc) still commit per message and want the same treatment; the
shape to copy is in `notification-svc/internal/consumer/consumer.go`.

**Stage 12 — the constraints that bound before ANY of the above.** Done.

A source audit aimed at "what actually breaks first" found that the binding
constraint was not Postgres, not Redis and not the gateway. It was four
application defects, and the first of them capped the platform roughly four
orders of magnitude below where the table at the end of this document says it
sits. None of them are architecture; all of them were invisible in production.

- **Every per-IP rate limit in the four Python services was ONE GLOBAL BUCKET.**
  They keyed on `slowapi.util.get_remote_address`, which reads
  `request.client.host` — and uvicorn only rewrites that when the immediate peer
  is in `--forwarded-allow-ips`, whose default is `127.0.0.1`. Caddy is a
  separate container on the bridge network, so it was never trusted and every
  request in the world arrived, as far as the limiter was concerned, from
  Caddy's address.

  So `POST /auth/login` was configured at 10/min per IP and **enforced at 10/min
  for the entire platform**; `/auth/refresh` at 30; the slowapi default at 120
  requests a minute for all of auth-svc. Because the sensitive limiter is
  Redis-backed, adding replicas made it worse rather than better. The practical
  ceiling was around a hundred concurrent users — not the ~10k DAU the table
  below claimed — and access tokens expire every 15 minutes, so a steady
  population above a few hundred saturated `/auth/refresh` alone and logged
  everybody out in waves.

  The `user:` half was dead too: it read `request.state.principal`, which
  nothing ever assigned, because the auth dependency takes a `Header` and runs
  long after `SlowAPIMiddleware` has already chosen a key. Both halves now go
  through a shared `app/net.py` (rightmost `X-Forwarded-For`, hop count
  configurable, matching the Go services' rule exactly), and a
  `PrincipalMiddleware` verifies the bearer token before the limiter runs — which
  also removes a duplicate verification rather than adding one.

- **One message could permanently stop every event in the platform.** Message
  bodies were checked for emptiness and nothing else, so the only ceiling was
  the 1 MiB request cap — and a body travels, in plaintext, into an outbox row
  that becomes a Kafka message. kafka-go's `BatchBytes` defaults to 1 MiB and is
  checked PER MESSAGE before anything is sent, so one oversized row failed the
  whole `WriteMessages` call and took the 499 healthy rows batched with it. The
  poller then re-claimed the same `ORDER BY created_at` head of the queue every
  500 ms, forever, with every message, notification, task and integration event
  for every organisation queued behind it. kafka-go's own comment says the
  caller must discard the offending message and retry; none of the six pollers
  did, and none had a dead-letter path.

  Now: `MaxMessageBodyBytes` (8 KiB, byte-counted) at every send site,
  `BatchBytes` stated rather than inherited, and all six pollers quarantine
  rather than retry — oversize rows before they are offered to the producer,
  everything else on an attempt counter. Quarantined rows are marked, never
  deleted, and page (`OutboxDeadLettered`).

- **The same uncapped body could fill Redis, which is `noeviction`.**
  `contract/payload.go` already strips the roster and does the O(N²) arithmetic;
  `body` necessarily stays, and is written once per recipient. 500 KB into a
  5,000-member channel is 2.5 GB, and because `noeviction` applies to the whole
  keyspace it takes presence, the node registry and the shared rate-limit
  buckets down with the replay outbox. The body cap closes this too — same root
  cause, and the reason it is one fix rather than three.

- **The replay cursor dropped same-millisecond events, permanently.** The
  outbox score is `occurredAt` in milliseconds and the client's high-water mark
  is `Date.parse(occurredAt)`, which carries no finer precision — so the cursor
  cannot separate two events sharing a millisecond, and the bound was exclusive.
  A client that received A at time T and lost its socket before B (also at T)
  asked for "strictly after T" on reconnect and never saw B again: no error, no
  retry, no metric, and the dedup LRU is per-instance so nothing downstream
  noticed. Now inclusive, which turns silent loss into a duplicate the client's
  existing `eventId` dedup already absorbs.

Four more, smaller, in the same pass:

- **Broadcast mode punched a hole in the replay outbox on every restart.** The
  consumer group was `"ws-gateway-"+uuid.NewString()` — unique per pod, which is
  required, and maximally unstable, which is not. A group with no committed
  offset starts at the tip, and in this mode the gateway is the ONLY writer of
  the replay outbox, so everything published while a pod was down was never
  written to anybody's catch-up buffer. `WS_BROADCAST_GROUP_ID` now defaults to
  the hostname; a Deployment rollout still needs it set explicitly, and the pod
  says so at boot.
- **delivery-svc committed offsets before processing.** `ReadMessage` is
  `FetchMessage` + `CommitMessages`, so the offset moved as part of the read and
  a crash mid-`Route` skipped the event — at-most-once, in a file whose comment
  claimed the opposite. Both consumers now fetch and commit explicitly.
- **Nothing in the event plumbing was ever deleted.** `DELETE FROM outbox`
  appeared nowhere in the repository, in any of the five services that have one.
  Roughly four permanent rows per event, with full JSON payloads, on the single
  primary — and `outbox.payload` holds message bodies as plaintext while
  `messages.body_enc` holds them encrypted, so the at-rest property did not hold
  for the copy that outlived the original. `idempotency_keys` even had the index
  for a sweeper that was never written. Retention now runs nightly
  (`prune-event-tables`, Helm CronJobs and a systemd timer), pruning only what
  nothing can still use and never touching unpublished or dead-lettered rows.
- **Migrations replayed in full on every boot.** No ledger, so every file ran
  every start — `ALTER TABLE messages ADD COLUMN IF NOT EXISTS` takes an ACCESS
  EXCLUSIVE lock on the hottest table before deciding to do nothing, and the
  whole run is serialised behind one advisory lock, so an N-pod scale-up cost
  N × the entire DDL suite exactly when capacity was needed. All six runners now
  keep `schema_migrations`; the lock and the single transaction stay.

Also in this pass, as optimisation rather than correction: `AddChannelMembers`
went from four round trips per member inside one transaction (≈2,000 statements
to add a 500-person department, holding back the xmin horizon for the duration)
to four statements total, using `ON CONFLICT ... RETURNING` to learn which rows
were genuinely new — which is race-free where the old existence check was not.
And the clients finally use `/presence/query`: the bounded endpoint had been
implemented, documented here as "the one clients should move to", and had **no
client method at all**, so the org-wide sorted-set read was still the only path
in production.

### Still not done, and what each needs from you

- **There is no read cache anywhere in the platform.** Redis serves presence,
  the replay outbox, the node registry and rate-limit buckets — and nothing
  else. Not one read path in any of the eight services is cached, so every
  channel list, message page, inbox render and profile lookup goes to the one
  Postgres primary. At chat read/write ratios this is the largest single
  multiplier available, and it is cheaper than any infrastructure on this page.
  Start with channel rosters and `user_projection`, which are hot, small, and
  tolerate seconds of staleness.
- **Telemetry beacons write synchronously into the OLTP primary.**
  `POST /telemetry/beacon` opens a transaction, touches the session row, inserts
  the batch and commits, inline on the request. Range partitioning by day is the
  right start and buys cheap pruning, but at the volumes this document is about
  behavioural telemetry does not belong in the primary at all: accept to Kafka,
  batch-load to a columnar store, keep the rollups. Needs a decision on which
  store before it can be built.
- **No full-text search exists.** No `tsvector`, no `pg_trgm`, no external
  index. Users will expect to search their messages, and retrofitting that
  across an encrypted-at-rest `messages.body_enc` is a design problem worth
  starting BEFORE sharding rather than after.

- **A blocking Vault call on the event loop, if you ever enable KMS.**
  `crypto.py` in auth-svc, task-svc, telemetry-svc and integrations-svc calls
  `httpx.post` — the SYNCHRONOUS client — to wrap and unwrap per-org data keys.
  Each of those services runs one uvicorn worker, so one event loop per pod, and
  a blocking call on it stalls every other in-flight request on that pod, not
  just the one doing crypto. The per-org DEK cache keeps it off the common path,
  but with a five-minute TTL a pod serving many orgs still misses regularly —
  and if Vault is merely SLOW, each miss blocks for up to the five-second
  timeout, which is enough to make a pod serve nothing at all. A degraded
  dependency becomes a total outage of unrelated traffic.
  **Latent, not live**: `DATA_KEK_PROVIDER` defaults to `dev` and nothing in the
  shipped config sets it to `kms`, so this code does not currently run. Turning
  KMS on means moving the call to `httpx.AsyncClient` (or `asyncio.to_thread`,
  as the Argon2 hashing already does) FIRST — the same fix, in the same shape,
  as the password-hashing one.
- **Kafka off the bundled broker.** Still RF=1 on one container, which loses
  in-flight events on restart — the most urgent durability gap in the system.
  The client-side work is now done, so this is provisioning a managed 3-broker
  cluster and setting `REPLICATION_FACTOR=3`.
- **Actually running the migrations above.** Stages 3, 4 and 5 all ship off by
  default. **Order matters**: route fan-out before sharding Redis, or a cluster
  distributes the amplified load rather than removing it.
- **Org-wide presence is one Redis key per org, and one key lives on one node.**
  Stage 7 removed the N-way read amplification but not the underlying shape: a
  presence transition in a very large org still reads that org's whole online
  set, and a big org is a hot slot no amount of sharding relieves. The fix is a
  presence *subscription* — clients declare whose presence they are displaying
  (the people in view, not the org) and the publisher intersects against that —
  which is a product decision as much as a storage one.
- **Postgres sharding.** The actual wall, a multi-quarter project. Every table
  carries `org_id`, which is the hard part done — with **one exception found
  during the calls work**: `RedeemInvite` looks up a meeting invite by token
  hash alone, because the redeemer's org is deliberately irrelevant (that is
  what makes cross-org meeting links work). Under org sharding there is no
  `org_id` to route that query by. It needs either a small global directory
  mapping `token_hash → org_id`, or the shard encoded into the token itself —
  cheaper, but it leaks shard topology into a credential and constrains future
  resharding. The same question applies to any future cross-org feature and is
  worth deciding once, deliberately, rather than per feature.

### The honest ceiling

None of the above reaches a billion daily actives, and no amount of
configuration will. That is roughly 10-30M concurrent sockets and sustained
writes north of a million a second; this stack still has one Postgres primary,
one Kafka broker and one region.

What the staged work buys is different from what the original roadmap assumed.
The roadmap treated the ceiling as infrastructure — shard Postgres, cluster
Redis, multi-cluster Kafka. That is all still true and still necessary, but it
was not the binding constraint: the gateway's broadcast fan-out meant the
real-time tier got *worse* as the fleet grew, so buying infrastructure would
have distributed an amplified load rather than removed it. Stage 3 removes the
amplification; stages 4-6 are what the infrastructure spend then buys.

Order of magnitude with the work above deployed and a managed data tier:
10⁵-10⁶ DAU. Past that is sharding, multi-region, and an SFU fleet — the last
third of this document, with SRE ownership attached.

**What the deployed stack is good for, in three numbers.** These are different
questions and the answers differ by two orders of magnitude, which is why
quoting `WS_MAX_CONNECTIONS` as a capacity figure was so misleading:

| Configuration | Comfortable | Ceiling | What gives out |
|---|---|---|---|
| Compose, one VPS, hatches off, Redis at 400mb | ~500 WAU | ~1.5-3k WAU | Redis fills; presence AND replay fail together |
| Same, with Stage 11's Redis sizing | ~10k DAU | ~50k DAU | Postgres at 2 CPU with no read cache |
| Helm, managed data tier, hatches on | ~300k DAU | ~1M DAU | The three application-layer gaps above |

**These numbers were wrong until Stage 12, and worth saying so plainly.** Rows
two and three describe what Postgres and Redis can carry, and that arithmetic
was right — but the platform never reached either, because auth-svc was capped
at 120 requests a minute in total by a rate limiter keying on the reverse
proxy's address. The real ceiling was around a hundred concurrent users, and
every capacity conversation before this was about the wrong bottleneck.

The lesson generalises past this bug: the constraint was not in any of the three
tiers this document spends its length on. It was a default in a web server, and
it was invisible because the system worked — requests succeeded, 429s looked
like a limiter doing its job, and only counting them revealed that every caller
on earth shared one bucket. Verify a capacity figure against a load test before
planning against it; every number in this table remains arithmetic.

1B DAU is **not** 1M concurrent, and conflating them has produced bad capacity
decisions here before. At 20-40 min/day of engagement, 1B DAU is 10-30M
concurrent sockets; 1M concurrent is 30-100M DAU. 1M concurrent is a fundable
milestone that lands on the sharding rung. The billion is a direction.

Nothing in stages 3-6 has been exercised under load. The routing logic is tested
against fakes, the transport against a real listener, and the Redis cluster path
is reasoned and unit-tested but has never met a cluster. Treat the figures here
as arithmetic, not measurement, until a staging run says otherwise.
