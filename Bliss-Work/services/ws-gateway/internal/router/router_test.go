package router

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/shared-backoff"
	"github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/push"
)

// An event whose routing fails on a transient Redis error must not be treated as
// done. Route used to log those failures and return nothing, so the consumer
// committed the Kafka offset for an event whose outbox write or routing lookup
// had just failed — every recipient lost it (not in replay, never pushed live).

var errRedis = errors.New("redis: connection refused")

const eventJSON = `{"type":"message.created","eventId":"11111111-1111-1111-1111-111111111111",` +
	`"messageId":"22222222-2222-2222-2222-222222222222","recipientId":"bob","senderId":"alice",` +
	`"occurredAt":"2026-10-07T09:00:00Z"}`

// fakeStore fails each call while its fail counter is positive, then succeeds.
type fakeStore struct {
	mu              sync.Mutex
	failOutbox      int
	failNodes       int
	failAddrs       int
	outboxWrites    int
	outboxSucceeded int
	nodesCalls      int
	// missingAddrNode, if set, is omitted from NodeAddrs' result even though it
	// was asked for — simulates a node registration expiring between the
	// presence read (NodesForUsers) and the address lookup moments later.
	missingAddrNode string
}

func (f *fakeStore) AppendOutboxMulti(_ context.Context, _ []string, _ int64, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outboxWrites++
	if f.failOutbox > 0 {
		f.failOutbox--
		return errRedis
	}
	f.outboxSucceeded++
	return nil
}

func (f *fakeStore) NodesForUsers(_ context.Context, users []string) (map[string][]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nodesCalls++
	if f.failNodes > 0 {
		f.failNodes--
		return nil, errRedis
	}
	m := map[string][]string{}
	for _, u := range users {
		m[u] = []string{"node-1"}
	}
	return m, nil
}

func (f *fakeStore) NodeAddrs(_ context.Context, ids []string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAddrs > 0 {
		f.failAddrs--
		return nil, errRedis
	}
	m := map[string]string{}
	for _, id := range ids {
		if id == f.missingAddrNode {
			continue
		}
		m[id] = "http://" + id
	}
	return m, nil
}

func (f *fakeStore) ForgetNodeAddr(string) {}

type fakePusher struct {
	mu     sync.Mutex
	pushes int
}

func (p *fakePusher) Push(_ context.Context, _ string, ds []push.Delivery) (push.Result, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pushes++
	return push.Result{Accepted: len(ds)}, nil
}

func newTestRouter(st *fakeStore, p *fakePusher) *Router {
	return New(st, p, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestRoute_TransientRedisFailureIsReportedNotSwallowed(t *testing.T) {
	cases := map[string]*fakeStore{
		"outbox write":   {failOutbox: 1},
		"routing lookup": {failNodes: 1},
		"node addresses": {failAddrs: 1},
	}
	for name, st := range cases {
		t.Run(name, func(t *testing.T) {
			p := &fakePusher{}
			if err := newTestRouter(st, p).Route(context.Background(), []byte(eventJSON)); err == nil {
				t.Fatal("Route returned nil after a transient failure; the consumer would commit an undelivered event")
			}
		})
	}
}

func TestRoute_OutboxFailureDoesNotPushAhead(t *testing.T) {
	st, p := &fakeStore{failOutbox: 1}, &fakePusher{}
	_ = newTestRouter(st, p).Route(context.Background(), []byte(eventJSON))
	if p.pushes != 0 || st.nodesCalls != 0 {
		t.Errorf("pushed (%d) / routed (%d) an event that is not in the replay outbox", p.pushes, st.nodesCalls)
	}
}

func TestRoute_SuccessAndPermanentSkipsReturnNil(t *testing.T) {
	for name, raw := range map[string]string{
		"delivered":    eventJSON,
		"unparseable":  `{not json`,
		"no recipient": `{"type":"some.internal.event"}`,
	} {
		t.Run(name, func(t *testing.T) {
			st, p := &fakeStore{}, &fakePusher{}
			if err := newTestRouter(st, p).Route(context.Background(), []byte(raw)); err != nil {
				t.Fatalf("Route = %v; a permanent skip or success must let the offset move", err)
			}
			if name == "delivered" && (st.outboxSucceeded != 1 || p.pushes != 1) {
				t.Errorf("outbox writes = %d, pushes = %d; want 1 and 1", st.outboxSucceeded, p.pushes)
			}
		})
	}
}

// A node whose registration expired between the presence read and the address
// lookup must be counted as its own thing (PushNodeExpiredTotal), distinct
// from a push that was actually attempted and failed (PushSentTotal{error}) —
// see D8 in the websocket-engineering audit: before this, both looked
// identical on a dashboard.
func TestRoute_ExpiredNodeAddrCountedSeparatelyFromPushFailure(t *testing.T) {
	before := testutil.ToFloat64(metrics.PushNodeExpiredTotal)
	st, p := &fakeStore{missingAddrNode: "node-1"}, &fakePusher{}
	if err := newTestRouter(st, p).Route(context.Background(), []byte(eventJSON)); err != nil {
		t.Fatalf("Route = %v; a missing node address must not stall the offset", err)
	}
	if p.pushes != 0 {
		t.Errorf("pushes = %d; want 0 — no HTTP push should be attempted for an expired node", p.pushes)
	}
	// eventJSON addresses both its sender and its recipient (see
	// contract.RecipientsOf for message.created), and the fake routing table
	// puts both on the same node — so the one expired-node batch carries 2
	// deliveries, not 1.
	if got := testutil.ToFloat64(metrics.PushNodeExpiredTotal) - before; got != 2 {
		t.Errorf("PushNodeExpiredTotal increased by %v; want 2", got)
	}
}

// ── Consumer loop: the commit must follow successful processing ──────────────

// fakeReader serves a fixed list of messages, then blocks until ctx is done,
// recording every commit.
type fakeReader struct {
	mu      sync.Mutex
	queue   []kafka.Message
	commits []int64
	commit  chan int64
}

func newFakeReader(offsets ...int64) *fakeReader {
	r := &fakeReader{commit: make(chan int64, 16)}
	for _, o := range offsets {
		r.queue = append(r.queue, kafka.Message{Topic: "t", Offset: o, Value: []byte(eventJSON)})
	}
	return r
}

func (r *fakeReader) FetchMessage(ctx context.Context) (kafka.Message, error) {
	r.mu.Lock()
	if len(r.queue) > 0 {
		m := r.queue[0]
		r.queue = r.queue[1:]
		r.mu.Unlock()
		return m, nil
	}
	r.mu.Unlock()
	<-ctx.Done()
	return kafka.Message{}, ctx.Err()
}

func (r *fakeReader) CommitMessages(_ context.Context, msgs ...kafka.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range msgs {
		r.commits = append(r.commits, m.Offset)
		r.commit <- m.Offset
	}
	return nil
}

func (r *fakeReader) Close() error { return nil }

func (r *fakeReader) committed() []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int64(nil), r.commits...)
}

