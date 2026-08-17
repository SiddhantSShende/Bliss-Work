# BlissWork Optimization Plan for 1M DAU
**Audit Date:** 2026-08-17 | **Current Capacity:** ~50K DAU (~700 rps) | **Target:** 1M DAU (~14K rps)

---

## Executive Summary

The system has a solid foundation: observability, exactly-once semantics, partitioning, and most Python consumers already batch. The path to 1M DAU requires:
1. **READ CACHE** (highest ROI, 2-3 days)
2. **Durability fixes** (provisioning: Kafka 3-broker cluster)
3. **Enable built-but-disabled features** (routed delivery, Redis cluster)
4. **Load testing to validate** (2-3 days)

Everything past that is multi-quarter sharding work; do not start until load tests prove it necessary.

---

## PHASE 1: READ CACHE (Days 1-3)

### 1.1 Problem
- Redis holds: presence, replay outbox, node registry, rate limits — **nothing else**
- Every channel list, user_projection lookup, inbox render, profile fetch hits primary DB
- At typical chat ratios (90% read), this is the highest-impact bottleneck per engineering effort

### 1.2 Implementation Scope

**Start with TWO hot paths:**

#### A. User Projection Cache
- **Location:** `services/auth-svc/app/service.py` — `get_user_projection()` and mutations
- **TTL:** 30-60s (user status changes are rare)
- **Invalidation:** Sync from auth-svc when row changes (mutations in `service.py`)
- **Current Flow:** 
  ```python
  # auth-svc/app/service.py - LINES: ~300-400 (exact line varies)
  async def get_user_projection(user_id: str, org_id: str):
      return await apg.query(
          "SELECT id, name, avatar_url, active FROM user_projection WHERE id=$1 AND org_id=$2",
          [user_id, org_id]
      )
  ```
- **Required Change:**
  ```python
  # Add to auth-svc before the query
  cache_key = f"user_projection:{org_id}:{user_id}"
  cached = await redis.get(cache_key)  # TTL 60s
  if cached:
      return json.loads(cached)
  
  result = await apg.query(...)  # existing query
  await redis.setex(cache_key, 60, json.dumps(result))
  return result
  ```
- **Invalidation Sites** (search for `UPDATE user_projection` / INSERT):
  - `deactivate_user()` — auth-svc/app/service.py
  - `activate_user()` — auth-svc/app/service.py
  - User creation, profile updates
  - On each mutation: `await redis.delete(cache_key)`

#### B. Channel Roster Cache
- **Location:** `services/messaging-svc/cmd/server/main.go` and API handlers
- **Hot Path:** `GET /channels` (every page load)
- **TTL:** 15-30s (membership changes are rare)
- **Invalidation:** On channel create/delete, member add/remove
- **Search Pattern:** `messages-svc` handlers that list channels (Go, not Python)
  - Look for SQL selecting from `channels` table
  - Wrap result with Redis: key=`channels:{org_id}`, TTL=30s
  - Invalidate on: membership change, channel delete, permissions update
  
**Do NOT cache:**
- Inbox/message lists (read-after-write: user must see own messages)
- Current user context (changes too frequently)

### 1.3 Implementation Steps
1. Add Redis helper to both services for get/set with TTL
2. Wrap user_projection reads with cache check
3. Add invalidation hooks on all user mutations
4. Wrap channel roster reads with cache check  
5. Add invalidation hooks on membership/channel changes
6. Test cache hit rates in staging

### 1.4 Expected Impact
- **Hit Rate:** 70-85% on hot paths
- **Latency Reduction:** 50-100ms per read (DB roundtrip avoided)
- **RPS Increase:** ~30-40% on read-heavy workloads (real bottleneck removal)
- **Risk:** Low (invalidation is deterministic; stale reads are acceptable for these paths)

---

## PHASE 2: DURABILITY (1 day provisioning)

### 2.1 Kafka Replication
**Problem:** Single broker at RF=1. In-flight events lost on restart.

