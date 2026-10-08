// Package metrics holds the gateway's domain telemetry.
//
// ── Why this is a package and not more of server/metrics.go ──────────────────
// The HTTP request counters live in internal/server because they belong to the
// HTTP middleware and nothing else needs them. These do not: connection counts
// are owned by the hub, fan-out counts by the Kafka consumer, and Redis counts
// by the store. server already imports all three, so putting these there would
// be an import cycle. A leaf package that everyone can import is the shape that
// works.
//
// ── What these are actually for ──────────────────────────────────────────────
// The gateway had exactly two metrics — request count and request duration —
// which say nothing about the thing that governs whether it scales. Every pod
// subscribes to Kafka under its own consumer group, so every pod receives every
// event on every fan-out topic and discards what is not addressed to one of its
// sockets. That waste is the binding constraint on the whole real-time tier and
// it was, until these, entirely unobservable in production.
//
// FanoutRecipients / FanoutDiscarded is the number that matters. It is the
// proportion of work this pod did on behalf of users it has never heard of,
// and it should fall to roughly zero once delivery is routed rather than
// broadcast. Everything else here is either a capacity signal or a check on an
// assumption made while sizing one.
package metrics

import "github.com/prometheus/client_golang/prometheus"

// ── Connections ──────────────────────────────────────────────────────────────

// NOTE: there is deliberately no gauge for the live connection count here.
// `ws_connections` already exists, registered in internal/server/server.go as a
// prometheus.GaugeFunc that reads hub.Count() at SCRAPE time. That is the
// better shape — a counter incremented on Add and decremented on Remove can
// drift if a teardown path is ever missed, and a func gauge cannot — so this
// package does not compete with it. It is also the metric to autoscale on:
// a websocket costs memory and two goroutines for as long as it is open and
// almost no CPU while idle, so CPU utilisation is close to uncorrelated with
// how full a pod actually is.

var (
	// ConnectionsRejectedTotal counts upgrades refused at a cap.
	//
	// The `reason` label is the point. "node" means this pod is full and the
	// fleet needs more capacity; "per_user" means one client is opening sockets
	// in a loop and capacity is fine. Those call for opposite responses, and an
	// unlabelled counter would make them indistinguishable.
	ConnectionsRejectedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_connections_rejected_total",
		Help: "Websocket upgrades refused, by which cap was hit.",
	}, []string{"reason"})

	// ConnectionsShedTotal counts sockets dropped for being too slow to drain.
	//
	// Not an error: the event is already in the user's replay outbox and comes
	// back on reconnect. It IS the signal that sendChanCap is too small for
	// real traffic, so it is the number to watch after changing it.
	ConnectionsShedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_connections_shed_total",
		Help: "Sockets closed because their outbound buffer was full.",
	})

	// SendBufferDepth is how full outbound buffers actually get.
	//
	// This exists to check an assumption rather than to alarm on. sendChanCap
	// was cut from 512 to 64 on the argument that a socket holding more than a
	// short burst is behind rather than bursty, and that shedding it is both
	// cheap and lossless. This is the distribution that either supports that or
	// refutes it — if the p99 sits near the cap, the argument was wrong.
	//
	// Observed on every enqueue, which is the only way to get a real
	// distribution. A histogram observation is a few atomic adds; at the
	// volumes where that cost matters, the fan-out itself dominates it.
	SendBufferDepth = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name: "ws_send_buffer_depth",
		Help: "Queued messages on a connection's outbound buffer at enqueue time.",
		// Tuned to sendChanCap=64, with headroom above it so a raised cap still
		// produces a readable distribution rather than one saturated bucket.
		Buckets: []float64{0, 1, 2, 4, 8, 16, 32, 48, 64, 128, 256, 512},
	})
)

// ── Fan-out ──────────────────────────────────────────────────────────────────

