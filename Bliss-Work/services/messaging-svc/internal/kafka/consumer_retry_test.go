package kafka

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
)

// A failed message must be retried in place, not skipped. Kafka keeps one offset
// per partition, so committing the NEXT message would carry the group past a
// failed one for good — a lost user.created, or an org.deleted that never purges.

func fastBackoff(t *testing.T) {
	t.Helper()
	oldBase, oldMax := handleRetryBackoff, maxHandleBackoff
	handleRetryBackoff, maxHandleBackoff = time.Millisecond, 2*time.Millisecond
	t.Cleanup(func() { handleRetryBackoff, maxHandleBackoff = oldBase, oldMax })
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

var testMsg = kafka.Message{Topic: "auth.events", Partition: 3, Offset: 41}

func TestHandleWithRetry_CommitsAfterASuccessfulFirstAttempt(t *testing.T) {
	fastBackoff(t)
	calls := 0

	ok := handleWithRetry(context.Background(), quietLog(), "test", testMsg, func(context.Context) bool {
		calls++
		return true
	})

	if !ok || calls != 1 {
		t.Fatalf("ok=%v calls=%d, want true after exactly one call", ok, calls)
	}
}

func TestHandleWithRetry_RetriesInPlaceUntilItSucceeds(t *testing.T) {
	fastBackoff(t)
	calls := 0

	ok := handleWithRetry(context.Background(), quietLog(), "test", testMsg, func(context.Context) bool {
		calls++
		return calls == 3 // a transient failure, twice
	})

	if !ok || calls != 3 {
		t.Fatalf("ok=%v calls=%d, want true on the third attempt", ok, calls)
	}
}

// B-MSG-3: the helper used to give up after 8 attempts (~90s at production
// backoff) and report the offset safe to commit, so a database outage longer
// than that turned user.created / user.deactivated / org.deleted into a logged
// skip. A failure the handler calls retryable must be retried for as long as it
// takes, and never committed.
func TestHandleWithRetry_NeverGivesUpOnARetryableFailure(t *testing.T) {
	fastBackoff(t)
	const outage = 200 // far beyond the old 8-attempt cap
	calls := 0

	ok := handleWithRetry(context.Background(), quietLog(), "test", testMsg, func(context.Context) bool {
		calls++
		return calls > outage // the database comes back after `outage` failures
	})

	if !ok || calls != outage+1 {
		t.Fatalf("ok=%v calls=%d, want true on attempt %d: it must keep retrying, not commit past an unprocessed message", ok, calls, outage+1)
	}
}

func TestHandleWithRetry_LeavesTheMessageUncommittedWhenShutdownInterruptsARetry(t *testing.T) {
	fastBackoff(t)
	handleRetryBackoff = time.Hour // the retry pause is where shutdown lands
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0

	done := make(chan bool, 1)
	go func() {
		done <- handleWithRetry(ctx, quietLog(), "test", testMsg, func(context.Context) bool {
			calls++
			cancel() // shutdown begins during the first failed attempt
			return false
		})
	}()

	select {
	case ok := <-done:
		if ok {
			t.Fatal("reported done on shutdown: the offset would be committed past a message that was never handled")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("did not return when the context ended")
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1: no further attempt once shutting down", calls)
	}
}
