package delivery

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func testDispatcher(url string) *Dispatcher {
	return New(url, "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
}

type recorder struct {
	mu       sync.Mutex
	requests []ackBody
}

func (r *recorder) handler(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body ackBody
		_ = json.NewDecoder(req.Body).Decode(&body)
		r.mu.Lock()
		r.requests = append(r.requests, body)
		r.mu.Unlock()
		w.WriteHeader(status)
	}
}

// B-WS-2: a garbage id must never reach messaging-svc, which would 400 the
// whole batch and fail every valid ack batched with it.
func TestAckDropsNonUUIDIds(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(http.StatusNoContent))
	defer srv.Close()
	d := testDispatcher(srv.URL)

	user := uuid.NewString()
	good := uuid.NewString()
	d.Ack(user, good)
	d.Ack(user, "not-a-uuid")
	d.Ack(user, "")
	d.Ack("not-a-user", uuid.NewString())
	d.flushAll(context.Background())

	if len(rec.requests) != 1 {
		t.Fatalf("want 1 request, got %d", len(rec.requests))
	}
	got := rec.requests[0]
	if got.RecipientID != user || len(got.MessageIDs) != 1 || got.MessageIDs[0] != good {
		t.Fatalf("unexpected body: %+v", got)
	}
}

// B-WS-2: a request messaging-svc rejects with 4xx (not 429) says nothing about
// its health and must not trip the breaker.
func TestNonRetryable4xxDoesNotOpenBreaker(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusBadRequest)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(status.Load()))
	}))
	defer srv.Close()
	d := testDispatcher(srv.URL)

	for i := 0; i < cbThreshold*2; i++ {
		d.Ack(uuid.NewString(), uuid.NewString())
		d.flushAll(context.Background())
	}
	if d.breakerOpen() {
		t.Fatal("breaker opened on non-retryable 4xx responses")
	}

	// And a later healthy ack still goes out.
	status.Store(http.StatusNoContent)
	rec := &recorder{}
	srv2 := httptest.NewServer(rec.handler(http.StatusNoContent))
	defer srv2.Close()
	d.baseURL = srv2.URL
	d.Ack(uuid.NewString(), uuid.NewString())
	d.flushAll(context.Background())
	if len(rec.requests) != 1 {
		t.Fatalf("ack after 4xx burst not delivered, got %d requests", len(rec.requests))
	}
}

// Over-correction guard: a genuinely failing service (5xx) still opens it.
func TestRetryable5xxStillOpensBreaker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	d := testDispatcher(srv.URL)
	for i := 0; i < cbThreshold; i++ {
		d.Ack(uuid.NewString(), uuid.NewString())
		d.flushAll(context.Background())
	}
	if !d.breakerOpen() {
		t.Fatal("breaker should open after repeated 5xx")
	}
}

// B-WS-3: messaging-svc truncates a request to 256 ids and answers 204, so the
// gateway must chunk instead of losing the tail.
func TestSendChunksLargeBatches(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(http.StatusNoContent))
	defer srv.Close()
	d := testDispatcher(srv.URL)

	user := uuid.NewString()
	want := map[string]bool{}
	for i := 0; i < 600; i++ {
		id := uuid.NewString()
		want[id] = true
		d.Ack(user, id)
	}
	d.flushAll(context.Background())

	if len(rec.requests) != 3 {
		t.Fatalf("want 3 chunked requests, got %d", len(rec.requests))
	}
	got := map[string]bool{}
	for _, r := range rec.requests {
		if len(r.MessageIDs) > maxIDsPerPost {
			t.Fatalf("chunk of %d exceeds %d", len(r.MessageIDs), maxIDsPerPost)
		}
		for _, id := range r.MessageIDs {
			got[id] = true
		}
	}
	if len(got) != len(want) {
		t.Fatalf("delivered %d of %d ids", len(got), len(want))
	}
}

// B-WS-2: flushDue must not send recipients one after another, and must bound
// the parallelism.
func TestFlushDueIsConcurrentAndBounded(t *testing.T) {
	var cur, peak atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
		cur.Add(-1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	d := testDispatcher(srv.URL)

	const recipients = 4 * maxParallelFlushes
	for i := 0; i < recipients; i++ {
		d.Ack(uuid.NewString(), uuid.NewString())
	}
	d.mu.Lock()
	for _, b := range d.pending {
		b.first = time.Now().Add(-time.Second)
	}
	d.mu.Unlock()

	start := time.Now()
	d.flushDue(context.Background())
	elapsed := time.Since(start)

	// Serial would take recipients*200ms = 6.4s; 4 waves of 200ms is ~0.8s.
	if elapsed > 2*time.Second {
		t.Fatalf("flushDue looks serial: %v", elapsed)
	}
	if p := peak.Load(); p > maxParallelFlushes || p < 2 {
		t.Fatalf("peak concurrency %d, want 2..%d", p, maxParallelFlushes)
	}
	d.mu.Lock()
	left := len(d.pending)
	d.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d batches left pending", left)
	}
}