var (
	// FanoutEventsConsumed counts events read from Kafka by this pod.
	//
	// Identical on every pod today, because each one subscribes under its own
	// consumer group and therefore receives the entire stream. That it is
	// identical is itself the finding.
	FanoutEventsConsumed = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_fanout_events_consumed_total",
		Help: "Events read from Kafka by this node.",
	})

	// FanoutRecipientsTotal counts (event, recipient) pairs this pod processed.
	// One event addressed to forty people is forty here.
	FanoutRecipientsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_fanout_recipients_total",
		Help: "Event-recipient pairs processed by this node.",
	})

	// FanoutDeliveredTotal counts pairs where the recipient had a socket HERE.
	FanoutDeliveredTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_fanout_delivered_total",
		Help: "Event-recipient pairs delivered to a socket on this node.",
	})

	// FanoutDiscardedTotal counts pairs whose recipient is not on this node.
	//
	// THE AMPLIFICATION NUMBER. Divide by FanoutRecipientsTotal and you have
	// the share of this pod's fan-out work done for users it does not serve.
	// With N pods and users spread evenly it tends to (N-1)/N — so it gets
	// WORSE as the fleet grows, which is the opposite of what adding capacity
	// is supposed to do, and is why routed delivery is the next piece of work.
	FanoutDiscardedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_fanout_discarded_total",
		Help: "Event-recipient pairs computed on this node for users it does not hold.",
	})

	// FanoutOutboxWritesTotal counts replay-outbox writes attempted.
	//
	// Tracks FanoutRecipientsTotal, because the outbox is written for every
	// recipient on every pod — so the same Redis write happens once per pod.
	// The `result` label separates a Redis problem from a fan-out problem.
	FanoutOutboxWritesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_fanout_outbox_writes_total",
		Help: "Replay-outbox writes attempted during fan-out, by outcome.",
	}, []string{"result"})

	// FanoutEventsSkippedTotal counts events consumed and deliberately NOT
	// delivered because no retry could ever make them deliverable (today:
	// payloads that do not parse). The offset moves past these, so this counter
	// is the only trace they leave — a non-zero rate is a producer bug.
	FanoutEventsSkippedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_fanout_events_skipped_total",
		Help: "Events consumed but skipped as permanently undeliverable, by reason.",
	}, []string{"reason"})

	// RouteRetriesTotal counts routed-delivery attempts that failed on a
	// transient dependency error (Redis) and were retried without committing
	// the Kafka offset. A sustained rate means the consumer is stalled behind a
	// Redis problem — which is the correct behaviour, and worth an alert.
	RouteRetriesTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_route_retries_total",
		Help: "Routed-delivery attempts retried after a transient dependency failure.",
	})
)

// SkipUnparseable is the FanoutEventsSkippedTotal reason for a payload that is
// not valid JSON.
const SkipUnparseable = "unparseable"

// ── Routed delivery ──────────────────────────────────────────────────────────
//
// The replacement for broadcast fan-out. These are what say whether it is
// actually carrying traffic, which is the question that governs when the old
// path can be switched off — running both at once is safe (delivery is
// idempotent and clients dedupe on eventId) but only worth doing briefly.

var (
	// PushSentTotal counts deliveries the delivery service handed to a node.
	PushSentTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_push_sent_total",
		Help: "Deliveries pushed to a gateway node, by outcome.",
	}, []string{"result"})

	// PushRequestsTotal counts push REQUESTS, one per node per batch, as
	// distinct from the deliveries inside them. The ratio between the two is
	// the batching factor — the thing that decides whether an HTTP-per-batch
	// transport is adequate or whether this needs a persistent stream.
	PushRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_push_requests_total",
		Help: "Push requests made to gateway nodes, by outcome.",
	}, []string{"result"})

	// PushUnroutableTotal counts recipients with no live node to send to.
	//
	// Not an error — an offline user is the ordinary case, and their events are
	// in the replay outbox waiting for them. It is the routed-mode counterpart
	// of FanoutDiscardedTotal, and the contrast is the point: broadcast
	// DISCARDS work it already did, routed mode never does the work at all.
	PushUnroutableTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_push_unroutable_total",
		Help: "Recipients with no live gateway node; left for replay on reconnect.",
	})

	// PushReceivedTotal counts deliveries arriving at a gateway node.
	//
	// `missing` means the recipient had already disconnected by the time the
	// push landed. A steady stream of it means the routing table is lagging
	// reality rather than that clients are flaky.
	PushReceivedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_push_received_total",
		Help: "Deliveries received by this node from the delivery service.",
	}, []string{"result"})
)

// ── Cross-node RTC and presence ──────────────────────────────────────────────
//
// Separate from the ws_push_* family above even though they share a transport,
// because they answer a different question and are emitted by a different
// process. ws_push_* is delivery-svc pushing fan-out events INTO gateways, and
// its rate climbing is the signal that routed mode is working. These are one
// gateway reaching ANOTHER gateway to place a signalling frame or a presence
// transition, and they exist in both fan-out modes. Folding them together would
// make ws_push_sent_total climb on a fleet that has no delivery-svc at all.

