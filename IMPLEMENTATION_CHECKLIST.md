# BlissWork implementation checklist

**Refreshed 2026-08-17 against branch `VPS-Shristi`.**

File-level checklist for the outstanding work. Item numbers match
`CLAUDE_OPTIMIZATION_PROMPTS.md`; the rationale is in `BOTTLENECK_ANALYSIS.md`.

> **What changed in this refresh.** The previous version opened with a checklist
> for installing OpenTelemetry across eight services. All of it was already
> installed. Every item below was verified as genuinely outstanding by reading
> the source, and every path cited was confirmed to exist.

**Before starting anything:** the working tree currently carries substantial
uncommitted work (LiveKit calls, presence, prune jobs). Land or stash that
first — none of the items below should share a commit with it.

---

## 1.1 — Read cache

**Owner service:** messaging-svc (both entities live there)

### Wiring

- [ ] Reuse the existing Redis client pattern rather than adding a second one.
      `internal/middleware/ratelimit_shared.go:123` already constructs a
      `go-redis` client from `REDIS_URL` — follow it, including how it handles
      a missing URL.
- [ ] `READ_CACHE_ENABLED` env var, **default off**. Matches how stages 3-5
      ship, and lets this go to production dark.
      - [ ] `Bliss-Work/.env.prod.example`
      - [ ] `Bliss-Work/docker-compose.prod.yml` (messaging-svc env)
      - [ ] `deploy/helm/taskboard/values.yaml`
- [ ] Cache miss must be byte-identical to cache-disabled. A Redis error is a
      miss plus a metric, never a 500.

### Entity 1 — channel rosters

- [ ] `internal/store/channels.go:319` — `channelMemberIDs()`. This is the hot
      one: messaging-svc computes a channel's full member list **on every
      send**.
- [ ] Invalidate in `AddChannelMembers` (`channels.go:62`) and on the removal
      path in `channels_membership.go`.
- [ ] Check `InternalChannelMembership` (`channels_membership.go:225`) — decide
      explicitly whether it shares the cache or bypasses it, and write down why.

### Entity 2 — user_projection

- [ ] `internal/store/channels_read.go` and `internal/store/store.go` are the
      read sites.
- [ ] Invalidation is **cross-service**: auth-svc owns the mutation
      (`app/routes/members_service.py`) and messaging-svc owns the cache. The
      projection is already kept current through the event bus — carry the
      invalidation on that existing path rather than adding a new one.
- [ ] `migrations/0011_user_projection_active.sql` documents the active-flag
      semantics; a stale cache must not resurrect an inactive user.

### Do not

- [ ] **Do not cache inbox paths.** Read-after-write; this is exactly why they
      were kept off the read replica (`cmd/server/main.go:101`).
- [ ] **Do not build a Kafka cache-invalidation topic.** Two keys do not need a
      bus.

### Verify

- [ ] Hit/miss counters per entity, exported with the existing metrics.
- [ ] Hit-ratio recording rule in
      `infra/observability/prometheus/rules/`.
- [ ] State the added Redis memory at 10k DAU against the **2gb `noeviction`**
      budget. The replay outbox is already sized in weekly actives against that
      same budget — the cache is not free of it.

---

## 1.2 — Frontend bundle split

### Measure first

- [ ] `npm run build --workspace @taskboard/web`, then
      `ls -la apps/web/dist/assets/`. Baseline as of this audit:
      **`index-*.js` = 1,485,567 B**, `exceljs.min-*.js` = 940,194 B,
      `index-*.css` = 69,461 B.

### Split

- [ ] `packages/app/src/App.tsx` — `React.lazy` + `Suspense` for authenticated
      routes.
- [ ] **Keep in the main chunk:** `Login`, `Onboarding`, `InviteAccept`,
      `ForgotPassword`, `ResetPassword`, `VerifyEmail`. First paint; lazy-loading
      them adds a round trip to the critical path.
