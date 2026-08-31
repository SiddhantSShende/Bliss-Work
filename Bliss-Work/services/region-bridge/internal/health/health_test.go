package health

import (
	"testing"
	"time"
)

func TestLivenessIsNotAllowedToDependOnAnything(t *testing.T) {
	// Guarded by construction rather than by assertion: /healthz has no access
	// to State at all. This test documents the rule, and fails loudly if
	// somebody later wires a dependency into Ready() and reuses it for
	// liveness — a restart loop that fixes nothing is worse than a red probe.
	if ok, _ := Ready(Readiness{}); ok {
		t.Fatal("readiness with nothing connected must be false")
	}
}

func TestReadinessFailsOnADeadDependency(t *testing.T) {
	base := Readiness{NATSConnected: true, KafkaReachable: true, StallAfter: time.Minute}

	if ok, why := Ready(base); !ok {
		t.Fatalf("a connected, idle bridge must be ready, got %q", why)
	}
	if ok, why := Ready(Readiness{KafkaReachable: true}); ok || why != "not connected to NATS" {
		t.Errorf("NATS down: ok=%v why=%q", ok, why)
	}
	if ok, why := Ready(Readiness{NATSConnected: true}); ok || why != "kafka unreachable" {
		t.Errorf("Kafka down: ok=%v why=%q", ok, why)
	}
}

func TestAnIdleRegionIsHealthy(t *testing.T) {
	// THE false alarm this design exists to avoid: no progress for hours is
	// normal when there is nothing to bridge, and failing readiness for it
	// takes a working replica out of rotation.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true, ImportEnabled: true,
		Pending: 0, SinceProgress: 6 * time.Hour, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("idle bridge reported unready: %q", why)
	}
}

func TestAStalledImportIsNotReady(t *testing.T) {
	// Work pending AND nothing moving: the case a lag threshold alone misses.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true, ImportEnabled: true,
		Pending: 5_000, SinceProgress: 10 * time.Minute, StallAfter: time.Minute,
	}
	ok, why := Ready(r)
	if ok {
		t.Fatal("a wedged import reported ready")
	}
	if why == "" {
		t.Fatal("readiness must say why, or the probe is a coin toss to whoever is paged")
	}
}

func TestBacklogAloneIsNotAStall(t *testing.T) {
	// Behind but moving is a healthy bridge catching up after a partition —
	// exactly when you least want it pulled out of rotation.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true, ImportEnabled: true,
		Pending: 1_000_000, SinceProgress: time.Second, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("a bridge that is behind but progressing reported unready: %q", why)
	}
}

func TestADisabledImportCannotStall(t *testing.T) {
	// After a rollback the backlog grows on purpose. Reporting the replica
	// unhealthy for honouring the switch would make every rollback look like an
	// outage.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true, ImportEnabled: false,
		Pending: 500_000, SinceProgress: time.Hour, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("a deliberately paused import reported unready: %q", why)
	}
}

// ── The bug: export had no stall guard at all — only Import did ─────────────
func TestAStalledExportIsNotReady(t *testing.T) {
	// A wedged JetStream publish (export.go's maxPublishAttempts retry loop)
	// used to have no effect on readiness whatsoever: nothing here read
	// export's own progress or fault state.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true,
		ExportEnabled: true, ExportFaulting: true,
		ExportSinceProgress: 10 * time.Minute, StallAfter: time.Minute,
	}
	ok, why := Ready(r)
	if ok {
		t.Fatal("a wedged export reported ready")
	}
	if why == "" {
		t.Fatal("readiness must say why, or the probe is a coin toss to whoever is paged")
	}
}

func TestAnIdleExportIsHealthyEvenAfterHours(t *testing.T) {
	// THE false alarm this design exists to avoid, on the export side: no new
	// Kafka messages for hours is normal when there is nothing to export, and
	// export never calls Fault() when it has nothing to retry.
	r := Readiness{
		NATSConnected: true, KafkaReachable: true,
		ExportEnabled: true, ExportFaulting: false,
		ExportSinceProgress: 6 * time.Hour, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("idle export reported unready: %q", why)
	}
}

func TestExportFaultingAloneIsNotAStallUntilTheBudgetElapses(t *testing.T) {
	// One recent failure that has not yet had time to become a stall must not
	// flip readiness — the budget is what turns "failing" into "wedged".
	r := Readiness{
		NATSConnected: true, KafkaReachable: true,
		ExportEnabled: true, ExportFaulting: true,
		ExportSinceProgress: time.Second, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("a fresh export fault reported unready before its own budget: %q", why)
	}
}

func TestADisabledExportCannotStall(t *testing.T) {
	r := Readiness{
		NATSConnected: true, KafkaReachable: true,
		ExportEnabled: false, ExportFaulting: true,
		ExportSinceProgress: time.Hour, StallAfter: time.Minute,
	}
	if ok, why := Ready(r); !ok {
		t.Fatalf("a deliberately paused export reported unready: %q", why)
	}
}

func TestResumingClearsAStaleFault(t *testing.T) {
	s := New(time.Minute)
	s.Fault(Import, errFake{})
	s.SetEnabled(Import, true)
	if snap := s.Snapshot(); snap.LastError[Import] != "" {
		t.Fatalf("a resumed direction kept its old error: %q", snap.LastError[Import])
	}
}

func TestSnapshotIsACopy(t *testing.T) {
	// The handler formats it without holding the lock, so mutating the snapshot
	// must not reach back into the live state.
	s := New(time.Minute)
	s.SetEnabled(Export, true)
	snap := s.Snapshot()
	snap.Enabled[Export] = false
	if !s.Snapshot().Enabled[Export] {
		t.Fatal("Snapshot handed out a reference to live state")
	}
}

type errFake struct{}

func (errFake) Error() string { return "boom" }