var (
	// NodeFanoutRequestsTotal counts peer-node requests, one per node per event.
	NodeFanoutRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_node_fanout_requests_total",
		Help: "Requests made to peer gateway nodes for RTC signalling and presence.",
	}, []string{"result"})

	// NodeFanoutRecipientsTotal counts recipients, split by where they were
	// reached. `local` never touched the network; `remote` crossed to a peer.
	//
	// The ratio is worth watching for its own sake: a high local share means the
	// load balancer's userId affinity is doing its job and calls are landing
	// both parties on one pod, which is the cheapest possible outcome.
	NodeFanoutRecipientsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_node_fanout_recipients_total",
		Help: "Recipients of a cross-node RTC or presence delivery, by where they were reached.",
	}, []string{"where"})

	// NodeFanoutUnroutableTotal counts recipients found neither here nor on any
	// registered node.
	//
	// This is the metric that catches the one silent misconfiguration in this
	// design. A fleet where WS_ADVERTISE_ADDR is unset registers no nodes, so
	// every recipient who is not local is unroutable — calls between users on
	// different pods simply never connect, and nothing else in the system looks
	// wrong. Some of this is ordinary (a peer who closed their laptop between
	// the presence read and the send), so it is the RATE relative to `remote`
	// that matters, which is what the alert in rules/gateway.yml keys on.
	NodeFanoutUnroutableTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_node_fanout_unroutable_total",
		Help: "Recipients with no local socket and no registered node to reach them on.",
	})
)

// Where a cross-node recipient was reached.
const (
	WhereLocal  = "local"
	WhereRemote = "remote"
)

// RouteCacheTotal counts lookups served from a local cache rather than Redis.
//
// Every rtc.* frame asks the same two questions — is this peer a same-org online
// user, and what address reaches their node — and ICE candidates trickle, so a
// single call setup asks them dozens of times over a few seconds. The hit ratio
// is what says whether the caches are doing their job; if it collapses, the
// Redis load they were introduced to remove has come back.
var RouteCacheTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "ws_route_cache_total",
	Help: "Signalling route lookups, by cache and whether they were served locally.",
}, []string{"cache", "result"})

// Route caches and their outcomes.
const (
	// CachePeer is the same-org online check for a signalling destination.
	CachePeer = "peer"
	// CacheNodeAddr is the node id → address mapping.
	CacheNodeAddr = "node_addr"
	// CacheBlock is Forward's block-list check (signal/dispatcher.go's
	// forwardAllowed) — unlike CachePeer/CacheNodeAddr this one caches BOTH
	// hit outcomes (blocked and not-blocked), see that cache's own comment.
	CacheBlock = "block"

	CacheHit  = "hit"
	CacheMiss = "miss"
)

// ── Redis ────────────────────────────────────────────────────────────────────

var (
	// RedisOpsTotal counts Redis round trips by what they were for.
	//
	// The `purpose` split is what makes this actionable. One Redis serves
	// presence heartbeats, replay outboxes and pub/sub, and those have very
	// different shapes — presence is a high-rate write of tiny values, replay
	// is a lower-rate write to large sorted sets. Sizing or sharding the tier
	// needs to know which of them is the load, and an aggregate cannot say.
	RedisOpsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_redis_ops_total",
		Help: "Redis operations by purpose and outcome.",
	}, []string{"purpose", "result"})

	// RedisOpDuration is latency by purpose, for the same reason.
	RedisOpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "ws_redis_op_duration_seconds",
		Help:    "Redis operation latency by purpose.",
		Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
	}, []string{"purpose"})
)

// Redis purposes. Constants rather than string literals at the call sites, so a
// typo becomes a compile error instead of a silently separate time series.
const (
	// PurposePresence covers the heartbeat and online-set traffic. Highest
	// rate by a wide margin: every socket writes every ping interval.
	PurposePresence = "presence"
	// PurposeOutbox covers the per-user replay buffers.
	PurposeOutbox = "outbox"
	// PurposeNodes covers the node registry — which node holds a user, and what
	// address reaches it.
	//
	// This replaces a `pubsub` purpose that no longer has any call sites: RTC
	// signalling and presence stopped using Redis pub/sub, and pre-creating a
	// series for traffic that can no longer occur would leave a dashboard panel
	// reading a permanent, meaningless zero. The registry took over that role
	// and is a genuinely separate load shape from the presence heartbeats it was
	// previously counted with — small reads on the signalling path, rather than
	// a high-rate write from every socket on a timer.
	PurposeNodes = "nodes"
)

// ── Session revocation ───────────────────────────────────────────────────────
//
// See internal/revoke. These exist to answer one question in production: is a
// revoke (self-service "sign out" or an admin kicking a member) actually
// reaching connected sockets promptly, or is enforcement silently falling
// back to the slower token-expiry check in server/conn.go's writeLoop?

