# The GraphQL gateway (`graph-gw`)

A **read-composition** gateway in front of the REST services. It is not a new
API for the platform and it is not a migration target — it fronts a handful of
screens that were paying to assemble their data in the browser, and everything
else keeps talking to the services directly.

```
Frontend ──(a few reads)──> graph-gw ──> REST APIs ──> services
Frontend ──(everything else)───────────> REST APIs ──> services
```

That second line is the important one. This is a **selective** gateway, not a
three-tier pipeline where every request passes through all three layers.

## What it fronts, and what it must never front

| Traffic | Route | Why |
|---|---|---|
| Inbox peers + their accounts | **graph-gw** | The composition this was built for |
| Meeting roster / card names | **graph-gw** | Knows its participant ids up front |
| Incoming-call caller name | **graph-gw** | One id, on the most latency-sensitive path in the product |
| Writes / mutations | REST | They carry idempotency keys and optimistic patches wired into the WebSocket event stream. Re-expressing them buys nothing and risks all of it. |
| Realtime | ws-gateway | Replay, UUIDv7 dedup, presence and WebRTC signaling already work. GraphQL subscriptions would be a weaker second copy. |
| Attachment upload, `/media/*` | REST | 100 MB bodies with a deliberate WAF bypass at the edge. A resolver cannot stream these. |
| Auth, refresh, JWKS | REST | The refresh token rotates and must stay single-flight. |
| `.xlsx` exports | REST | Streamed binary. |

### The call and meeting features specifically

Most of what a call does never touches REST, so most of it has nothing to do
with this gateway. The test is not "is it new" — it is **"does it fetch people
it could have named"**.

| Feature | Transport | On the graph? |
|---|---|---|
| Raise hand | LiveKit room data messages | No — never hits REST |
| Shared notes | LiveKit room data messages | No |
| Recording notice | LiveKit room data messages | No |
| Start/stop recording | REST mutation | No — writes stay on REST |
| Room member list | LiveKit participants | No — live SDK state, not a query |
| Screen-share state | LiveKit + REST mutation | No |
| Attachments / media | Batched signed-URL mint | No — already one request, and the payload is binary |
| **Meeting roster sheet + card** | was `GET /auth/directory` | **Yes** — it has `call.participants` in hand |
| **Incoming-call caller name** | was `GET /auth/directory` | **Yes** — one id |

The last two were downloading up to 5,000 users to read a handful of names. The
incoming-call one is the worst case in the app: a ringing phone is the least
patient moment in the product, and it was fetching the entire organisation to
put a name on it.

## Why it exists

`GET /auth/directory` is called from seventeen places and returns up to 5,000
users. Screens that needed a name and an address for the dozen rows on screen
had no way to ask for a dozen, so they fetched the whole organisation and joined
it in the browser. The gateway lets a screen ask for exactly what it renders:

```graphql
inboxPeers { peerId displayName user { displayName email } }
```

One request from the browser, two calls inside the datacenter, and the user
lookups for every row collapsed into one by a DataLoader.

## Invariants

These are load-bearing. A gateway is exactly the kind of component that quietly
breaks them.

- **It holds no credential.** Every upstream call carries the end user's
  `Authorization` header exactly as it arrived. Each service derives
  `orgId`/`userId` from the JWT it verifies itself and applies RLS from that. A
  service account here would defeat every tenant boundary at once.
- **It accepts no identity from the client.** No resolver takes an org or user
  id as an argument for scoping. There is no code path where a resolver runs
  without a caller — `createContext` refuses the request first.
- **It owns no database.** Every field resolves through a service's HTTP API.
  Task titles, for instance, are encrypted and only task-svc can read them.
- **Loaders are per request.** DataLoader's cache is keyed by id alone and
  carries no tenant, so a loader that outlived a request would serve one org's
  users to the next caller. `createLoaders` is called once per request and its
  result is never hoisted.
- **Only registered operations execute.** See below.

## Trusted documents

