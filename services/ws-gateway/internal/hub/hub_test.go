package hub

import (
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