- [ ] Split the heavy non-common paths:
      - [ ] Call UI — `CallRoom`, `CallControls`, `ScreenSharePopup`,
            `JoinCallView`, `Meetings` (these pull LiveKit)
      - [ ] `Integrations`
      - [ ] `Search`
- [ ] `apps/web/vite.config.ts` — add `manualChunks` with a stable vendor chunk
      for `react`, `react-dom`, `react-router-dom`. Leave `requireServiceUrls`
      untouched.

### The failure mode that matters

- [ ] Every new lazy boundary must be covered by
      `packages/app/src/lib/chunkReloadRecovery.ts`. **It already exists** — it
      was written for the exceljs import, because when a deploy removes a chunk
      a newer build no longer has, the dynamic import 404s. This is the one way
      route splitting breaks in production.

### Guard

- [ ] Entry-chunk size budget in `Bliss-Work/.github/workflows/ci.yml`. Set the
      threshold from the post-split measurement, not from a target invented in
      advance.
- [ ] Record before/after entry-chunk bytes in the PR description.

### Correct the record

- [ ] `Bliss-Work/INFRASTRUCTURE.md:140` claims "the Vite build already splits
      by route" and excludes frontend work on that basis. It does not split by
      route. Fix that line.

---

## 2.1 — Kafka off the bundled broker

**No application code changes.** SASL_SSL is wired at all 17 client call sites;
`acks=all` and RF-derived `min.insync.replicas` are in place.

- [ ] Provision a managed 3-broker cluster.
- [ ] Map the existing env vars to it — SASL mechanism, credentials, TLS trust.
      Find the ones already in use (`internal/kafkaauth`, `app/kafka_security.py`);
      do not add new ones.
- [ ] `REPLICATION_FACTOR=3`, then re-run `infra/kafka/create-topics.sh`.
      Confirm `min.insync.replicas` lands at **2**.
- [ ] Size `NOTIFICATION_PARTITIONS` — already supported separately from the
      baseline (`create-topics.sh:25`). **Partitions increase online but never
      decrease.** Size up front.
- [ ] Write the cutover sequence and the rollback. This is a live system and
      moving topics between clusters is not a config flip.
- [ ] Update `.env.prod.example` and Helm values; note which is authoritative
      for which deployment path.
- [ ] **Do not** add brokers to `docker-compose.prod.yml`. Three brokers sharing
      one disk and one kernel add no durability against the failure they exist
      to survive.

---

## 2.2 — Batch the Python consumers · **DONE 2026-08-17**

516 unit tests green: telemetry-svc 58, task-svc 139, integrations-svc 319.

- [x] `services/telemetry-svc/app/consumer.py` — **merged transactions.** It
      writes a row for nearly every event across all five topics, so the win is
      the database work: one transaction and one batch dedup claim per fetch
      instead of per event.
- [x] `services/task-svc/app/consumer.py` — **batched acknowledgement only.**
      It consumes the high-volume `messaging.events.v1` but acts on one event
      type, and was paying a synchronous offset commit per *ignored* message.
      Handlers keep their own transactions.
- [x] `services/integrations-svc/app/org_consumer.py` — same shape as task-svc.
      Least to gain (`auth.events`, one rare type); batched for consistency.
- [x] `services/email-worker/**` — **nothing to do: it already batched.** Both
      `relay_consumer.py:190` and `worker.py:141` use
      `getmany(timeout_ms=1000, max_records=100)`. This checklist listed it in
      error.

### The distinction that mattered

The two shapes are **not** the same change, and applying one template to all
three would have regressed correctness:

- Merging transactions (telemetry-svc) makes one failure cost the whole batch
  rather than one event. Not committing is **not** enough to undo that — the
  fetch position has already advanced, so the next successful batch commits
  *past* the failed one and the events are lost, not retried. It seeks back to
  the batch's first offset instead.
- Leaving handlers independent (task-svc, integrations-svc) keeps a failure at
  one event, so no seek-back is needed and error semantics are untouched.

### Guarantees, verified by test