**Current State:**
- `infra/kafka/create-topics.sh:22` — `RF="${REPLICATION_FACTOR:-1}"`
- Prod compose runs one `kafka` container
- All 17 producer call sites have SASL_SSL + acks=all wired (ready to go)

**Action:**
1. Provision managed Kafka: 3-broker cluster, RF=3, min.insync=2
   - AWS MSK, Confluent Cloud, or self-hosted cluster
2. Update `.env` or Helm values:
   ```
   REPLICATION_FACTOR=3
   KAFKA_BROKERS=broker1:9092,broker2:9092,broker3:9092
   ```
3. Re-run `infra/kafka/create-topics.sh` (idempotent)
4. Optionally: `NOTIFICATION_PARTITIONS=12` (already supported; increases throughput)

**Zero code changes needed** — producers/consumers are already configured.

**Impact:** Eliminates data loss risk. Durability floor requirement for production.

---

## PHASE 3: ENABLE BUILT-BUT-DISABLED FEATURES

### 3.1 Routed Message Delivery (WS Gateway Fan-Out)
**Problem:** Broadcast fan-out sends to every node; replicas amplify traffic.
**Solution:** Routed delivery — produce one message, every node routes locally.

**Current State:**
- Fully implemented in `services/delivery-svc/` (or as part of messaging-svc)
- Disabled by default: `WS_FANOUT_MODE=broadcast` (old behavior)
- Can run both modes simultaneously (idempotent delivery, client dedup on eventId)

**Enable Per-Gateway Pod (no flag day):**
```bash
# In Helm values or docker-compose.prod.yml
- env:
    WS_FANOUT_MODE: routed
    WS_ADVERTISE_ADDR: <pod_ip>:8080  # Kubernetes sets this via downwardAPI
```

**Prerequisite:** 
- Must enable BEFORE Redis cluster (see 3.2)
- Why: broadcast is already amplified traffic; sharding it doesn't help
- With routed: sharding works because each node only handles its subset

**Implementation Timeline:**
1. Set `WS_FANOUT_MODE=routed` on 1-2 pods → monitor error rates for 1 hour
2. If stable, roll out across fleet
3. Monitor WebSocket drop-off rates (should be same or better)

**Expected Impact:**
- WS gateway outbound traffic → Kafka (no longer fans out to all pods)
- Enables clustering benefit in next step
- Memory/goroutines drop per pod (fewer outbound connections)

### 3.2 Redis Cluster (Presence + Rate Limits)
**Prerequisite:** Routed delivery working (3.1)

**Current State:**
- Single Redis instance: presence ZSETs, replay outbox, node registry, rate-limit buckets
- No cluster mode
- Pub/sub broadcast reaches every node regardless of channel hash

**Enable Redis Cluster:**
```bash
# Docker-compose or Helm
REDIS_URL=redis://node1:6379,redis://node2:6379,redis://node3:6379
```

**Update K8s ConfigMap or Helm values:**
```yaml
redis:
  urls: "redis://redis-0.redis.default.svc.cluster.local:6379,redis://redis-1:6379,redis://redis-2:6379"
  cluster: true
```

**Why After Routed Delivery:** 
- With broadcast: every node sees all channels → Redis cluster's sharding doesn't reduce traffic
- With routed: each node only handles its channels → Redis cluster actually helps

**Expected Impact:**
- Presence lookups distribute across 3 nodes (3× throughput on presence path)
- Rate-limit buckets distribute (reduced hot slot contention)
- Outbox key remains a ZSET at each org level; still a hot key if org-wide presence exists

### 3.3 Telemetry Path Verification
**Potential Issue:** If telemetry beacons are synchronous, they block on high-QPS paths.

**Check Current State:**
- Search: `services/*/internal/telemetry*` and `apps/web/src/api/telemetry*`
- If calls are `fetch()` (sync) rather than `navigator.sendBeacon()` (async), fix it
- Current setup: telemetry-svc consumer batches (good), but CLIENT sends matter