The gateway executes the operations in
`packages/shared/src/graphql/operations.ts` and refuses everything else. Clients
send the operation **name**, not the document:

```
GET /graphql?operationName=InboxOverview&variables={"kinds":["MAIL","THREAD"]}
```

Both sides import that registry from the same workspace, so there is only one
copy of each document and nothing for a content hash to prove — which is why the
id is a readable name rather than a sha256. It stays legible in a URL, an access
log and a CDN cache key.

Three things follow, and all three are the point:

1. The document is not on the wire; only a name and variables are.
2. It is a **GET with a stable URL**, so browsers and CDNs can cache it. A
   POST-only `/graphql` would throw away the HTTP caching the REST endpoints
   behind Caddy already get — which would make the gateway a net downgrade.
3. Query-depth and query-injection abuse is removed as a class rather than
   mitigated.

### Scoping a screen to the people it draws

`useUserLabels(ids)` takes the id list when the caller knows it:

```ts
const { nameOf } = useUserLabels(call.participants.map((p) => p.userId));
```

With a gateway configured that resolves exactly those people; without one — or
called with no argument — it uses the directory exactly as before. So callers
can be converted one at a time, and a screen whose ids only arrive over a socket
(a paginated feed) keeps calling it bare.

### Adding an operation

Add it to `GRAPHQL_OPERATIONS`, then call it:

```ts
api.graphql("MyOperation", { some: "variable" }, MyZodSchema)
```

There is no manifest to regenerate and no build step. The name of the export must
match the operation name inside the document; a test asserts it.

## Configuration

Both safety switches default to **off** and `loadConfig` refuses to boot
production with either enabled.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8007` | |
| `AUTH_BASE` | — | In-network, e.g. `http://auth-svc:8001`. Required in production. |
| `MESSAGING_BASE` | — | e.g. `http://messaging-svc:8004`. Required in production. |
| `UPSTREAM_TIMEOUT_MS` | `5000` | Must stay below the browser client's 30s so the gateway fails first and can answer with a partial result. |
| `BREAKER_THRESHOLD` | `5` | Consecutive 5xx before a service's breaker opens. 4xx does not count — that is the caller's fault. |
| `BREAKER_RESET_MS` | `10000` | Then one probe is admitted. |
| `GRAPHQL_MAX_DEPTH` | `10` | Belt-and-braces behind the allow-list. |
| `GRAPHQL_ALLOW_ARBITRARY_QUERIES` | `false` | **Cannot be enabled in production.** |
| `GRAPHQL_INTROSPECTION` | `false` | **Cannot be enabled in production.** |

Only the exact string `true` enables a flag, so a typo fails safe.

## Turning it on for the frontend

