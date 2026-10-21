package store

// Batch 6: a reconnecting client whose backlog since its cursor exceeds
// maxReplayHard used to get an identical replay.done regardless of whether
// the batch it just received was the full backlog or only the newest slice
// of it — the client's cursor then advances past the gap believing it is
// caught up, which is silent, permanent loss for anything older than the
// cap. Replay's new `truncated` return value is the fix's server-side half;
// internal/server/conn.go's onHello forwards it as `replay.done.truncated`.
// Real Redis; opt in with WS_GATEWAY_TEST_REDIS_URL (the tests skip when it
// is unreachable) — same convention as presence_ttl_test.go.

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestReplay_SignalsTruncationWhenBacklogExceedsCap(t *testing.T) {
	st := testStore(t)
	ctx := context.Background()
	userID := fmt.Sprintf("user-replay-trunc-%d", time.Now().UnixNano())

	// Seed more events than maxReplayHard so a cursor at the very start of
	// the key sees a backlog bigger than the cap.
	const total = maxReplayHard + 25
	for i := 0; i < total; i++ {
		if err := st.AppendOutbox(ctx, userID, int64(1000+i), []byte(fmt.Sprintf(`{"n":%d}`, i))); err != nil {
			t.Fatalf("AppendOutbox(%d): %v", i, err)
		}
	}

	// Cursor at the very first event's score: everything is "since" this
	// cursor (inclusive lower bound), so the backlog is the full `total`,
	// well over the cap.
	events, truncated, err := st.Replay(ctx, userID, 1000)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if !truncated {
		t.Fatal("Replay reported truncated=false for a backlog larger than maxReplayHard; a client would advance its cursor past missed events with no signal")
	}
	if len(events) != maxReplayHard {
		t.Fatalf("Replay returned %d events, want exactly maxReplayHard=%d", len(events), maxReplayHard)
	}

	// Sanity: a cursor that is NOT behind the cap is correctly reported as
	// complete, so the new check doesn't false-positive on the common case.
	events2, truncated2, err := st.Replay(ctx, userID, int64(1000+total-3))
	if err != nil {
		t.Fatalf("Replay (near head): %v", err)
	}
	if truncated2 {
		t.Fatal("Replay reported truncated=true for a backlog smaller than maxReplayHard")
	}
	if len(events2) != 3 {
		t.Fatalf("Replay (near head) returned %d events, want 3", len(events2))
	}

	// Fresh-client replay (no cursor) must never report truncated — there is
	// no prior cursor to measure a gap against, so "most recent N, capped by
	// whatever the key actually retains" is the intended, complete behavior
	// for that path, never a signal of missed events.
	events3, truncated3, err := st.Replay(ctx, userID, 0)
	if err != nil {
		t.Fatalf("Replay (fresh client): %v", err)
	}
	if truncated3 {
		t.Fatal("Replay reported truncated=true for a cursorless (fresh-client) call; that path has no gap to signal")
	}
	// AppendOutbox trims each key to maxReplayHard members on every write
	// (see outbox.go), so even though `total` events were appended, at most
	// maxReplayHard survive to be read back — maxReplayDefault only binds
	// when the key actually holds that many, which a trimmed key never does.
	if len(events3) != maxReplayHard {
		t.Fatalf("Replay (fresh client) returned %d events, want maxReplayHard=%d (the key's hard cap)", len(events3), maxReplayHard)
	}
}

// Batch 8: maxReplayDefault used to be 200, above maxReplayHard (100) — dead
// configuration, since AppendOutbox/AppendOutboxMulti's unconditional
// write-time trim meant a key could never hold more than maxReplayHard
// members for the cursorless read to draw from. Lowered to match
// maxReplayHard exactly (see outbox.go's doc comment and
// batch-7-replay-capacity-decision.md / batch-8-replay-default-alignment.md).
// This test pins both: the constants agree, and a cursorless replay request
// against a backlog larger than either cap returns at most maxReplayDefault
// (== maxReplayHard == 100) entries.
func TestReplay_CursorlessDefaultMatchesHardCap(t *testing.T) {
	if maxReplayDefault != maxReplayHard {
		t.Fatalf("maxReplayDefault=%d and maxReplayHard=%d have diverged; the read-time ceiling can never usefully exceed the write-time hard cap", maxReplayDefault, maxReplayHard)
	}

	st := testStore(t)
	ctx := context.Background()
	userID := fmt.Sprintf("user-replay-default-%d", time.Now().UnixNano())

	const total = maxReplayDefault + 25
	for i := 0; i < total; i++ {
		if err := st.AppendOutbox(ctx, userID, int64(2000+i), []byte(fmt.Sprintf(`{"n":%d}`, i))); err != nil {
			t.Fatalf("AppendOutbox(%d): %v", i, err)
		}
	}

	events, truncated, err := st.Replay(ctx, userID, 0)
	if err != nil {
		t.Fatalf("Replay (fresh client): %v", err)
	}
	if truncated {
		t.Fatal("Replay reported truncated=true for a cursorless call; fresh-client replay never signals truncation")
	}
	if len(events) > maxReplayDefault {
		t.Fatalf("Replay (fresh client) returned %d events, want at most maxReplayDefault=%d", len(events), maxReplayDefault)
	}
	if len(events) != maxReplayHard {
		t.Fatalf("Replay (fresh client) returned %d events, want exactly maxReplayHard=%d (the key's hard cap, now equal to maxReplayDefault)", len(events), maxReplayHard)
	}
}