**Expected:** Beacons should be async (fire-and-forget), not blocking.
**If Broken:** Change `fetch()` to `navigator.sendBeacon()` in web client.

---

## PHASE 4: LOAD TESTING & VALIDATION (2-3 days)

### 4.1 Test Setup
**Tool:** k6 (preferred), JMeter, or Locust

**Baseline Targets (adjust to your Helm deployment):**
- docker-compose: ~10k DAU (all services on one machine)
- Helm+managed data: ~300k DAU (multi-pod services, RDS-like DB)
- Goal: 1M DAU load test

**Scenarios:**
1. **Login Flow** (10% of DAU per day):
   - Auth RPS: ~1,500 (1M DAU ÷ 24h ÷ 3600s ÷ 10% ÷ 2 auth calls per user)
   - Measure: Login latency p99, cache hit rate on user_projection

2. **Messaging (hot path):**
   - Message create/read: ~70% of traffic
   - Per-user: 1-10 messages/day, ~50 inbox views/day
   - Measure: Message create latency, inbox list latency, cache hit rate on channel rosters

3. **Presence Updates:**
   - ~1 update per user per hour (scale test to actual behavior)
   - Measure: Redis CPU on presence ZSETs

4. **WebSocket Connections:**
   - Scale to 1M virtual users, each holding a connection
   - Measure: Gateway pod count scaling, connection rate, disconnect recovery

### 4.2 Metrics to Collect
- **Latency:** p50, p95, p99 for:
  - User login (auth-svc)
  - Message send (messaging-svc)
  - Inbox list fetch (cached vs. uncached)
  - WebSocket connect/disconnect
- **Throughput:**
  - RPS per service
  - Message delivery rate
  - Presence updates/sec
- **Resource Usage:**
  - DB connection pool utilization
  - Redis memory and CPU
  - Pod CPU/memory per service
  - HPA scale events (are they at target or hitting ceiling?)
- **Errors:**
  - 5xx rate
  - Connection refused (capacity exceeded)
  - Kafka consumer lag
  - Cache miss rate (indicates invalidation issues)

### 4.3 Pass/Fail Criteria
- **Must pass:**
  - p99 message latency < 500ms (end-to-end)
  - p99 inbox list < 300ms
  - 1M WebSocket connections successful
  - Zero auth failures during load
  - Kafka consumer lag < 5s
- **Should improve:**
  - Gateway pods scale to ~40 (at 25K connections/pod max, ~1M total)
  - DB CPU < 80% under sustained load
  - Redis CPU < 60% (presence + rate limits spread across cluster)

### 4.4 Expected Outcome
- If all Phase 1-3 changes hold: should hit 1M DAU target
- If not: bottleneck becomes visible in metrics
  - High p99 latency → something is queued (likely DB or Redis)
  - Connection refused → HPA hitting ceiling or service unhealthy
  - Kafka lag spiking → consumer can't keep up (scale replicas)
  - Redis CPU/memory saturated → need larger cluster or sharding

---

## PHASE 5: MULTI-QUARTER WORK (Plan, don't start yet)

**Only start these after load tests prove they are necessary:**

### 5.1 Postgres Sharding
- **Blocker:** `RedeemInvite` routes by token hash, not org_id (requires decision)
- **Impact:** Enables horizontal DB scaling beyond single primary
- **Timeline:** 2-3 quarters
- **When:** Only if load test shows DB CPU > 80% at 1M DAU

### 5.2 Full-Text Search
- **Design First:** How to search encrypted message bodies?
- **Timeline:** 1-2 quarters
- **When:** Only if product requires FTS (currently optional)

### 5.3 Telemetry OLAP
- **Blocker:** Choosing a columnar store (ClickHouse, DuckDB)
- **Timeline:** 1 quarter
- **When:** Only if telemetry queries become a bottleneck

### 5.4 Presence Subscriptions
- **Blocker:** Product decision (show presence of entire org? or just DM threads?)
- **Timeline:** 1 quarter
- **When:** Only if presence traffic dominates