The frontend takes its REST path unless `VITE_GRAPH_BASE` is set at build time:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg VITE_GRAPH_BASE=https://$DOMAIN/graphql .
```

Unset means every screen behaves exactly as it did before, which is what makes
the rollout reversible by configuration rather than by deploy.

## Degradation

The gateway is a hard dependency for every screen that moves onto it, so it
fails loudly and partially rather than hanging:

- Per-upstream timeout below the client's own.
- A circuit breaker per service; one service's outage cannot trip another's.
- A resolver error nulls its field and reports which service failed, leaving the
  rest of the response intact. A screen missing one panel beats a screen that
  spins.
- `traceparent` and `x-request-id` are forwarded to every upstream call, so the
  gateway does not break the distributed traces the platform already collects.

## Running it in production

### Deploying

It is in `docker-compose.prod.yml` (2 replicas, 1 CPU / 512 MB each, read-only
root filesystem, `cap_drop: ALL`, no published ports — reached only through
Caddy) and in the Helm chart's `values.yaml`, which yields a Deployment,
Service, HPA (2–6 on 70% CPU) and PDB like every other service.

```bash
# compose
sudo docker compose -f docker-compose.prod.yml up -d --build graph-gw
```

The edge route lives in `infra/caddy/Caddyfile.waf` (the file prod mounts) as
`handle /graphql`. **Caddy will not pick it up on a reload** — the Caddyfile is
a single-file bind mount, so the container has to be recreated.

### Deploying it dark

`VITE_GRAPH_BASE` is empty in `.env.prod.example` on purpose. With it unset the
gateway runs, is scraped and is reachable, but no browser calls it, because the
bundle takes its REST paths. Set it and rebuild the web bundle to move the
screens onto it.

That is also the entire rollback: unset it, rebuild the bundle. No service to
stop, no traffic to drain, no migration to reverse.

### Metrics

Scraped at `graph-gw:8007/metrics` (`job_name: graph-gw` in
`infra/observability/prometheus.yml`).

| Series | Why it is there |
|---|---|
| `http_requests_total`, `http_request_duration_seconds` | Same names and buckets as the Go services, so existing panels work unchanged |
| `graphql_operations_total{operation,outcome}` | `outcome` separates `ok` / `partial` / `error` — a partial result is the designed degradation, not an outage |
| `graphql_upstream_calls_total{service,outcome}` | `outcome` distinguishes `http_503` from `timeout` from `breaker_open` |
| `graphql_upstream_duration_seconds{service}` | Which backing service is slow |
| `graphql_upstream_breaker_open{service}` | 1 while a breaker is open |
| **`graphql_loader_batch_size{loader}`** | **The one that matters.** If p99 stays at 1 while pages grow, batching has regressed and the gateway is costing more than the client-side joins it replaced |
| `graph_gw_nodejs_eventloop_lag_seconds` | On a service whose whole job is fanning out I/O, loop lag moves before errors do |

The `operation` label is the REGISTERED name — an unknown operation is rejected
before execution — so no client can drive its cardinality.

### Tracing

Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`, exactly like the Python services: unset
means no provider, no exporter and no startup change.

Each upstream call gets its own span and injects the live trace context, so one
browser request is **one trace across three processes**:

```
GET (inbound)                 ← root
├─ GET messaging-svc          ← parent: the inbound span
└─ GET auth-svc
```

This is deliberate rather than automatic. The platform's HTTP instrumentation
patches `node:http`; this client uses `fetch`, so without the explicit spans in
`upstream.ts` the gateway would emit one span for the request and nothing for
the calls it fans out — traces stopping at exactly the hop it added.

### Logging

One JSON object per line, `event` naming what happened, `request_id` correlating
with the upstream calls it caused. The logger **redacts credentials by key** at
any nesting depth: this process holds a bearer token on every request, and
`log.info("x", { caller })` would otherwise write live access tokens into Loki.

### Shutdown

`SIGTERM` fails `/readyz` first, so the load balancer removes the replica before
the socket stops accepting; then in-flight requests drain for
`SHUTDOWN_GRACE_MS` (default 15s, and it must exceed `UPSTREAM_TIMEOUT_MS` or a
rolling deploy cuts requests still waiting on a legitimately slow upstream).

`/readyz` deliberately does **not** probe the upstreams. A gateway whose
readiness tracked auth-svc would take itself out of rotation during an outage it
is designed to degrade through — the partial-result path exists precisely so the
screen still renders. Upstream health is a metric, not a readiness signal.

## What this does NOT solve

Nothing in `BOTTLENECK_ANALYSIS.md`'s top three. There is still no read cache in
any of the eight services, Kafka still runs one broker at RF=1, and the staged
fan-out migrations still ship disabled. A gateway response cache would land the
first of those at one chokepoint instead of eight — that is the obvious next
step, and it is deliberately not in this change.

## Tests

```bash
npm run test -w @taskboard/graph-gw     # gateway: 72 tests
npm run test -w @taskboard/shared       # includes the client transport
npm run test -w @taskboard/app          # includes the hook and label rules
cd services/auth-svc && pytest tests/test_directory_batch.py
```

`test/gateway.test.ts` drives a real Yoga instance with only the network stubbed.
Its headline assertion counts upstream calls rather than reading the resolvers,
so a change that reintroduces the N+1 fails there.
