// Package health is what an orchestrator, a dashboard and an on-call engineer
// each read to answer a different question about the bridge.
//
//	/healthz  liveness  — the process is alive. Never fails on a dependency, or
//	                      Kubernetes restarts the bridge every time the WAN
//	                      hiccups and the restart clears no fault at all.
//	/readyz   readiness — this replica is doing its job. Fails on a dependency
//	                      that is genuinely down, and on a STALL: work pending
//	                      and nothing moving.
//	/metrics  the numbers (see internal/metrics).
//	/status   a human-readable snapshot for a runbook.
//
// The distinction between the first two is the point. Liveness that checks a
// dependency turns someone else's outage into a restart loop of your own.
package health

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Direction names a half of the bridge.
type Direction string

const (
	Export Direction = "export"
	Import Direction = "import"
)

// State is the bridge's view of itself. Every field is written by a worker and
// read by an HTTP handler, so all access goes through the mutex — and the
// mutex is never held across I/O, which is the rule that keeps a health check
// from being able to deadlock the thing it reports on.
type State struct {
	mu sync.RWMutex

	natsConnected  bool
	kafkaReachable bool

	enabled     map[Direction]bool
	lastSuccess map[Direction]time.Time
	lastError   map[Direction]string

	pending    uint64
	stallAfter time.Duration
	startedAt  time.Time
}

func New(stallAfter time.Duration) *State {
	return &State{
		enabled:     map[Direction]bool{},
		lastSuccess: map[Direction]time.Time{},
		lastError:   map[Direction]string{},
		stallAfter:  stallAfter,
		startedAt:   time.Now(),
	}
}

func (s *State) SetNATS(ok bool)  { s.mu.Lock(); s.natsConnected = ok; s.mu.Unlock() }
func (s *State) SetKafka(ok bool) { s.mu.Lock(); s.kafkaReachable = ok; s.mu.Unlock() }

func (s *State) SetEnabled(d Direction, on bool) {
	s.mu.Lock()
	s.enabled[d] = on
	// A direction that has just been switched on has, by definition, not failed
	// or stalled yet. Carrying a stale error across a resume would make a
	// successful rollback look like a broken one.
	if on {
		s.lastError[d] = ""
		s.lastSuccess[d] = time.Now()
	}
	s.mu.Unlock()
}

// Progress records that work actually crossed the boundary.
func (s *State) Progress(d Direction) {
	s.mu.Lock()
	s.lastSuccess[d] = time.Now()
	s.lastError[d] = ""
	s.mu.Unlock()
}

// Fault records the most recent failure for a direction. Kept as the LAST one
// rather than a list: the first error of an outage is usually the interesting
// one, but it is also the one already in the logs, and a health endpoint that
// accumulates strings is a memory leak with a URL.
func (s *State) Fault(d Direction, err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	s.lastError[d] = err.Error()
	s.mu.Unlock()
}

// SetPending publishes the import backlog — the cross-region replication lag.
func (s *State) SetPending(n uint64) { s.mu.Lock(); s.pending = n; s.mu.Unlock() }

// Snapshot is a consistent copy for reporting. Taken under the lock and
// returned by value so a handler can format it at leisure without holding
// anything a worker needs.
type Snapshot struct {
	NATSConnected  bool                 `json:"natsConnected"`
	KafkaReachable bool                 `json:"kafkaReachable"`
	Enabled        map[Direction]bool   `json:"enabled"`
	LastSuccess    map[Direction]string `json:"lastSuccess"`
	LastError      map[Direction]string `json:"lastError,omitempty"`
	Pending        uint64               `json:"pendingImport"`
	UptimeSeconds  int64                `json:"uptimeSeconds"`
}

func (s *State) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap := Snapshot{
		NATSConnected:  s.natsConnected,
		KafkaReachable: s.kafkaReachable,
		Enabled:        map[Direction]bool{},
		LastSuccess:    map[Direction]string{},
		LastError:      map[Direction]string{},
		Pending:        s.pending,
		UptimeSeconds:  int64(time.Since(s.startedAt).Seconds()),
	}
	for d, v := range s.enabled {
		snap.Enabled[d] = v
	}
	for d, t := range s.lastSuccess {
		if !t.IsZero() {
			snap.LastSuccess[d] = t.UTC().Format(time.RFC3339)
		}
	}
	for d, e := range s.lastError {
		if e != "" {
			snap.LastError[d] = e
		}
	}
	return snap
}

