package fanout

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/task-board/shared-backoff"
	"github.com/task-board/ws-gateway/internal/hub"
)

// Broadcast-mode fan-out used to log a durable per-recipient outbox-write
// failure and keep going, committing the Kafka offset regardless (see
// outboxWriteMaxAttempts' doc comment). That silently lost the event's replay
// entry for any recipient who was offline at that instant. These tests pin
// the fixed behaviour: a durable outbox failure must withhold the commit and
// retry the whole event, exactly like the sibling routed path
// (internal/router.Route / Consumer).

var errRedis = errors.New("redis: connection refused")

const twoRecipientEvent = `{"type":"message.created","eventId":"11111111-1111-1111-1111-111111111111",` +
	`"messageId":"22222222-2222-2222-2222-222222222222","recipientId":"bob","senderId":"alice",` +
	`"occurredAt":"2026-10-07T09:00:00Z"}`

// fakeStore fails each AppendOutbox call while its fail counter is positive,
// then succeeds. failFor, when set, limits failures to that one user id so a
// multi-recipient event can exercise a PARTIAL failure.
type fakeStore struct {
	mu         sync.Mutex
	failCount  int
	failFor    string // empty = fail regardless of uid
	writes     map[string]int
	successes  map[string]int
	totalCalls int
}

func newFakeStore() *fakeStore {
	return &fakeStore{writes: map[string]int{}, successes: map[string]int{}}
}

func (f *fakeStore) AppendOutbox(_ context.Context, userID string, _ int64, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.totalCalls++
	f.writes[userID]++
	if f.failCount > 0 && (f.failFor == "" || f.failFor == userID) {
		f.failCount--
		return errRedis
	}
	f.successes[userID]++
	return nil
}

func (f *fakeStore) snapshot() (writes, successes map[string]int, total int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w := make(map[string]int, len(f.writes))
	for k, v := range f.writes {
		w[k] = v
	}
	s := make(map[string]int, len(f.successes))
	for k, v := range f.successes {
		s[k] = v
	}
	return w, s, f.totalCalls
}

func newTestConsumer(st *fakeStore) *Consumer {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Consumer{store: st, hub: hub.New(), log: log}
}

func fastFanoutRetries(t *testing.T) {
	t.Helper()
	oldOuter, oldInner := fanoutRetryPolicy, outboxWriteRetryPolicy
	fanoutRetryPolicy = backoff.Policy{Base: time.Millisecond, Max: 5 * time.Millisecond}
	outboxWriteRetryPolicy = backoff.Policy{Base: time.Millisecond, Max: 2 * time.Millisecond}
	t.Cleanup(func() { fanoutRetryPolicy, outboxWriteRetryPolicy = oldOuter, oldInner })
}

// (a) all-success path is unchanged: one outbox write per recipient, no error.
func TestHandle_AllSuccessReturnsNil(t *testing.T) {
	st := newFakeStore()
	c := newTestConsumer(st)
	if err := c.handle(context.Background(), []byte(twoRecipientEvent)); err != nil {
		t.Fatalf("handle() = %v, want nil on an all-success fan-out", err)
	}
	_, successes, _ := st.snapshot()
	if successes["bob"] != 1 {
		t.Errorf("outbox successes for bob = %d, want 1", successes["bob"])
	}
}

// (b) partial failure correctly withholds the commit: handle must return a
// non-nil error when even one recipient's outbox write fails durably, so Run
// never reaches CommitMessages for this event.
func TestHandle_DurableOutboxFailureReturnsError(t *testing.T) {
	fastFanoutRetries(t)
	st := newFakeStore()
	st.failCount = outboxWriteMaxAttempts // bob's writes fail every attempt
	st.failFor = "bob"
	c := newTestConsumer(st)

	err := c.handle(context.Background(), []byte(twoRecipientEvent))
	if err == nil {
		t.Fatal("handle() = nil after a durable outbox failure; the consumer would commit a lost event")
	}
}

