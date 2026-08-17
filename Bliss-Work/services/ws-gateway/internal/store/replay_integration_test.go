package store

import (
	"context"
	"fmt"
	"testing"
)

// Replay against a REAL Redis.
//
// The bug these exist for was invisible to every other kind of test. The replay
// cursor is `occurredAt` in MILLISECONDS on both sides — the gateway scores the
// outbox with it, and the client's high-water mark is `Date.parse(occurredAt)`,
// which carries no finer precision. So the cursor cannot separate two events
// that share a millisecond, and the lower bound decided what happened to the
// second one: exclusive dropped it permanently, inclusive re-sends it and lets
// the client's eventId dedup absorb it.
//
// Only Redis can answer this. The semantics under test are ZRANGEBYSCORE's
// treatment of `(min` versus `min` against equal scores, and a fake would encode
// the assumption rather than check it — which is precisely how the original
// behaviour survived review.
//
// Set REDIS_TEST_URL to run (see presence_integration_test.go).

func cleanupOutbox(t *testing.T, s *Store, userIDs ...string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		keys := make([]string, 0, len(userIDs))
		for _, u := range userIDs {
			keys = append(keys, s.outboxKey(u))
		}
		_ = s.rdb.Del(ctx, keys...).Err()
	})
}

// TestIntegrationReplayDoesNotDropSameMillisecondEvents is the regression.
//
// Two events at the SAME millisecond, a client that saw the first and
// disconnected before the second. With an exclusive bound the second is gone
// forever — no error, no retry, no metric; the user just never receives a
// message. This asserts it comes back.
func TestIntegrationReplayDoesNotDropSameMillisecondEvents(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	user := "user-replay-same-ms"
	cleanupOutbox(t, s, user)

	const at = int64(1_700_000_000_000)
	// A channel message and the notification it produced: different events,
	// same producer timestamp. This is the ordinary case, not a contrived one.
	first := []byte(`{"eventId":"evt-1","type":"channel.message.created"}`)
	second := []byte(`{"eventId":"evt-2","type":"notification.created"}`)

	if err := s.AppendOutbox(ctx, user, at, first); err != nil {
		t.Fatalf("AppendOutbox first: %v", err)
	}
	if err := s.AppendOutbox(ctx, user, at, second); err != nil {
		t.Fatalf("AppendOutbox second: %v", err)
	}

	// The client received `first`, advanced its cursor to that millisecond, and
	// the socket dropped before `second` arrived.
	out, err := s.Replay(ctx, user, at)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}

	got := map[string]bool{}
	for _, raw := range out {
		got[string(raw)] = true
	}
	if !got[string(second)] {
		t.Fatalf("the second event at the same millisecond was NOT replayed "+
			"(got %d entries: %q) — this is silent, permanent message loss",
			len(out), out)
	}
	// The first coming back too is the accepted cost: the client dedupes on
	// eventId, and a duplicate is cheap where a missing message is not.
}

// TestIntegrationReplayExcludesOlderEvents guards the other direction — an
// inclusive bound must not turn into "replay everything", which would make each
// reconnect re-deliver the whole buffer.
func TestIntegrationReplayExcludesOlderEvents(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	user := "user-replay-cursor"
	cleanupOutbox(t, s, user)

	const base = int64(1_700_000_000_000)
	for i := 0; i < 5; i++ {
		raw := []byte(fmt.Sprintf(`{"eventId":"evt-%d"}`, i))
		if err := s.AppendOutbox(ctx, user, base+int64(i)*1000, raw); err != nil {
			t.Fatalf("AppendOutbox %d: %v", i, err)
		}
	}

	// Cursor at the third event: expect that one (inclusive) plus the two after.
	out, err := s.Replay(ctx, user, base+2000)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(out) != 3 {
		t.Fatalf("Replay returned %d entries (%q), want 3 — the cursor must "+
			"still bound the batch, or every reconnect re-sends the buffer",
			len(out), out)
	}
	// Oldest-first, so the client applies them in the order they happened.
	if string(out[0]) != `{"eventId":"evt-2"}` {
		t.Errorf("first replayed entry = %s, want evt-2 (oldest-first)", out[0])
	}
}

// TestIntegrationReplayFromZeroReturnsRecentTail covers the cold-start path: a
// client with no cursor gets a bounded tail rather than everything retained.
func TestIntegrationReplayFromZeroReturnsRecentTail(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	user := "user-replay-cold"
	cleanupOutbox(t, s, user)

	const base = int64(1_700_000_000_000)
	total := maxReplayDefault + 25
	for i := 0; i < total; i++ {
		raw := []byte(fmt.Sprintf(`{"eventId":"cold-%d"}`, i))
		if err := s.AppendOutbox(ctx, user, base+int64(i), raw); err != nil {
			t.Fatalf("AppendOutbox %d: %v", i, err)
		}
	}

	out, err := s.Replay(ctx, user, 0)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(out) != maxReplayDefault {
		t.Fatalf("cold replay returned %d entries, want the %d most recent",
			len(out), maxReplayDefault)
	}
	if string(out[len(out)-1]) != fmt.Sprintf(`{"eventId":"cold-%d"}`, total-1) {
		t.Errorf("last entry = %s, want the newest event", out[len(out)-1])
	}
}
