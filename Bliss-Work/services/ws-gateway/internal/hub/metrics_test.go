package hub

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/task-board/ws-gateway/internal/metrics"
)

// Fanout's return value IS the amplification measurement.
//
// Every gateway pod consumes every event on every fan-out topic and computes
// every recipient, so the only thing separating useful work from wasted work is
// whether the recipient actually had a socket here. If this ever reported true
// for a user who is not on this node — or false for one who is — the headline
// number in every capacity conversation would be quietly wrong, and nothing
// else in the system would notice.
func TestFanoutReportsWhetherDeliveryWasLocal(t *testing.T) {
	h := New()
	c := NewConn("present-user", "conn-1")
	if !h.Add(c, 0, 0) {
		t.Fatal("Add refused with no caps configured")
	}

	if !h.Fanout("present-user", []byte(`{}`)) {
		t.Error("Fanout reported no local delivery for a user registered on this node")
	}
	if h.Fanout("absent-user", []byte(`{}`)) {
		t.Error("Fanout claimed local delivery for a user with no socket here; " +
			"this is the number the fan-out amplification ratio is built from")
	}
}

// A user with no connections left must not still count as local. Remove drops
// the empty map, and a stale entry here would understate the discarded count.
func TestFanoutIsNotLocalAfterTheLastSocketGoes(t *testing.T) {
	h := New()
	c := NewConn("u", "c1")
	h.Add(c, 0, 0)
	h.Remove(c)

	if h.Fanout("u", []byte(`{}`)) {
		t.Error("Fanout still reports local delivery after the last socket was removed")
	}
}

// The two caps mean opposite things operationally — "the fleet is full" versus
// "one client is looping" — so they must not land on the same series.
func TestRejectionsAreLabelledByWhichCapWasHit(t *testing.T) {
	nodeBefore := testutil.ToFloat64(metrics.ConnectionsRejectedTotal.WithLabelValues("node"))
	userBefore := testutil.ToFloat64(metrics.ConnectionsRejectedTotal.WithLabelValues("per_user"))

	h := New()
	// Node cap of 1: the first connection is accepted, the second is refused
	// because the NODE is full.
	if !h.Add(NewConn("a", "c1"), 1, 0) {
		t.Fatal("first Add refused under a node cap of 1")
	}
	if h.Add(NewConn("b", "c2"), 1, 0) {
		t.Fatal("second Add accepted past the node cap")
	}

	// Per-user cap of 1 on a hub with room to spare: refused for the OTHER
	// reason entirely.
	h2 := New()
	if !h2.Add(NewConn("a", "c1"), 0, 1) {
		t.Fatal("first Add refused under a per-user cap of 1")
	}
	if h2.Add(NewConn("a", "c2"), 0, 1) {
		t.Fatal("second Add accepted past the per-user cap")
	}

	if got := testutil.ToFloat64(
		metrics.ConnectionsRejectedTotal.WithLabelValues("node")) - nodeBefore; got != 1 {
		t.Errorf(`reason="node" rose by %v, want 1`, got)
	}
	if got := testutil.ToFloat64(
		metrics.ConnectionsRejectedTotal.WithLabelValues("per_user")) - userBefore; got != 1 {
		t.Errorf(`reason="per_user" rose by %v, want 1`, got)
	}
}

// Shedding is not an error — the event is in the replay outbox and comes back
// on reconnect — but it is the signal that sendChanCap is too small for real
// traffic, so it has to be counted rather than inferred from a log line.
func TestSheddingASlowConsumerIsCounted(t *testing.T) {
	before := testutil.ToFloat64(metrics.ConnectionsShedTotal)

	h := New()
	c := NewConn("slow", "c1")
	h.Add(c, 0, 0)
	// Fill the buffer without draining it, then send one more.
	for i := 0; i < sendChanCap; i++ {
		c.Send <- []byte(`{}`)
	}
	h.Fanout("slow", []byte(`{}`))

	if got := testutil.ToFloat64(metrics.ConnectionsShedTotal) - before; got != 1 {
		t.Errorf("shed counter rose by %v, want 1", got)
	}
	select {
	case <-c.Done:
		// Closed, as it should be.
	default:
		t.Error("a shed connection was counted but not actually closed")
	}
}