- [x] Offset commit strictly after the DB commit.
- [x] Redelivery idempotent via existing `event_id` dedup — a fully redelivered
      batch writes nothing.
- [x] A poison message skips **out of** the batch rather than failing it.
- [x] Ordering preserved: a control event (`org.deleted`) flushes the pending
      rows before it runs, so rows cannot be written after the purge that was
      meant to remove them.
- [x] `_claim_many` uses `ON CONFLICT DO NOTHING` rather than catching
      `IntegrityError`. The old helper called `db.rollback()` on a duplicate,
      which inside a shared transaction would have discarded the whole batch
      including the caller's RLS GUC — the reason it could not simply be looped.

### Fixed in passing

- [x] A non-UUID `eventId` raised a DataError against the `uuid` column that was
      never committed — a poison message that blocked its own partition
      indefinitely. Skipped now.

### Verified against real Postgres 17.10

Run on a scratch container on port 55432, isolated from the live prod stack on
5432 and removed afterwards. **Never point these at prod** — the suites create
roles and apply migrations.

- [x] telemetry-svc integration suite — **16 passed**, migrations applied clean
- [x] integrations-svc integration suite — **37 passed**
- [x] `_claim_many` exercised directly through the real asyncpg path, 7 checks:
      list-of-strings binding to `CAST(:eids AS uuid[])`, `ON CONFLICT DO
      NOTHING` returning only genuinely-inserted rows, full redelivery claiming
      nothing, partial overlap claiming only the new id, `DISTINCT` collapsing
      an in-batch duplicate, a 200-id batch, and durability of the write.

Reproduce:

```
sudo docker run -d --name tb-verify-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=telemetry_user -e POSTGRES_PASSWORD=verifypw \
  -e POSTGRES_DB=telemetrydb postgres:17-alpine

cd services/telemetry-svc && . .venv/bin/activate
TELEMETRY_DATABASE_URL="postgresql://telemetry_user:verifypw@127.0.0.1:55432/telemetrydb" \
  KAFKA_BROKERS="127.0.0.1:59092" pytest -m integration

cd ../integrations-svc && . .venv/bin/activate
TEST_DATABASE_URL="postgresql://telemetry_user:verifypw@127.0.0.1:55432/integrationsdb" \
  pytest -m integration
```

### messaging-svc SQL — also verified, same session

Three statements elsewhere in the tree had the same "never met a database"
caveat. All pass against real Postgres 17.10, checked with the **same Go
argument types** as the real call sites (the risk was the binding, not the SQL):

- [x] `insertOutboxBatch` (`internal/store/outbox.go:67`) — `[][]byte` **does**
      bind to `$4::jsonb[]`; pgx encodes a jsonb array, not `bytea[]`, so there
      is no cast error. 500 events → 500 distinct rows in one statement, payload
      queryable as real jsonb (`payload->>'type'` resolves), empty arrays insert
      zero rows rather than erroring.
- [x] ctid-keyed prune (`cmd/prune-event-tables/main.go:204`) — deletes exactly
      `LIMIT`, drains exactly the prunable rows, leaves recent rows untouched.
      The batch bound holds.
- [x] messaging-svc builds clean: `go build ./...`, `go vet ./...`,
      `go test ./...` → 10 packages ok, 0 failures.

**Go is at `/usr/local/go/bin/go`, not on PATH** — worth knowing before
concluding the toolchain is missing.

### Coverage gaps found while verifying

- [ ] **task-svc has no integration suite at all** — no `tests/integration/`
      directory, 0 integration-marked tests (139 unit, all deselected under
      `-m integration`). Its consumer batching is covered only by fakes.

### Separate gap found

- [ ] **telemetry-svc is not in CI's Python test matrix.** `ci.yml:157` lists
      `[auth-svc, task-svc, email-worker, integrations-svc]`. Its 58 unit tests
      have never run in CI, including the ones added here.

---

## 3.1 — Routed delivery + pod metric

**Ordering constraint:** Stage 3 before Stage 4, always. Clustering Redis under
a broadcast workload divides none of the work.