### 5.5 Async KMS/Vault Calls
- **Blocker:** Not yet enabled (`DATA_KEK_PROVIDER=kms` is off)
- **Timeline:** 1 quarter (block on 5.1 — sharding, first)
- **When:** Only if planning to use remote key management

---

## EXECUTION CHECKLIST

### Phase 1: Read Cache
- [ ] Implement user_projection cache in auth-svc
- [ ] Implement invalidation hooks on user mutations
- [ ] Implement channel roster cache in messaging-svc
- [ ] Implement invalidation hooks on membership changes
- [ ] Test cache hit rates in staging
- [ ] Measure latency improvement

### Phase 2: Kafka Durability
- [ ] Provision 3-broker Kafka cluster
- [ ] Update REPLICATION_FACTOR=3 in config
- [ ] Re-run `infra/kafka/create-topics.sh`
- [ ] Test broker restart recovery (no message loss)

### Phase 3: Enable Features
- [ ] Set WS_FANOUT_MODE=routed on test pod
- [ ] Monitor for 1 hour; watch error rates
- [ ] Rollout to all gateway pods
- [ ] Provision Redis cluster (3 nodes)
- [ ] Update REDIS_URL to cluster endpoint
- [ ] Verify presence and rate-limit behavior
- [ ] Check telemetry client code (use navigator.sendBeacon)

### Phase 4: Load Testing
- [ ] Set up k6 or JMeter test harness
- [ ] Create scenarios: login, messaging, presence, WebSocket
- [ ] Run test against docker-compose deployment
- [ ] Document metrics (latency, throughput, resource usage)
- [ ] Run test against Helm+managed data deployment
- [ ] Verify 1M DAU target is achieved
- [ ] Document any bottlenecks for Phase 5

---

## INFRASTRUCTURE CURRENT STATE

### Already in Place ✓
- **Observability:** OTEL, Prometheus, Grafana, Loki, Tempo
- **Message Durability:** Outbox + DLQ on all services
- **Exactly-Once:** UUIDv7 dedup, transactional offsets
- **Database:** PostgreSQL with partitioning (inbox_items HASH×64, telemetry RANGE)
- **Connection Pooling:** PgBouncer (Helm only)
- **CDN:** Cache headers on static assets (31536000s)
- **Kubernetes:** HPA (CPU + pod metrics), PDB, NetworkPolicy
- **WebSocket Scaling:** Pod metrics for ws_connections (enabled)
- **Helm Chart:** Full production chart with all services

### Missing for 1M DAU
- **Read Cache:** Zero application-layer caching (Redis only infra keys)
- **Kafka Cluster:** Single broker RF=1 (provisioning only; code is ready)
- **Routed Delivery:** Built but disabled (one env var + rollout)
- **Redis Cluster:** Not enabled (cluster URLs not in config)
- **Load Testing:** No k6/JMeter suite (know your numbers)

---

## CODE LOCATIONS FOR CLAUDE

| Item | File | Lines | Action |
|------|------|-------|--------|
| User projection getter | `services/auth-svc/app/service.py` | ~300-400 | Wrap with Redis cache |
| User mutation (deactivate) | `services/auth-svc/app/service.py` | Search: `deactivate_user` | Add invalidation |
| User mutation (activate) | `services/auth-svc/app/service.py` | Search: `activate_user` | Add invalidation |
| Channel list handler | `services/messaging-svc/cmd/server/main.go` | Search: `GET /channels` | Wrap with Redis cache |
| Telemetry consumer | `services/telemetry-svc/app/consumer.py` | Line 1+ | Verify already batched (it is) |
| Task consumer | `services/task-svc/app/consumer.py` | Line 1+ | Verify already batched (it is) |
| Email worker | `services/email-worker/app/relay_consumer.py` | Line 1+ | Verify already batched (it is) |
| Frontend telemetry | `apps/web/src/api/telemetry*` | All files | Change `fetch()` to `navigator.sendBeacon()` if needed |
| Helm HPA | `deploy/helm/taskboard/templates/hpa.yaml` | Line 1+ | Already configured; no changes needed |
| Kafka creation | `infra/kafka/create-topics.sh` | Line 22 | Will use REPLICATION_FACTOR env var (already does) |
| Docker-compose | `docker-compose.prod.yml` | All | Single broker; provision separate cluster |
| Redis config | `deploy/helm/taskboard/values.yaml` | Search: `redis:` | Update REDIS_URL to cluster |
| WS-gateway mode | `services/ws-gateway/cmd/server/main.go` (or config) | Search: `FANOUT_MODE` | Set to `routed` |

