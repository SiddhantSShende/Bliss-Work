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
| ws-gateway (stateful: holds the open socket) | Horizontal autoscale + sticky load-balancing by `userId` (consistent hash); shared Redis pub/sub already fans out across pods |
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

- **Multi-cluster + MirrorMaker2** across regions: producers write to the
  region-local cluster, MirrorMaker2 mirrors to peers.
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

- Frontend code splitting / bundle size optimisation. The Vite build already
  splits by route; bundle size monitoring is a separate concern.
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
