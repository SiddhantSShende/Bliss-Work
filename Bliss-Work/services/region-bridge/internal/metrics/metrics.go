// Package metrics is the bridge's Prometheus surface.
//
// Four questions decide whether a cross-region bridge is healthy, and every
// collector here answers one of them:
//
//	is it moving?      bridged_total, by direction and topic
//	is it behind?      pending (JetStream), and the age of the last success
//	is it looping?     rejected_total{reason="returned"} — must be zero, always
//	is it losing?      dlq_total, and failures_total
//
// The loop counter is the one to alert on hardest. A cycle does not announce
// itself as an error: every individual publish succeeds, and the only symptom
// is that the numbers climb until the WAN link saturates.
package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	// Bridged counts events that crossed the boundary. `direction` is
	// export|import; `topic` is the Kafka topic, which is the unit anyone
	// reasons about here.
	Bridged = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "region_bridge_bridged_total",
		Help: "Events successfully bridged across the region boundary.",
	}, []string{"direction", "topic"})

	// Skipped counts the ordinary no-op: an event this region did not produce
	// and therefore must not export. High and climbing is CORRECT — it is one
	// per event every peer sent us. Flat at zero in a multi-region mesh means
	// import is not running.
	Skipped = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "region_bridge_skipped_total",
		Help: "Events deliberately not bridged (foreign origin — the cycle break).",
	}, []string{"direction", "reason"})

	// Rejected counts events that should not have existed in the shape they
	// arrived in. Every reason here is somebody else's bug; `reason=returned`
	// specifically means a replication cycle is forming and the topology is
	// wrong. Alert on any non-zero rate.
	Rejected = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "region_bridge_rejected_total",
		Help: "Events refused at the boundary (loop, missing provenance, hop limit).",
	}, []string{"direction", "reason"})

	// Failures counts transient errors — a broker election, a NATS reconnect,
	// a WAN blip. Expected to be non-zero over a long enough window; a
	// SUSTAINED rate is the alert.
	Failures = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "region_bridge_failures_total",
		Help: "Transient failures while bridging; the batch is retried.",
	}, []string{"direction", "stage"})

	// DLQ counts events set aside so they stop blocking the events behind
	// them. Any value above zero is a thing a human has to look at.
	DLQ = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "region_bridge_dlq_total",
		Help: "Events dead-lettered after exhausting retries or failing validation.",
	}, []string{"direction", "reason"})

	// LastSuccess is the unix timestamp of the last event that crossed. Paired
	// with Pending it distinguishes "idle" from "stuck", which a lag number
	// alone cannot.
	LastSuccess = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "region_bridge_last_success_timestamp_seconds",
		Help: "When an event last crossed the boundary, per direction.",
	}, []string{"direction"})

	// Pending is the JetStream consumer backlog — events replicated to this
	// region and not yet written to local Kafka. The single best indicator of
	// cross-region replication lag.
	Pending = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "region_bridge_pending_messages",
		Help: "Events waiting to be imported into local Kafka.",
	})

	// Up reports whether each half is running, so a rollback (either half
	// switched off) is visible on the dashboard rather than looking like an
	// outage.
	Up = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "region_bridge_enabled",
		Help: "1 when a direction is enabled and running, 0 when switched off.",
	}, []string{"direction"})
)

// Register adds every collector to r. Called once at startup.
func Register(r prometheus.Registerer) {
	r.MustRegister(Bridged, Skipped, Rejected, Failures, DLQ, LastSuccess, Pending, Up)
}
