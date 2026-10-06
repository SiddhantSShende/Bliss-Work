// Package metrics holds messaging-svc's domain telemetry.
//
// ── Why this is a package ────────────────────────────────────────────────────
// The HTTP request counters live in internal/middleware because they belong to
// the HTTP middleware and nothing else needs them. These belong to the outbox
// publisher, which internal/middleware must not import. A leaf package everyone
// can import is the shape that works — the same reasoning as ws-gateway's.
//
// ── What these are actually for ──────────────────────────────────────────────
// The outbox is the only path by which anything this service does becomes
// visible to the rest of the platform, and until now it was unobservable: a
// publish failure produced a log line, and a publish failure that could never
// succeed produced the same log line every 500 ms forever while every event in
// the platform queued behind it. Nothing counted, nothing alerted, and the
// symptom users saw — "messages stopped arriving" — pointed at the gateway.
//
// OutboxDeadLetteredTotal is the one to page on. It is non-zero only when an
// event a user's action produced will never reach a consumer, which is silent
// everywhere else: the write succeeded, the API returned 201, and the delivery
// simply never happens.
package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	// OutboxPublishedTotal counts rows that actually reached Kafka.
	//
	// The useful reading is its RATE against the insert rate: a publisher
	// keeping up shows the two matching, and a growing gap is the earliest
	// signal of a stalled queue — earlier than consumer lag, which cannot go up
	// until something is produced.
	OutboxPublishedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "messaging_outbox_published_total",
		Help: "Outbox rows successfully published to Kafka.",
	})

	// OutboxDeadLetteredTotal counts rows set aside as unpublishable.
	//
	// Deliberately a counter and not a gauge: the question worth alerting on is
	// "did this EVER happen", not "how many are there now". Any increment means
	// data loss that no other signal reports.
	OutboxDeadLetteredTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "messaging_outbox_dead_lettered_total",
		Help: "Outbox rows quarantined as permanently unpublishable. Any increase is silent event loss.",
	})

	// ConsumerEventsSkippedTotal counts Kafka events a consumer committed past
	// WITHOUT applying them, because applying them can never succeed (reason
	// "malformed": unparseable JSON, a bad id; "permanent_db": a Postgres data
	// or constraint error). There is no dead-letter topic for these consumers,
	// so this counter plus the ERROR log line is the whole trail. Any increase
	// is an event that was dropped — a user that never reached user_projection,
	// a deactivation or org purge never applied — and is worth a page.
	ConsumerEventsSkippedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_consumer_events_skipped_total",
		Help: "Kafka events committed without being applied because they can never succeed. Any increase is a dropped event.",
	}, []string{"consumer", "reason"})

	// NOTE: the standing backlog — `messaging_outbox_dead_lettered` — is
	// deliberately NOT here. It is registered as a prometheus.GaugeFunc in
	// cmd/server, where the store is in scope, so it reads the database at
	// SCRAPE time. A counter incremented in this process cannot answer "is
	// anything stuck right now" after a restart: it would report zero while
	// rows sat quarantined. The counter above answers "did this ever happen";
	// only the gauge survives a deploy.
)

func init() {
	prometheus.MustRegister(OutboxPublishedTotal, OutboxDeadLetteredTotal, ConsumerEventsSkippedTotal)
}