### Rollout

- [ ] `WS_FANOUT_MODE=routed` plus `WS_ADVERTISE_ADDR`.
- [ ] `WS_ADVERTISE_ADDR` matters in **both** modes and node registration is
      unconditional. A multi-pod fleet without it cannot connect a call between
      users on different pods.
- [ ] Flip gateways one at a time. Both paths may run at once — delivery is
      idempotent, clients dedupe on `eventId` — so there is no flag day.
- [ ] Write the rollback and what makes it safe.

### Watch during the flip

Metrics already exist; no instrumentation work needed.

- [ ] `ws_fanout_discarded_total` / `ws_fanout_recipients_total`
- [ ] `ws:route_cache:hit_ratio`
- [ ] Connection rejections split by which cap was hit
- [ ] `infra/observability/prometheus/rules/gateway.yml`

### Same change — the HPA

- [ ] Enable the `podMetric` block in
      `deploy/helm/taskboard/values.yaml` (documented at line 169).
- [ ] `max: 60` is already set but **unreachable on CPU scaling** — a socket is
      connection-bound, costing memory and two goroutines and almost no CPU
      while idle. The fleet sits at `min: 3` while pods fill and refuse
      connections. Raising the ceiling and giving the autoscaler a socket metric
      are one change.

---

## 4.1 — Load-test suite

- [ ] k6 suite, committed under `Bliss-Work/` with a runner script.
- [ ] Scenarios weighted to real usage: inbox read (dominant), channel list +
      message page, message send, WebSocket connect/hold/receive, login.
- [ ] Committed baseline results file, so the next run is a comparison.
- [ ] Staging only. Never production.

### The three questions this exists to answer

- [ ] **Does routed fan-out actually reduce per-pod load as the fleet grows?**
      Compare `broadcast` vs `routed` at 2+ gateway pods. This is the central
      claim of the entire staged rewrite and has never been measured.
- [ ] **Where does Redis memory land per weekly-active user?** The ~700 B/member
      outbox figure is the assumption most likely to be wrong and the whole
      capacity table rests on it. Measure with `INFO memory` and `ZCARD` on live
      outbox keys.
- [ ] **What is the real read/write ratio** on the paths item 1.1 caches? That
      sets the cache's actual value.

### Do not

- [ ] **Do not specify millions of virtual users.** The previous version of this
      checklist called for 50M VUs, which no load generator can produce and
      which made the suite unbuildable. Generate load proportional to the target
      and extrapolate honestly, stating the extrapolation.

---

## Verified as already done — do not re-implement

Checked against the source during this refresh. The previous version of this
file had checklists for all of it.

| Item | Evidence |
|---|---|
| OpenTelemetry | 36 files; `services/*/app/tracing.py`, `messaging-svc/internal/tracing/`, collector + Tempo in prod compose |
| Prometheus + alerting | 26 files; Prometheus, Alertmanager, Grafana, 4 exporters, 3 rule files |
| Structured logging | Loki in prod compose; structlog with `request_id` |
| PgBouncer | `deploy/helm/taskboard/templates/pgbouncer.yaml`, `enabled: true`. Kubernetes-only **deliberately** (INFRASTRUCTURE.md:188) |
| Partitioning | `inbox_items` HASH×64 on `owner_user_id`; telemetry RANGE on `occurred_at` |
| Outbox + idempotency | All 8 services, with DLQ; `event_id` UUIDv7; `FOR UPDATE SKIP LOCKED` in real transactions |
| CDN cache headers | `infra/caddy/Caddyfile:229` — immutable hashed assets, `no-cache` HTML |
| Helm chart | hpa, pdb, networkpolicy, ingress, cronjob, pgbouncer, livekit, coturn |
| Read replicas | `MESSAGING_DATABASE_REPLICA_URL`, opt-in per call site |
| ws-gateway routed delivery | Built — enabling it is item 3.1 |
| Presence efficiency | Heartbeat ZSETs, 45s/120s window, amortized `EXPIRE`, in-process route cache |