// Readiness is the pure decision behind /readyz, split out so the policy can be
// tested without a server, a clock or a NATS connection.
type Readiness struct {
	NATSConnected  bool
	KafkaReachable bool
	ImportEnabled  bool
	Pending        uint64
	SinceProgress  time.Duration
	StallAfter     time.Duration

	// Export has no queue-depth signal the way Import has Pending (it reads a
	// local Kafka topic, not a lagging JetStream consumer this process can
	// size), so its stall guard uses a different "is there work to do"
	// witness: ExportFaulting is whether the exporter has recorded a failure
	// since its last successful publish. That is exactly what the retry loop
	// in internal/bridge/export.go already tracks — Fault() on every failed
	// attempt, cleared by Progress() on the next success — so a healthy idle
	// exporter (no failures, ever-growing SinceProgress) never trips this,
	// while one stuck retrying a batch it cannot get rid of does.
	ExportEnabled       bool
	ExportFaulting      bool
	ExportSinceProgress time.Duration
}

// Ready reports whether this replica should receive traffic, and why not.
func Ready(r Readiness) (bool, string) {
	if !r.NATSConnected {
		return false, "not connected to NATS"
	}
	if !r.KafkaReachable {
		return false, "kafka unreachable"
	}
	// A STALL, not a lag. Pending work with no progress for longer than the
	// budget means this replica is wedged — the case a lag threshold alone
	// misses, because a bridge that is merely behind is still making progress
	// and a bridge that is stuck may have a small backlog.
	//
	// Guarded on there being work to do: an idle region legitimately makes no
	// progress for hours, and reporting that as unhealthy would take a healthy
	// replica out of rotation for the crime of having nothing to do.
	if r.ImportEnabled && r.Pending > 0 && r.SinceProgress > r.StallAfter {
		return false, "import stalled: " + r.Pending2String()
	}
	// The export-side equivalent: see ExportFaulting's own doc comment for why
	// it, not a pending count, is the "is there work to do" witness here.
	if r.ExportEnabled && r.ExportFaulting && r.ExportSinceProgress > r.StallAfter {
		return false, "export stalled: no successful publish in " +
			r.ExportSinceProgress.Round(time.Second).String()
	}
	return true, "ok"
}

// Pending2String keeps the stall message specific enough to act on.
func (r Readiness) Pending2String() string {
	b, _ := json.Marshal(struct {
		Pending       uint64 `json:"pending"`
		SinceProgress string `json:"sinceProgress"`
	}{r.Pending, r.SinceProgress.Round(time.Second).String()})
	return string(b)
}

// Handler wires the four endpoints onto a mux.
func (s *State) Handler(mux *http.ServeMux, metrics http.Handler) {
	// Liveness. Deliberately dependency-free: if this process can serve a
	// request it is alive, and restarting it will not fix NATS.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.RLock()
		r := Readiness{
			NATSConnected:       s.natsConnected,
			KafkaReachable:      s.kafkaReachable,
			ImportEnabled:       s.enabled[Import],
			Pending:             s.pending,
			SinceProgress:       time.Since(s.lastSuccess[Import]),
			StallAfter:          s.stallAfter,
			ExportEnabled:       s.enabled[Export],
			ExportFaulting:      s.lastError[Export] != "",
			ExportSinceProgress: time.Since(s.lastSuccess[Export]),
		}
		if s.lastSuccess[Import].IsZero() {
			// Never having succeeded is not a stall: a replica that has just
			// started has not had the chance. Uptime is the honest clock here.
			r.SinceProgress = time.Since(s.startedAt)
		}
		if s.lastSuccess[Export].IsZero() {
			r.ExportSinceProgress = time.Since(s.startedAt)
		}
		s.mu.RUnlock()

		ok, why := Ready(r)
		if !ok {
			http.Error(w, why, http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ready"))
	})

	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Snapshot())
	})

	mux.Handle("/metrics", metrics)
}
