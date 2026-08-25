# Cross-region event replication

Events cross region boundaries over **NATS JetStream**. Kafka remains the
in-region bus and no service knows the bridge exists: it is one more consumer of
the local log and one more producer into it.

Implementation: `services/region-bridge/`. Server config: `infra/nats/`.

---

## 1. Why not MirrorMaker2

This document replaces the "Multi-cluster + MirrorMaker2" line in
`INFRASTRUCTURE.md`. The reasons are operational, not ideological:

| | MirrorMaker2 | JetStream bridge |
|---|---|---|
| Topology config | Connect cluster + per-pair connectors, one deployment per direction | One process per region, one env var listing peers |
| Loop prevention | Topic renaming (`us-east-1.messaging.events.v1`), so consumers must know which prefixes to subscribe to | Origin stamped per message; local topic names stay identical in every region |
| Offset translation | A separate concern with its own failure modes | None — each region's consumers read their own local log |
| What runs | A Kafka Connect cluster to operate, scale and upgrade | One Go binary with `/readyz` |

The decisive one is the second row. Under MirrorMaker2 a replicated topic
arrives under a different name, so every consumer in every region has to
subscribe to `*.messaging.events.v1` and every producer has to know it must not.
Here a replicated event lands on **the same topic it was produced on**, which is
what lets the platform's services stay unchanged.

---

## 2. The topology

```
        region A                                        region B
  ┌───────────────────┐                          ┌───────────────────┐
  │   Kafka (local)   │                          │   Kafka (local)   │
  └───┬───────────▲───┘                          └───┬───────────▲───┘
      │ consume   │ produce                          │ consume   │ produce
      │           │                                  │           │
  ┌───▼───────────┴───┐                          ┌───▼───────────┴───┐
  │   region-bridge   │                          │   region-bridge   │
  └───┬───────────▲───┘                          └───┬───────────▲───┘
      │ publish   │ pull                             │ publish   │ pull
      │           │                                  │           │
  ┌───▼────┐  ┌───┴─────┐                        ┌───▼────┐  ┌───┴─────┐
  │EVENTS_ │  │EVENTS_  │                        │EVENTS_ │  │EVENTS_  │
  │OUT_A   │  │IN_A     │◄───────sources─────────│OUT_B   │  │IN_B     │
  │        │──┼─────────┼────────sources────────►│        │  │         │
  │evt.a.> │  │(no subj)│                        │evt.b.> │  │(no subj)│
  └────────┘  └─────────┘                        └────────┘  └─────────┘
```

Subjects are `evt.<region>.<kafka-topic>`, e.g.
`evt.us-east-1.messaging.events.v1`. The region is its own subject token so a
peer's source filter can select it exactly.

**Streams per region:**

- `EVENTS_OUT_<REGION>` — subjects `evt.<region>.>`. Only the local exporter
  publishes here. This is what peers source.
- `EVENTS_IN_<REGION>` — **no subjects of its own**, one `source` per peer
  pointing at that peer's *outbound* stream.

---

## 3. Why it cannot loop

The invariant, and everything follows from it:

> **An event is exported by exactly one region: the one that produced it.**

Three independent mechanisms enforce it. Any one of them alone would do; all
three are present because a replication cycle does not announce itself as an
error — every individual publish succeeds, and the only symptom is traffic that
climbs until the WAN link saturates.

**1. Structural (stream config).** An outbound stream captures only its own
region's subject space, and nothing in the system publishes another region's
subject. A foreign event therefore cannot enter the log that peers source. The
inbound stream has *no subjects at all*, so it holds only what it sourced —
giving it `evt.>` "for convenience" would make it capture the local region's own
publishes, and the importer would write them straight back into local Kafka.
Asserted at startup by `streams.AssertCannotLoop`, which refuses to run if the
provisioned stream does not match.

