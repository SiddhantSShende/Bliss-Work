# Observability — Security & Reliability Alerts

Prometheus alert rules that fire on the HTTP metrics every service already
exposes, routed through Alertmanager. This is the SecOps alerting layer on top
of the opt-in observability stack. For the threat model and controls, see
[SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md) — this doc
does not repeat them; it covers only the alerting wiring.

## Where things live

| Thing | Path |
| --- | --- |
| Prometheus scrape + `rule_files` + `alerting` | `infra/observability/prometheus.yml` |
| Alert rules — auth/ratelimit/5xx/availability | `infra/observability/prometheus/rules/security.yml` |
| Alert rules — Postgres/Redis/Kafka/container/disk saturation | `infra/observability/prometheus/rules/saturation.yml` |
| Alert rules + recording rules — ws-gateway fan-out, capacity, media | `infra/observability/prometheus/rules/gateway.yml` |
| Alert rules — outbox dead-lettering, auth rate-limit saturation | `infra/observability/prometheus/rules/eventpipeline.yml` |
| Alertmanager config | `infra/observability/alertmanager/alertmanager.yml` |
| Compose services (`prometheus`, `alertmanager`, …) | `docker-compose.yml`, profile `observability` |

**Updated 2026-08-27**: this doc previously documented only `security.yml`'s 7
alerts. Three more rule files exist and were undocumented — 25 more alerts
(32 total) plus 6 recording rules, all already wired into
`infra/observability/prometheus.yml` and firing in production. Nothing below
is new; this is a doc-accuracy fix.

## Running it

The whole stack is opt-in behind the `observability` profile:

```bash
docker compose --profile observability up -d
# Prometheus  http://localhost:9091   (Status > Rules, Alerts tabs)
# Alertmanager http://localhost:9093
# Grafana     http://localhost:3000   (anonymous admin)
```

Reload rules after editing without a restart:

```bash
docker compose --profile observability exec prometheus kill -HUP 1
# or: curl -X POST http://localhost:9091/-/reload   (needs --web.enable-lifecycle)
```

## The alerts

### `security.yml` — auth, rate limiting, error rate, availability

| Alert | Fires when | Severity |
| --- | --- | --- |
| `AuthCredentialStuffingBurst` | auth-svc rejects >1 req/s (exact 401) on `/auth/login` or `/auth/refresh` for 2m | warning |
| `AuthCredentialStuffingHigh` | same, >10 req/s for 1m (active attack) | critical |
| `RateLimitRejectionsSpike` | a Go service (messaging-svc/notification-svc/ws-gateway) returns >1 req/s of HTTP 429 for 2m | warning |
| `PythonRateLimitRejectionsSpike` | auth-svc/task-svc returns >1 req/s of HTTP 429 for 2m | warning |
| `ServiceHigh5xxErrorRate` | a service's 5xx ratio > 5% for 5m | warning |
| `ServiceCritical5xxErrorRate` | a service's 5xx ratio > 20% for 2m | critical |
| `CoreServiceDown` | `up == 0` for auth-/messaging-/task-svc for 1m | critical |

### `saturation.yml` — the ceilings this deployment hits first

| Alert | Fires when | Severity |
| --- | --- | --- |
| `PostgresConnectionsHigh` | pooled connections > 60% of `max_connections` for 5m | warning |
| `PostgresConnectionsCritical` | > 85% for 2m | critical |
| `PostgresCacheHitRatioLow` | buffer cache hit ratio < 95% for 15m (working set outgrew `shared_buffers`, or a query is scanning) | warning |
| `PostgresDeadTuplesHigh` | a table has > 5M dead tuples for 30m (autovacuum losing to write volume) | warning |
| `RedisMemoryHigh` | Redis used memory > 75% of `maxmemory` for 10m | warning |
| `RedisMemoryCritical` | > 90% for 2m (writes about to start failing — `noeviction`) | critical |
| `RedisRejectingWrites` | Redis is actively rejecting connections | critical |
| `KafkaConsumerLagHigh` | a consumer group is > 10,000 messages behind for 10m | warning |
| `KafkaConsumerLagGrowing` | a consumer group's lag grew > 50,000 in 30m for 5m (not recovering on its own) | critical |
| `ContainerCPUThrottled` | a container is CFS-throttled on > 25% of periods for 10m (latency without high utilization) | warning |
| `ContainerMemoryNearLimit` | a container is within 10% of its memory limit for 5m | critical |
| `ContainerOOMKilled` | any container was OOM-killed in the last 15m | critical |
| `HostDiskFillingUp` | the root volume (shared by Postgres/Kafka/Redis/media/logs) is > 80% full for 15m | warning |

### `gateway.yml` — ws-gateway fan-out efficiency, cross-node delivery, capacity, media

Six recording rules (`ws:fanout_discarded:ratio`, `ws:fanout_discarded:ratio_by_instance`, `ws:outbox_writes:rate`, `ws:redis_ops:rate_by_purpose`, `ws:node_fanout_remote:ratio`, `ws:route_cache:hit_ratio`) make the broadcast-fan-out cost and cache effectiveness visible over time — not alerts themselves, since what they measure is the current architecture rather than a fault; they're what makes "did routed fan-out actually help" a question with a before/after answer.