var (
	// SessionRevokeEventsTotal counts session.revoked events this node
	// processed — identical on every node, since each subscribes to the
	// entire auth.events stream (see revoke.New's doc comment on why that is
	// the right shape here, unlike fan-out).
	SessionRevokeEventsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_session_revoke_events_total",
		Help: "session.revoked events read from auth.events by this node.",
	})

	// SessionRevokeDisconnectsTotal counts sockets actually closed as a
	// result. Near-zero relative to SessionRevokeEventsTotal is the ordinary
	// case (most revokes target a session with no currently-open socket, or
	// one that lives on a different node); a sustained zero on EVERY node for
	// a workload that should be producing some is the sign this pipeline
	// stopped working.
	SessionRevokeDisconnectsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "ws_session_revoke_disconnects_total",
		Help: "Sockets force-closed because their session was revoked.",
	})
)

// ── TURN ─────────────────────────────────────────────────────────────────────

// TurnCredentialsTotal counts credential mints, and whether a relay was
// actually on offer.
//
// The `turn` label is the interesting half. When no TURN secret or URL is
// configured the endpoint still answers 200 — with STUN only — and every client
// behind a symmetric NAT then fails to connect while the API looks healthy.
// That is not hypothetical: the Helm chart ships no coturn at all, so a
// Kubernetes deployment is in exactly this state. `turn="unavailable"` climbing
// is the signal, and there was previously nothing that showed it.
var TurnCredentialsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "ws_turn_credentials_total",
	Help: "ICE credential responses issued, by whether a TURN relay was offered.",
}, []string{"turn"})

// TURN availability label values.
const (
	TurnOffered     = "offered"
	TurnUnavailable = "unavailable"
)

func init() {
	prometheus.MustRegister(
		ConnectionsRejectedTotal,
		ConnectionsShedTotal,
		SendBufferDepth,
		FanoutEventsConsumed,
		FanoutRecipientsTotal,
		FanoutDeliveredTotal,
		FanoutDiscardedTotal,
		FanoutOutboxWritesTotal,
		FanoutEventsSkippedTotal,
		RouteRetriesTotal,
		PushSentTotal,
		PushRequestsTotal,
		PushUnroutableTotal,
		PushReceivedTotal,
		NodeFanoutRequestsTotal,
		NodeFanoutRecipientsTotal,
		NodeFanoutUnroutableTotal,
		RouteCacheTotal,
		RedisOpsTotal,
		RedisOpDuration,
		SessionRevokeEventsTotal,
		SessionRevokeDisconnectsTotal,
		TurnCredentialsTotal,
	)
	// Pre-create the label combinations that matter, so a dashboard shows a
	// flat zero rather than "no data" before the first occurrence. A panel that
	// reads "no data" is ambiguous — nothing happened, or nothing is reporting?
	for _, r := range []string{"node", "per_user"} {
		ConnectionsRejectedTotal.WithLabelValues(r)
	}
	for _, r := range []string{"ok", "error"} {
		FanoutOutboxWritesTotal.WithLabelValues(r)
		PushSentTotal.WithLabelValues(r)
		PushRequestsTotal.WithLabelValues(r)
	}
	FanoutEventsSkippedTotal.WithLabelValues(SkipUnparseable)
	for _, r := range []string{"delivered", "missing"} {
		PushReceivedTotal.WithLabelValues(r)
	}
	for _, r := range []string{"ok", "error"} {
		NodeFanoutRequestsTotal.WithLabelValues(r)
	}
	for _, w := range []string{WhereLocal, WhereRemote} {
		NodeFanoutRecipientsTotal.WithLabelValues(w)
	}
	for _, c := range []string{CachePeer, CacheNodeAddr, CacheBlock} {
		for _, r := range []string{CacheHit, CacheMiss} {
			RouteCacheTotal.WithLabelValues(c, r)
		}
	}
	for _, p := range []string{PurposePresence, PurposeOutbox, PurposeNodes} {
		for _, r := range []string{"ok", "error"} {
			RedisOpsTotal.WithLabelValues(p, r)
		}
		// The histogram needs this too, and more urgently: a *Vec with no
		// children exports NOTHING — the metric family is absent from the
		// scrape entirely, not merely zero. The WSGatewayRedisSlow alert
		// queries ws_redis_op_duration_seconds_bucket by name, and a query
		// against a family Prometheus has never seen does not error, it
		// evaluates to empty and the alert silently never fires.
		RedisOpDuration.WithLabelValues(p)
	}
	for _, t := range []string{TurnOffered, TurnUnavailable} {
		TurnCredentialsTotal.WithLabelValues(t)
	}
}

// Result maps an error to the `result` label. One helper so "ok"/"error" is
// spelled the same way everywhere.
func Result(err error) string {
	if err != nil {
		return "error"
	}
	return "ok"
}