**2. Per message (provenance).** The exporter stamps `X-Origin-Region` on the
way out. The importer writes it onto the local Kafka record. The local exporter
reads it back and declines:

| Kafka record carries | Export decision |
|---|---|
| no origin | **forward** — locally produced |
| a peer's origin | **skip** — already bridged; this is the cycle break |
| *our own* origin | **reject** — it came home; the topology is wrong |

**3. Hop counter.** `X-Bridge-Hops`, capped at 1 — every region sources every
peer directly, so one hop reaches everyone. An unreadable counter is read as
over-limit, because the counter only exists for the case where something is
already wrong.

**Alert on `region_bridge_rejected_total{reason="returned"}`.** It should be
identically zero. Any non-zero value means a cycle is forming, and the usual
cause is a stream sourcing a peer's *inbound* stream instead of its outbound
one.

---

## 4. Delivery guarantees

**At-least-once in both directions, effectively-once in practice.**

Nothing is acknowledged before it has landed on the far side. The exporter
commits Kafka offsets only after JetStream acknowledges; the importer acks
JetStream only after the local Kafka write returns. A crash in either direction
replays rather than loses.

Duplicates are absorbed twice over:

- **Outbound**: the message id is the event's own `event_id` (UUIDv7), and the
  outbound stream carries a dedupe window (`BRIDGE_DEDUPE_WINDOW`, default 2h).
  A replayed batch republishes the same ids and the server drops them.
- **Inbound**: every consumer in the platform already dedupes on event id — see
  the `consumed_events` table — which is what makes at-least-once the right
  trade here rather than a compromise.

**Ordering.** Per-partition order is preserved on the happy path: batches are
published in the order they were read and nothing after a batch is read until it
resolves. A retry after a *partial* failure can reorder a message relative to
ones that already landed. This is tolerable here and nowhere else by accident:
every event carries `seq`, consumers sort by it, and the client patches its
caches idempotently.

---

## 5. Rollback

The bridge is additive — no service changes to undo — so rollback is stopping
it, at three granularities:

| Scope | How | Effect |
|---|---|---|
| One direction | `BRIDGE_EXPORT_ENABLED=false` or `BRIDGE_IMPORT_ENABLED=false`, restart | That half stops; the other keeps running |
| One region | `docker compose --profile crossregion stop region-bridge`, or scale the deployment to 0 | That region stops replicating in both directions |
| Everything | Stop every bridge | Every region behaves exactly as it did before the bridge existed |

**Nothing is lost by stopping.** Both halves keep their position — Kafka group
offsets for the export side, the durable JetStream consumer for the import side
— so restarting catches up from where it left off rather than from nothing.

The bound on how long you can stay rolled back is the retention on the outbound
streams (`BRIDGE_STREAM_MAX_AGE`, default 24h, and `BRIDGE_STREAM_MAX_GB`). Past
that, a peer's backlog ages out and those events are gone; re-seeding means
replaying from the origin region's Kafka, which has its own retention. **If a
rollback will last longer than the shorter of the two, raise the stream limits
before the window closes, not after.**

To go back to MirrorMaker2 instead, stop the bridges first: running both would
deliver every event twice, and MirrorMaker2's renamed topics would not be
deduped by anything.

---

## 6. Health and alerting

| Endpoint | Question |
|---|---|
| `/healthz` | Is the process alive? Never fails on a dependency — restarting does not fix NATS. |
| `/readyz` | Should this replica take traffic? Fails on a dead dependency **or a stall**: work pending and no progress for `BRIDGE_STALL_AFTER` (default 2m). |
| `/status` | Human-readable snapshot for a runbook. |
| `/metrics` | Prometheus. |

An **idle** region is healthy — no progress with an empty backlog is not a
stall, and failing readiness for it would pull a working replica out of rotation
for having nothing to do. A **backlogged but moving** bridge is also healthy;
that is a bridge catching up after a partition, which is exactly when you least
want it removed.

Alerts worth having:

| Metric | Condition | Means |
|---|---|---|
| `region_bridge_rejected_total{reason="returned"}` | `> 0`, ever | A cycle is forming. Page. |
| `region_bridge_pending_messages` | High and rising | Replication lag; the far side or local Kafka is slow. |
| `region_bridge_dlq_total` | `> 0` | Events set aside; someone must look. |
| `region_bridge_failures_total` | Sustained rate | A dependency is flapping. |
| `region_bridge_enabled` | `0` unexpectedly | Someone rolled back, or a pod is misconfigured. |
| `region_bridge_skipped_total` | **Flat at zero** in a multi-region mesh | Import is not running — nothing is arriving to skip. |

That last one is the counter-intuitive one: `skipped` climbing steadily is
*correct*. It is one per event every peer sent, and it is the cycle break doing
its job.

---

## 7. Running it

**Development (single region, single NATS node):**

```bash
docker compose --profile crossregion up -d
curl localhost:8009/status
```

`BRIDGE_PEER_REGIONS` is empty, so the bridge runs the export half only and says
so. That is enough to watch events land on `EVENTS_OUT_<REGION>`.

**Production**, per region:

- A NATS **cluster** — three nodes minimum, or JetStream cannot hold `R=3` and
  one disk failure loses the region's replication log
  (`docker-compose.crossregion.yml`).
- A **gateway** to each peer region (`infra/nats/region-a.conf`).
- `BRIDGE_STREAM_REPLICAS=3`.
- TLS + a shared password on both the cluster routes and the gateway
  (`scripts/gen-nats-certs.sh`, `scripts/render-nats-conf.sh` — see §7a).
- The gateway port (7222) published and IP-allowlisted only once a real peer
  exists (`infra/host/nats-gateway-allowlist.sh`) — never published
  unconditionally.

> `infra/nats/region-a.conf` **will not start on a single node**. JetStream plus
> gateways means clustered JetStream, and nats-server refuses that without
> routes. Verified directly, not just documented: a "cluster" of one node
> routed to itself starts and accepts connections, but its JetStream layer sits
> in "Waiting for routing to be established" forever — it looks alive and is
> not. Use `infra/nats/nats.conf` for a single-node dev server.

`BRIDGE_PEER_API_PREFIXES` / separate JetStream **domains** are NOT part of
this topology, and setting `domain` in `infra/nats/region-a.conf` /
`region-b.conf` is a mistake, not a stricter option — those files deliberately
do not set it. Domains are how JetStream is isolated over LEAF NODE
connections; this topology uses GATEWAYS, and a gateway between two
JetStream-enabled clusters forms ONE JetStream supercluster regardless of
`domain` — verified directly: two gatewayed 3-node regions with distinct
domains reported one merged 6-node meta-cluster and refused to place a new
stream ("no suitable peers for placement"). Per-region isolation instead comes
from `Placement.Cluster` on every stream (`internal/streams/provision.go`),
which is what actually keeps a region's replicas from crossing the gateway.
`BRIDGE_PEER_API_PREFIXES` stays in the bridge's config surface for a possible
future leaf-node topology; leave it empty for this one.

### 7a. TLS, auth, and the render step

Two things cannot be nats-server `$VAR` references, and skipping either one
fails in a way that looks like something else entirely — both cost real
debugging time to pin down, so they are recorded here rather than left to be
rediscovered:

- **The cluster route password.** nats-server's own `$VAR` substitution only
  replaces a token that IS the variable — `user:$VAR@host` (a variable
  concatenated with literal text) is silently left un-substituted. Worse,
  `cluster.authorization` is not even consulted for EXPLICITLY listed routes in
  the first place (only implicitly-discovered ones use it), so a route list
  with plain URLs produces a connect/reject loop — thousands of
  `"authentication error"` log lines per second, not a handful at startup —
  because every node dials every peer with no credentials and every peer
  correctly refuses them.
