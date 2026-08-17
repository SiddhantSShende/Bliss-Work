package hub

import (
	"runtime"
	"strconv"
	"testing"
)

func TestAddRespectsTotalCap(t *testing.T) {
	h := New()
	if !h.Add(NewConn("u1", "c1"), 2, 0) {
		t.Fatal("first add should succeed")
	}
	if !h.Add(NewConn("u2", "c2"), 2, 0) {
		t.Fatal("second add should succeed")
	}
	if h.Add(NewConn("u3", "c3"), 2, 0) {
		t.Fatal("third add should be rejected by total cap")
	}
	if got := h.Count(); got != 2 {
		t.Fatalf("Count()=%d, want 2", got)
	}
}

func TestAddRespectsPerUserCap(t *testing.T) {
	h := New()
	if !h.Add(NewConn("u1", "c1"), 0, 2) {
		t.Fatal("u1/c1 should add")
	}
	if !h.Add(NewConn("u1", "c2"), 0, 2) {
		t.Fatal("u1/c2 should add")
	}
	if h.Add(NewConn("u1", "c3"), 0, 2) {
		t.Fatal("u1/c3 should be rejected by per-user cap")
	}
	// A different user is unaffected by another user's per-user cap.
	if !h.Add(NewConn("u2", "c1"), 0, 2) {
		t.Fatal("u2/c1 should add")
	}
}

func TestAddUnlimitedWhenCapZero(t *testing.T) {
	h := New()
	for i := 0; i < 100; i++ {
		if !h.Add(NewConn("u", strconv.Itoa(i)), 0, 0) {
			t.Fatalf("add %d should succeed with no caps", i)
		}
	}
	if got := h.Count(); got != 100 {
		t.Fatalf("Count()=%d, want 100", got)
	}
}

func TestRemoveDecrementsCountAndNoUnderflow(t *testing.T) {
	h := New()
	c := NewConn("u1", "c1")
	h.Add(c, 0, 0)
	h.Add(NewConn("u1", "c2"), 0, 0)
	h.Remove(c)
	if got := h.Count(); got != 1 {
		t.Fatalf("Count()=%d, want 1", got)
	}
	// Removing a connection that was never registered must not underflow.
	h.Remove(NewConn("u1", "ghost"))
	if got := h.Count(); got != 1 {
		t.Fatalf("Count()=%d after ghost remove, want 1", got)
	}
}

func TestFanoutClosesSlowConsumer(t *testing.T) {
	h := New()
	c := NewConn("u1", "c1")
	h.Add(c, 0, 0)
	// Fill the send buffer completely so the next enqueue can't proceed.
	for i := 0; i < sendChanCap; i++ {
		c.Send <- []byte("x")
	}
	h.Fanout("u1", []byte("overflow"))
	select {
	case <-c.Done:
		// Closed as expected — a slow consumer is dropped, not allowed to block.
	default:
		t.Fatal("expected the slow consumer to be closed (Done not signalled)")
	}
}

func TestCloseAllSignalsEveryConn(t *testing.T) {
	h := New()
	c1 := NewConn("u1", "c1")
	c2 := NewConn("u2", "c2")
	h.Add(c1, 0, 0)
	h.Add(c2, 0, 0)
	h.CloseAll()
	for _, c := range []*Conn{c1, c2} {
		select {
		case <-c.Done:
		default:
			t.Fatalf("conn %s/%s was not closed by CloseAll", c.UserID, c.ConnID)
		}
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	c := NewConn("u1", "c1")
	c.Close()
	c.Close() // must not panic on double-close
	select {
	case <-c.Done:
	default:
		t.Fatal("Done should be closed after Close()")
	}
}

// A connection's memory cost is a capacity decision, not an implementation
// detail, so it is asserted rather than assumed.
//
// WS_MAX_CONNECTIONS is a memory budget expressed as a socket count, and the
// deployment memory limits are sized from the number below (see the comment on
// sendChanCap, values.yaml and docker-compose.prod.yml). Raising sendChanCap
// silently re-prices every socket: at 512 a connection cost 12 KB of eagerly
// allocated channel ring before a single event arrived, the pod ran out of
// memory near 13k sockets against a 50,000 cap, and the cap therefore never
// fired — the kernel killed the process instead of the gateway refusing the
// connection.
//
// The bound here is deliberately loose. It is not measuring an exact figure, it
// is catching a change of ORDER — which is what a jump back to 512 would be.
func TestConnectionMemoryCostStaysWithinTheDeploymentBudget(t *testing.T) {
	const (
		sample     = 20_000
		maxPerConn = 4096 // bytes; ~2.5× the expected ~1.6 KB
	)

	// Settle the heap before measuring so unrelated allocation from earlier
	// tests is not attributed to the connections below.
	conns := make([]*Conn, 0, sample)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)

	for i := 0; i < sample; i++ {
		conns = append(conns, NewConn("u", "c"))
	}

	runtime.ReadMemStats(&after)
	// Keep conns reachable across the measurement; without this the compiler
	// and GC are both free to reclaim them before ReadMemStats runs.
	runtime.KeepAlive(conns)

	grew := after.HeapAlloc - before.HeapAlloc
	perConn := grew / sample
	if perConn > maxPerConn {
		t.Fatalf("a connection now costs ~%d bytes (%d for %d conns), over the %d-byte budget.\n\n"+
			"This is what the deployment memory limits are sized from. If the increase is "+
			"intended, raise ws-gateway's memory limit in deploy/helm/taskboard/values.yaml AND "+
			"docker-compose.prod.yml in the same change, or WS_MAX_CONNECTIONS becomes a cap the "+
			"pod is OOM-killed before it can reach.",
			perConn, grew, sample, maxPerConn)
	}
	t.Logf("per-connection heap: ~%d bytes (sendChanCap=%d)", perConn, sendChanCap)
}