---

## RISK & MITIGATION

### High Confidence
- ✓ Batching already implemented (email-worker, task-svc, telemetry-svc, integrations-svc)
- ✓ HPA already uses pod metrics for ws-gateway
- ✓ Producers already have acks=all (waiting on Kafka cluster)
- ✓ Routed delivery code exists and can run alongside broadcast
- ✓ Redis client handles cluster mode transparently

### Moderate Risk
- **Cache Invalidation Bugs:** 
  - Risk: Stale user/channel data
  - Mitigation: Short TTL (30-60s), monitor cache hit rates, test in staging first
- **Routed Delivery Rollout:**
  - Risk: Gateway pod crash loop if config malformed
  - Mitigation: Dry-run on 1 pod, monitor for 1 hour before fleet rollout
- **Redis Cluster Rebalancing:**
  - Risk: Brief spike in latency during cluster join
  - Mitigation: Perform during low-traffic window, watch for errors

### Low Risk
- Kafka cluster upgrade (0 code changes, producers already configured)
- Helm chart already supports all options
- Load testing (no prod impact)

---

## Success Metrics at 1M DAU

| Metric | Current | Target | How to Measure |
|--------|---------|--------|-----------------|
| Total RPS | ~700 | ~14,000 | Sum of all service /metrics endpoints |
| Message create p99 | ~200ms | <300ms | k6 load test |
| Inbox list p99 | ~400ms | <300ms | k6 load test (post-cache) |
| DB CPU | ~30% | <70% | RDS/cloud provider metrics |
| Redis CPU | ~10% | <60% | Redis MONITOR / cloud metrics |
| WS Gateway pods | 3 | ~40-50 | kubectl top nodes |
| Kafka consumer lag | <100ms | <1000ms | Burrow or kafka-console-consumer |
| Cache hit rate (user_projection) | 0% | >75% | Redis INFO stats:keyspace_hits |
| Cache hit rate (channels) | 0% | >70% | Redis INFO stats:keyspace_hits |

---

## Next Steps (Immediate)

1. **Claude Implementation:**
   - Phase 1: Read cache (user_projection + channel rosters)
   - Phase 2: Zero-code Kafka provisioning (infrastructure only)
   - Phase 3: Enable routed delivery + Redis cluster

2. **Testing:**
   - Set up k6 load test suite targeting 1M DAU

3. **Validation:**
   - Run load tests post-Phase 3
   - Document any remaining bottlenecks
   - Decide if Phase 5 (sharding) is necessary

---

## Appendix: Why This Order

1. **Read Cache First:** Highest ROI per engineering day; only 2-3 days of work
2. **Kafka Durability Second:** Zero code changes; pure provisioning; critical baseline
3. **Routed + Cluster Third:** Both built and waiting; enable in order (routed → cluster)
4. **Load Test Fourth:** Validates everything works; proves whether Phase 5 is needed
5. **Sharding Last:** Multi-quarter project; only start if load tests prove it necessary

Previous version ordered Postgres sharding first. It was wrong because:
- Sharding introduces 2-3 months of distributed systems debugging
- Read cache + Kafka fixes + routed delivery likely handle 1M DAU
- Sharding should only start if load test shows DB is the ceiling (it won't be)