- **The gateway URL to a real peer.** Genuinely unknown until that peer exists,
  so it has to come from the environment, not be edited into a tracked file.

Both are filled in by `scripts/render-nats-conf.sh`, which writes a gitignored
`infra/nats/<region>.rendered.conf` — the file `docker-compose.crossregion.yml`
actually mounts. Provision certs first:

```bash
scripts/gen-nats-certs.sh region-a
set -a; . ./.env; . ./.env.prod; set +a
bash scripts/render-nats-conf.sh region-a
```

`region-bridge`'s own connection to its local cluster is a separate TLS leg —
`NATS_TLS_CA` / `NATS_TLS_CERT` / `NATS_TLS_KEY`, already wired in
`docker-compose.crossregion.yml` from the same cert set (`bridge.crt` /
`bridge.key`, client-only usage, signed by the region's own CA).

When a real second region exists, exchange **CA public certs** out-of-band
(never `ca.key`) and place the peer's `ca.crt` at
`infra/nats/certs/<region>/gateway-peer-ca.crt` before rendering — an absent or
wrong peer CA fails the gateway TLS handshake closed, which is the safe
failure, not a hang.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_REGION` | — | Required. Lowercase letters, digits, dashes: it is a NATS subject token. |
| `BRIDGE_PEER_REGIONS` | — | Comma-separated. Listing itself is refused: that builds a cycle. |
| `BRIDGE_TOPICS` | the five platform topics | Explicit, never discovered — a bridge that discovered topics would replicate a new one across the WAN the moment somebody created it. |
| `BRIDGE_DLQ_TOPIC` | `region-bridge-dlq` | Empty disables dead-lettering, which makes a poison event stall its topic. |
| `BRIDGE_EXPORT_ENABLED` / `BRIDGE_IMPORT_ENABLED` | `true` | The rollback switches. |
| `BRIDGE_BATCH_SIZE` | 256 | Also the blast radius of a retry: a failed batch replays whole. |
| `BRIDGE_MAX_ACK_PENDING` | 2048 | Import flow control. Must be ≥ batch size. |
| `BRIDGE_PUBLISH_WINDOW` | 512 | Export back-pressure; bounded so a stalled server is slowness, not an OOM. |
| `BRIDGE_STREAM_MAX_GB` / `BRIDGE_STREAM_MAX_AGE` | 32 / 24h | Must be positive — zero means *unbounded* to JetStream, and an unbounded replication log takes the region's whole JetStream store down with it. |
| `BRIDGE_STREAM_REPLICAS` | 3 | 1 only for a single-node dev server. |
| `BRIDGE_DEDUPE_WINDOW` | 2h | What makes retries idempotent. |
| `BRIDGE_STALL_AFTER` | 2m | Readiness budget for "pending but not moving". |

---

## 8. Runbook

**Replication lag is climbing.** Check `region_bridge_pending_messages` and
`/status` on the importing side. Pending high with `lastSuccess` advancing is a
bridge catching up — leave it. Pending high with `lastSuccess` frozen is a stall;
`/readyz` will already be failing. Look at `lastError` in `/status`: local Kafka
unreachable and NATS disconnected are the two common causes.

**`rejected_total{reason="returned"}` is non-zero.** A cycle is forming. Compare
each region's `EVENTS_IN_*` sources against the rule in §2 — they must name
`EVENTS_OUT_<peer>` and never `EVENTS_IN_<peer>` nor their own region. The
bridge refuses to start in that topology, so a running bridge with this counter
climbing means the stream was changed underneath it.

**Events are in the DLQ.** `region-bridge-dlq` carries the original payload plus
`X-Bridge-Reject-Reason`, `X-Bridge-Source-Topic` and `X-Bridge-Region`. Read the
reason before replaying: a `returned` event must not be replayed at all — it is
evidence of a topology fault, not a delivery failure.

**A peer was down longer than the stream retention.** Its backlog has aged out.
Those events are not recoverable through the bridge; replay from the origin
region's Kafka if its own retention still holds them.

**Bridge will not start: "insufficient storage resources".** The stream asks for
more than the server allows. The error names both numbers — either lower
`BRIDGE_STREAM_MAX_GB` × `BRIDGE_STREAM_REPLICAS`, or raise the server's
`jetstream.max_file_store`.

---

## 9. The routing directory (org and invite placement)

Sites are also how ORG DATA is partitioned. Each organisation has exactly one
home site, chosen at signup, and its data is never replicated — so the one thing
that must reach every site is a small map of **which key lives where**.

That map rides the same bridge as everything else, on `routing.events.v1`.

### What is replicated

| Event | When | Key |
|---|---|---|
| `routing.upserted` | an org is placed; an invite is minted | org id / invite token hash |
| `routing.revoked` | an invite expires or is revoked | invite token hash |
| `site.capacity.reported` | every `SITE_CAPACITY_REPORT_SECONDS` | site |

None of them carries an `orgId`, unlike every other event in the platform. The
directory answers "where does this key live?" *before* any org context exists —
which is exactly what lets it serve an invite redemption that has nothing but a
token hash to go on.

The topic is **compacted**, and alone among the bridged topics in that. It is a
directory, not a change feed: the useful retention is "the latest value for
every key, forever", and time-based retention would quietly drop the placement
of an org that simply had not changed recently.

> `BRIDGE_REGION` and auth-svc's `SITE_ID` **must be the same string**. The
> bridge stamps the first as the event's origin; the directory stores the second
> as a key's home. If they disagree, replication still works and every routing
> decision points somewhere that does not exist.

### Placement (once, at signup)

Score each site by storage against **its own** ceiling, then walk the candidates
nearest-first: take the first under 80%; if every site is over, take the
globally least-filled one regardless of distance. A signup is never failed
because the nearby sites are busy — latency is a degradation, refusing the
account is an outage.

The one exception is the **hard ceiling**. If even the emptiest site is at its
configured maximum, nothing is placed: the signup gets a 503 and ops is paged.
That is a provisioning event, not a routing decision, and no amount of cascading
invents disk.

Crossing 80% raises an admin alert, dispatched **after** the placement
transaction commits and never awaited. An alert path wired synchronously into a
write path is how a mail server that stops answering turns into a signup
endpoint that times out.

Placement is decided once and there is no rebalancing. Capacity comes from each
site's own reports, replicated like everything else, so the decision is always a
local read — a cross-site query on the signup path would make signup fail
whenever a peer was unreachable.

### Request-time routing

Every org-scoped request and every invite redemption looks the key up locally
first:

| Directory says | Answer |
|---|---|
| home site is this one | serve it |
| home site is elsewhere | **307** to that site — preserves method and body, which a 302 would not |
| no such key | **503 + Retry-After**, never a 404 |
| expired or revoked | **410**, answered here |

The "no such key" row is the one that matters. The directory replicates
asynchronously, so an org created a moment ago at another site, or an invite
minted seconds before the link was clicked, is legitimately absent — and
answering 404 turns a hundred milliseconds of lag into "your invite link is
invalid", which a user cannot tell apart from a real expiry.

Redirect targets come from `SITE_ENDPOINTS` configuration, never from the
request's own Host header or from anything a peer sent: a redirect built from
either is an open redirect wearing a routing decision's clothes.

### Operating it

| Variable (auth-svc) | Meaning |
|---|---|
| `SITE_ID` | this deployment's site; must equal the bridge's `BRIDGE_REGION` |
| `SITE_ENDPOINTS` | `site-a=https://a…,site-b=https://b…` — public URLs for redirects |
| `PLACEMENT_CANDIDATES` | nearest-first order for requests with no geo hint |
| `SITE_STORAGE_CEILING_GB` | this site's hard ceiling (default 100,000) |
| `SITE_CAPACITY_REPORT_SECONDS` | how often this site publishes its position |
| `SITE_CAPACITY_MAX_AGE_SECONDS` | after this, a peer's report is UNKNOWN, not stale-but-usable |
| `OPS_ALERT_WEBHOOK_URL` | optional; every alert is logged at ERROR regardless |

**Orgs created before this shipped** have no directory row and would be
unroutable everywhere. Each site backfills its own on startup — only the site
holding the data knows it holds it — publishing as it goes, bounded per pass.

**A site that stops reporting** is treated as UNKNOWN by placement rather than
as its last value, and stops receiving new orgs. A stale "40% full" is exactly
how a stream of signups gets routed into a site that died an hour ago.

---

## 10. What has and has not been verified

**Verified against a real NATS JetStream server** (`internal/streams`, run with
`NATS_TEST_URL`): an event crosses the boundary exactly once and does not come
back; the dedupe window absorbs a replayed batch; a region's own subjects cannot
enter its inbound stream; provisioning refuses a self-sourcing topology.

**Verified end-to-end** with two bridge instances against one Kafka and one
JetStream: message counts converge and stop rather than growing, both guards
fire (`skipped` for a peer's events, `rejected/returned` for the shared-Kafka
case), and rejected events reach the DLQ with a reason.

**Routing directory, verified**: the placement cascade, the ceiling refusal, the
alert set, and every request-time answer (local / redirect / retry / expired) are
covered by unit tests against the pure policy. The migration and the replay
guarantee were exercised against a real Postgres: a redelivered event is a no-op,
a newer event wins, an older one arriving late loses, and a revoke that overtakes
its own upsert leaves the row revoked.

**Verified live, on this host** (two real 3-node TLS+auth clusters, gatewayed,
2026-08-24): the full production shape actually boots — mutual TLS on client,
cluster, and gateway connections; cluster and gateway password auth; real
Raft/JetStream leader election (`meta_cluster.cluster_size: 3` per region, a
genuine quorum, not a health-check pass); a real gateway handshake between two
independently-provisioned regions (inbound AND outbound gateway connections
registered on both sides); `region-bridge` connecting over TLS, provisioning
its streams, exporting and importing. A message produced into region A's Kafka
was exported, crossed the gateway, landed on region B's inbound stream, was
imported, and was written to region B's Kafka with the correct
`X-Origin-Region` / `X-Bridge-Hops` provenance — `region_bridge_bridged_total`
on the importing side is the direct counter of that. The test topology
deliberately shared one Kafka broker between both simulated regions (the same
simplification the earlier same-machine tests used), which creates a feedback
path a real deployment (separate Kafka per region) would not have; the
`returned`-reason rejection counter caught it and stayed flat rather than
climbing, proving the loop guard holds even under a harder case than
production presents.

This test is what surfaced two real gaps, both fixed as a result: nats-server's
`$VAR` config substitution silently does nothing for a variable concatenated
with literal text (`user:$VAR@host`), which is why cluster/gateway credentials
are now rendered rather than left to native substitution (§7a); and a gateway
between two JetStream-enabled clusters forms one merged meta-cluster
regardless of per-region `domain` settings, which is why streams now carry an
explicit `Placement.Cluster` and the conf files no longer set `domain` at all.
Neither was visible from the docs or from a single-server test — only a real
two-region gateway surfaced them.

**Not verified, and this test does not change that**: real WAN conditions —
actual internet latency, packet loss, a genuine network partition between
independently-owned hosts, DNS across real infrastructure, a peer's CA arriving
correctly out-of-band. Same-host gateway is a real protocol exercise, not a
substitute for two independent VPSes. See §11 for what to check before this
carries production traffic once a second host exists.

**One operational lesson from running this test**: six extra NATS containers
plus two `region-bridge` processes running alongside the full production stack
pushed Kafka's JVM over its cgroup memory limit and it was OOM-killed —
confirmed via `dmesg` (`Memory cgroup out of memory`, process `java`), not
guessed. It restarted cleanly on its own (`restart: unless-stopped`) within
about a minute, real application consumer groups (`task-svc`, `email-worker`,
`telemetry-svc`, others) rebalanced and resumed automatically, and no request
to the site ever failed. Nothing was lost, but it is a genuine data point: a
6-node test mesh is not free on a box already running the full stack, and a
lighter simulation (see §11) or a quiet window is worth choosing deliberately
next time, not assumed.

---

## 11. Activating a real second region

Everything above is implemented, configured, and exercised on one host. This
is what turns it into two real regions when a second VPS/VM exists.

**Before touching production traffic:**

1. **Provision the second host** with this same repo, `docker-compose.prod.yml`
   running as its own single-region deployment first — prove it healthy alone
   before adding the mesh, same as the first region was.
2. **Generate that region's certs**: `scripts/gen-nats-certs.sh region-b` on the
   second host (never copy region A's CA — each region keeps its own).
3. **Exchange CA public certs, out-of-band** (not over the gateway link that
   doesn't exist yet): copy region A's `ca.crt` to region B's
   `infra/nats/certs/region-b/gateway-peer-ca.crt`, and region B's `ca.crt` to
   region A's `infra/nats/certs/region-a/gateway-peer-ca.crt`. Only the `.crt`
   crosses; `.key` never leaves its own host.
4. **Agree on `NATS_GATEWAY_PASSWORD`** — the SAME value on both sides (it
   authenticates the gateway connection in both directions). Different values
   for `NATS_CLUSTER_PASSWORD` per region are fine and preferred (that secret
   never leaves its own region).
5. **Gate the gateway port before publishing it**:
   `sudo bash infra/host/nats-gateway-allowlist.sh <peer's real IP>` on BOTH
   hosts, scoped to the other's actual address — never a wide-open allowlist.
6. **Render and bring up the mesh on both sides**:
   ```bash
   set -a; . ./.env; . ./.env.prod; set +a
   PEER_REGION_GATEWAY_URL=<peer-host>:7222 bash scripts/render-nats-conf.sh region-a   # region-b on the other host
   docker compose --env-file .env --env-file .env.prod \
     -f docker-compose.prod.yml -f docker-compose.crossregion.yml up -d
   ```
7. **Verify connectivity BEFORE trusting it with data** — on each side's
   `nats-a-1` (or `nats-b-1`) logs, confirm BOTH an inbound and an outbound
   gateway connection registered for the peer's name. Confirm TLS: an
   unexpected plaintext connection or a cert error here means stop, not retry.
8. **Verify messaging with a throwaway topic first**, exactly as this
   session's test did — `BRIDGE_TOPICS=<something-synthetic>` on both bridges,
   produce one message, confirm it crosses, confirm `region_bridge_rejected_total{reason="returned"}`
   stays at zero (a real two-Kafka deployment should never see this counter
   move at all — if it does, that is a topology fault per §3, not noise).
9. **Only then** set `BRIDGE_PEER_REGIONS` to the real peer and `BRIDGE_TOPICS`
   to the real default on both bridges, and watch `region_bridge_pending_messages`
   and `/status` on both sides as real traffic starts flowing.
10. **Load-test at the expected production event rate** before calling it
    production-ready — everything above proves correctness, not throughput.

**What to specifically watch for that a same-host test cannot show**: real
latency's effect on `BRIDGE_STREAM_MAX_AGE` / dedupe window sizing, DNS
resolution across real infrastructure (not Docker's embedded DNS), a genuine
network partition and whether reconnect behavior (unlimited retries,
jittered backoff — see `cmd/bridge/main.go`'s `connectNATS`) recovers cleanly
once the link returns, and TLS certificate validation against a real hostname
rather than a container name.