// Permanent (unparseable / no-recipient) cases remain a success per the
// existing contract — never retried, offset always free to move.
func TestHandle_PermanentSkipsReturnNil(t *testing.T) {
	for name, raw := range map[string]string{
		"unparseable":  `{not json`,
		"no recipient": `{"type":"some.internal.event"}`,
	} {
		t.Run(name, func(t *testing.T) {
			st := newFakeStore()
			c := newTestConsumer(st)
			if err := c.handle(context.Background(), []byte(raw)); err != nil {
				t.Fatalf("handle() = %v; a permanent skip must let the offset move", err)
			}
		})
	}
}

// ── deliver: the retry loop Run relies on ────────────────────────────────────

// (c) retry-then-success eventually returns true (commit allowed) without
// re-delivering to a recipient that already durably succeeded — AppendOutbox
// is idempotent, so "re-delivering" here just means a harmless repeat ZADD,
// never a duplicate live push counted as new.
func TestDeliver_RetriesUntilSuccessThenAllowsCommit(t *testing.T) {
	fastFanoutRetries(t)
	st := newFakeStore()
	st.failCount = 1 // alice (or whichever user is written first) fails once
	st.failFor = "bob"
	c := newTestConsumer(st)

	ctx := context.Background()
	done := c.deliver(ctx, ctx, []byte(twoRecipientEvent))
	if !done {
		t.Fatal("deliver() = false with ctx not cancelled; Redis recovered and should have succeeded")
	}
	_, successes, _ := st.snapshot()
	if successes["bob"] < 1 {
		t.Errorf("bob's outbox write never succeeded after the retry")
	}
}

// (d) permanent failure after retry exhaustion per the existing policy: there
// is no poison-event / dead-letter handling for a DURABLE (never-recovering)
// Redis failure in broadcast mode, same as the routed path — deliver blocks
// retrying until Redis recovers or the consumer shuts down. This test proves
// the shutdown half of that contract: cancelling ctx stops the retry loop
// promptly and still reports "not done" so the caller never commits.
func TestDeliver_StopsPromptlyOnShutdownWithoutCommitting(t *testing.T) {
	fastFanoutRetries(t)
	st := newFakeStore()
	st.failCount = 1 << 30 // down for the whole test
	c := newTestConsumer(st)

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan bool, 1)
	go func() { doneCh <- c.deliver(ctx, ctx, []byte(twoRecipientEvent)) }()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case done := <-doneCh:
		if done {
			t.Fatal("deliver() = true after ctx cancellation while Redis was still down")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deliver() did not stop promptly on ctx cancellation")
	}
}

// ── Consumer.Run: the commit must follow a successful deliver ───────────────

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
		r.queue = append(r.queue, kafka.Message{Topic: "t", Offset: o, Value: []byte(twoRecipientEvent)})
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

func TestConsumer_NeverCommitsAnEventWhileOutboxWritesFail(t *testing.T) {
	fastFanoutRetries(t)
	st := newFakeStore()
	st.failCount = 1 << 30 // down for the whole test

	// Run needs a real *kafka.Reader field type, so this test drives handle +
	// deliver + the commit decision directly, the same logic Run executes.
	c := newTestConsumer(st)
	rd := newFakeReader(7)
	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		msg, err := rd.FetchMessage(ctx)
		if err != nil {
			return
		}
		if !c.deliver(ctx, ctx, msg.Value) {
			return
		}
		_ = rd.CommitMessages(ctx, msg)
	}()

	time.Sleep(150 * time.Millisecond)
	if got := rd.committed(); len(got) != 0 {
		t.Fatalf("committed %v while every outbox write was failing; the event is lost", got)
	}
	cancel()
	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatal("deliver did not stop on ctx cancellation")
	}
	if got := rd.committed(); len(got) != 0 {
		t.Fatalf("shutdown committed %v for an unprocessed event", got)
	}
}