| Alert | Fires when | Severity |
| --- | --- | --- |
| `WSGatewayCrossNodeDeliveryUnroutable` | > 50% of cross-node RTC/presence recipients are unroutable for 15m (usual cause: `WS_ADVERTISE_ADDR` unset on a multi-pod fleet — silent otherwise, no error rate moves) | critical |
| `WSGatewayCrossNodePushFailing` | > 10% of gateway-to-gateway pushes are erroring for 10m (pod-to-pod connectivity or `TB_INTERNAL_TOKEN` mismatch) | warning |
| `WSGatewayRefusingConnectionsAtNodeCap` | any socket refused with 1013 at the per-node `WS_MAX_CONNECTIONS` cap | critical |
| `WSGatewayPerUserCapHit` | sustained refusals at `WS_MAX_CONNS_PER_USER` for 10m (client reconnect loop, not a capacity problem) | warning |
| `WSGatewaySheddingSlowConsumers` | sockets are being dropped for full send buffers, > 1/5m sustained for 10m | warning |
| `WSGatewayOutboxWriteErrors` | replay-outbox writes to Redis are failing (usually `RedisMemoryCritical`) | critical |
| `WSGatewayRedisSlow` | ws-gateway's Redis p99 > 50ms for a given purpose, for 10m | warning |
| `WSGatewayTurnUnavailable` | ICE credentials are being issued STUN-only (no `TURN_SECRET`/`TURN_URLS`) for 15m — silent otherwise, ~10-20% of calls fail behind symmetric NAT with no error rate moving | critical |

### `eventpipeline.yml` — the outbox, and post-fix rate-limit sanity

| Alert | Fires when | Severity |
| --- | --- | --- |
| `OutboxDeadLettered` | any outbox row was quarantined as unpublishable in the last 15m (an event a user triggered will never be delivered — the write succeeded and the API returned 201) | critical |
| `OutboxDeadLetterBacklog` | quarantined rows have sat undelivered for > 10m | warning |
| `OutboxNotDraining` | the outbox has published nothing for 15m while writes are still arriving (broker unreachable, or topic missing) | critical |
| `AuthRateLimitingSaturated` | over half of auth-svc requests are being 429'd for 10m (real attack, or `TRUSTED_PROXY_HOPS` misconfigured back into one shared global bucket) | warning |

## Metric-label reality (why the rules look the way they do)

**Both service families now emit exact numeric status codes.** This section
previously described Python services as grouping into `2xx`/`4xx`/`5xx` classes
with exact-code alerting listed as an optional future change — that change has
since shipped (`services/auth-svc/app/main.py` and
`services/task-svc/app/main.py` both call
`Instrumentator(should_group_status_codes=False)`), so both families are exact
today:

- **Python services (auth-svc, task-svc)** — `prometheus-fastapi-instrumentator`
  7.0.0, `should_group_status_codes=False`. Labels: `handler`, `method`,
  `status`, where **`status` is the exact numeric code** (`"401"`, `"429"`,
  `"500"`). `AuthCredentialStuffingBurst`/`High` and
  `PythonRateLimitRejectionsSpike` alert on the literal codes.
- **Go services (messaging-svc, notification-svc, ws-gateway)** — hand-rolled
  collector. Labels: `method`, `path`, `status`, also the exact numeric code.
- `ServiceHigh5xxErrorRate`/`ServiceCritical5xxErrorRate` in `security.yml`
  still match `status=~"5xx|5.."` — a regex covering both an exact `5xx`-prefixed
  code and (defensively) a literal `"5xx"` class string, so the rule keeps
  working unchanged if either family's grouping setting ever changes again.
- Prometheus adds `job="<service>"` from `scrape_configs`; the rules aggregate
  by `job`.

## Alertmanager routing

`alertmanager.yml` ships a **dev default**: every alert goes to one webhook
receiver pointed at an in-network sink so the send always succeeds locally
without external credentials. It also defines an inhibit rule so a firing
`critical` suppresses the sibling `warning` for the same `alertname`/`job`.

**Production** does NOT use `alertmanager.yml`. `docker-compose.prod.yml` mounts
`alertmanager.prod.yml`, which delivers every alert to one webhook whose URL is
read from a secret file (`url_file`). Set `ALERTMANAGER_WEBHOOK_URL_FILE` in
`.env.prod` to the host path of that file (see `.env.prod.example`); compose
refuses to run without it. `scripts/check-alertmanager-prod.mjs` guards this.

Further provider receivers (add to `alertmanager.prod.yml`; stubbed in
`alertmanager.yml`):

- **Slack** — `slack_configs` with an incoming-webhook `api_url` (inject via a
  secret/file, not inline), one channel per `category`/`severity` route.
- **PagerDuty** — `pagerduty_configs` with a `routing_key`, mapping
  `severity` → PD urgency, for the `critical` route.
- **Email** — `email_configs` with an SMTP smarthost.

Add severity/category branches under `route.routes` (see the commented block) so
`critical` pages PagerDuty while `category=security` also copies a SecOps Slack
channel.

## Extending

1. Add a rule to a group in the relevant file (`security.yml`, `saturation.yml`,
   `gateway.yml`, `eventpipeline.yml`), or a new `*.yml` in the same `rules/`
   dir — the glob picks it up. Always confirm the label set against a real
   scrape first; both Python and Go services emit exact numeric `status` codes
   today (see "Metric-label reality" above).
2. Validate every rule file at once:
   `promtool check rules infra/observability/prometheus/rules/*.yml`
   (the `prom/prometheus` image bundles `promtool`).
3. Reload Prometheus (see above) and watch **Status > Rules**.
4. For a new receiver, add it under `receivers:` and a matching `route` branch.
