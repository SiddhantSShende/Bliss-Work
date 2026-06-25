package signal

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

// NOTE ON COVERAGE LIMITS (no production-code change allowed):
//
// Dispatcher.store is a concrete *store.Store, not an interface, and the
// org-check (IsOnlineInOrg) issues a real Redis SISMEMBER. There is therefore
// NO seam to fake "peer is online in sender's org" vs. "cross-org / offline"
// without refactoring Dispatcher to depend on an interface (e.g.
// `type presenceChecker interface { IsOnlineInOrg(ctx, org, user) (bool, error) }`).
//
// What IS testable DB-free is the failure branch of the org check: a store
// whose Redis is unreachable makes IsOnlineInOrg return an error, and Forward
// must fail closed (return false) — never forwarding a frame when it cannot
// prove the destination is a same-org online peer. The happy path and the
// cross-org-rejected path require the refactor noted above and are skipped.

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// unreachableStore returns a Store whose Redis dials a closed local port, with
// tight timeouts so calls fail fast instead of hanging the test.
func unreachableStore(t *testing.T) *store.Store {
	t.Helper()
	// dial_timeout/read_timeout query params are honored by redis.ParseURL.
	st, err := store.New("redis://127.0.0.1:1/0?dial_timeout=200ms&read_timeout=200ms")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	return st
}

func TestForward_FailsClosedWhenOrgCheckErrors(t *testing.T) {
	h := hub.New()
	d := New(h, unreachableStore(t), discardLog())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	delivered := d.Forward(ctx, "org-1", "u-from", "u-to", Frame{Type: "rtc.offer", OfferID: "o1"})
	if delivered {
		t.Fatal("Forward must return false (fail closed) when the org check errors")
	}
}

// TestForward_DoesNotFanoutOnOrgCheckError proves that when the org check
// cannot be satisfied, no frame is enqueued onto a locally-connected target —
// i.e. the same-org gate runs BEFORE any delivery, so a cross-org peer that
// merely happens to share this node still receives nothing.
func TestForward_DoesNotFanoutOnOrgCheckError(t *testing.T) {
	h := hub.New()
	target := hub.NewConn("u-to", "c-to")
	if !h.Add(target, 0, 0) {
		t.Fatal("failed to register target conn")
	}
	d := New(h, unreachableStore(t), discardLog())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	delivered := d.Forward(ctx, "org-1", "u-from", "u-to", Frame{Type: "rtc.ice", Candidate: "cand"})
	if delivered {
		t.Fatal("Forward returned true despite an org-check error")
	}
	select {
	case raw := <-target.Send:
		t.Fatalf("frame leaked to target before org check passed: %s", raw)
	default:
		// expected: nothing enqueued
	}
}