func fastRetries(t *testing.T) {
	t.Helper()
	old := routeRetryPolicy
	routeRetryPolicy = backoff.Policy{Base: time.Millisecond, Max: 5 * time.Millisecond}
	t.Cleanup(func() { routeRetryPolicy = old })
}

func runConsumer(t *testing.T, st *fakeStore, rd *fakeReader) (cancel context.CancelFunc, done chan struct{}) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	c := &Consumer{reader: rd, router: New(st, &fakePusher{}, log), log: log}
	ctx, cancel := context.WithCancel(context.Background())
	done = make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel, done
}

func TestConsumer_RetriesTransientFailureBeforeCommitting(t *testing.T) {
	fastRetries(t)
	// Redis fails the first 3 outbox writes and 2 routing lookups.
	st := &fakeStore{failOutbox: 3, failNodes: 2}
	rd := newFakeReader(41, 42)
	runConsumer(t, st, rd)

	for _, want := range []int64{41, 42} {
		select {
		case got := <-rd.commit:
			if got != want {
				t.Fatalf("committed offset %d, want %d", got, want)
			}
			st.mu.Lock()
			wrote := st.outboxSucceeded
			st.mu.Unlock()
			if want == 41 && wrote < 1 {
				t.Fatal("offset 41 was committed before its event was durably written to the outbox")
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("offset %d never committed after Redis recovered", want)
		}
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	// >= 2, not == 2: a routing-lookup failure retries the whole event, and the
	// outbox write is an idempotent ZADD, so it legitimately happens again.
	if st.outboxSucceeded < 2 {
		t.Errorf("successful outbox writes = %d, want at least one per event", st.outboxSucceeded)
	}
	if st.outboxWrites < 5 {
		t.Errorf("outbox write attempts = %d; the first event should have been retried through 3 failures", st.outboxWrites)
	}
}

func TestConsumer_NeverCommitsAnEventWhileRedisIsDown(t *testing.T) {
	fastRetries(t)
	st := &fakeStore{failOutbox: 1 << 30} // down for the whole test
	rd := newFakeReader(7)
	cancel, done := runConsumer(t, st, rd)

	time.Sleep(150 * time.Millisecond)
	if got := rd.committed(); len(got) != 0 {
		t.Fatalf("committed %v while Redis was failing every write; the event is lost", got)
	}
	st.mu.Lock()
	attempts := st.outboxWrites
	st.mu.Unlock()
	if attempts < 3 {
		t.Errorf("only %d attempts in 150ms; the event is not being retried", attempts)
	}

	// Shutdown must still be prompt, and must not commit the unprocessed event.
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("consumer did not stop on context cancel while retrying")
	}
	if got := rd.committed(); len(got) != 0 {
		t.Fatalf("shutdown committed %v for an unprocessed event", got)
	}
}

func TestConsumer_PermanentlyBadEventDoesNotWedgeThePartition(t *testing.T) {
	fastRetries(t)
	rd := newFakeReader(1)
	rd.queue[0].Value = []byte(`{not json`)
	rd.queue = append(rd.queue, kafka.Message{Topic: "t", Offset: 2, Value: []byte(eventJSON)})
	runConsumer(t, &fakeStore{}, rd)

	for _, want := range []int64{1, 2} {
		select {
		case got := <-rd.commit:
			if got != want {
				t.Fatalf("committed %d, want %d", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("offset %d never committed: a poison message blocked the partition", want)
		}
	}
}
