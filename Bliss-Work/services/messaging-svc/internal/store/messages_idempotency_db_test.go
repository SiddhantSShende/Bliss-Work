package store

// appendMessage's idempotency contract, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// Both bugs this file exists to catch depended on real transaction timing: a
// reply's pre-check matching an unrelated message in a DIFFERENT thread only
// shows up once there IS a second thread and a second message row to
// mismatch against, and the concurrent-duplicate top-level bug is invisible
// unless two real transactions genuinely overlap against a real row lock —
// exactly the same reasoning as mail_race_db_test.go's header, whose
// waitForBlockedQuery helper this file reuses.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func seedMessageUsers(t *testing.T, s *Store, orgID string) (alice, bob string) {
	t.Helper()
	alice, bob = uuid.Must(uuid.NewV7()).String(), uuid.Must(uuid.NewV7()).String()
	// SendMessage refuses a recipient with no user_projection row in the org.
	seedUser(t, s, orgID, alice, "alice", "Alice")
	seedUser(t, s, orgID, bob, "bob", "Bob")
	return alice, bob
}

// ── The bug: a reply's pre-check must not match an unrelated message that
// happens to share (conversation, sender, clientMsgId) in a DIFFERENT thread ─
func TestAppendMessage_ReplyIdempotency_DoesNotCrossThreads(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	rootA, err := s.SendMessage(ctx, orgID, alice, bob, "root A", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send root A: %v", err)
	}
	rootB, err := s.SendMessage(ctx, orgID, alice, bob, "root B", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send root B: %v", err)
	}
	if rootA.ThreadID == rootB.ThreadID {
		t.Fatalf("two separate SendMessage calls landed in the same thread: %s", rootA.ThreadID)
	}

	sharedClientID := uuid.Must(uuid.NewV7()).String()
	replyA, err := s.ReplyToThread(ctx, orgID, alice, rootA.ThreadID, rootA.MessageID, "reply in A", sharedClientID, "")
	if err != nil {
		t.Fatalf("reply in thread A: %v", err)
	}
	replyB, err := s.ReplyToThread(ctx, orgID, alice, rootB.ThreadID, rootB.MessageID, "reply in B", sharedClientID, "")
	if err != nil {
		t.Fatalf("reply in thread B: %v", err)
	}

	if replyB.ThreadID != rootB.ThreadID {
		t.Errorf("reply to thread B's ThreadID = %s, want %s — the same-clientMsgId reply to thread A was returned instead",
			replyB.ThreadID, rootB.ThreadID)
	}
	if replyA.MessageID == replyB.MessageID {
		t.Errorf("both replies report the same MessageID (%s) — thread B's reply was silently swallowed by thread A's",
			replyA.MessageID)
	}

	var countB int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE thread_id = $1`, rootB.ThreadID).Scan(&countB)
	}); err != nil {
		t.Fatalf("count thread B messages: %v", err)
	}
	if countB != 2 {
		t.Errorf("thread B has %d messages, want 2 (root + reply) — the reply body was never actually inserted", countB)
	}
}

// ── The bug: two concurrent top-level sends with the same clientMsgId must
// create exactly one thread and one message, not two ────────────────────────
func TestSendMessage_ConcurrentTopLevelDuplicate_CreatesExactlyOneThread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	// Establish the conversation first — unrelated to the race under test.
	seed, err := s.SendMessage(ctx, orgID, alice, bob, "seed", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("seed message: %v", err)
	}
	convID := seed.ConversationID
	dupClientID := uuid.Must(uuid.NewV7()).String()

	// Goroutine 1: replicates SendMessage's own tx setup far enough to take
	// lockConversationForRootSend's lock, then holds it open.
	lockHeld := make(chan struct{})
	proceed := make(chan struct{})
	type outcome struct {
		res *SendResult
		err error
	}
	firstDone := make(chan outcome, 1)
	go func() {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			firstDone <- outcome{nil, err}
			return
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			firstDone <- outcome{nil, err}
			return
		}
		if err := lockConversationForRootSend(ctx, tx, convID, orgID); err != nil {
			firstDone <- outcome{nil, err}
			return
		}
		close(lockHeld)
		<-proceed
		// appendMessage owns the commit itself (both on the early-return
		// "already exists" path and here) — the deferred Rollback above is
		// just the standard safety net and no-ops once that commit lands.
		res, err := s.appendMessage(ctx, tx, orgID, convID, alice, bob, "first", dupClientID, "", "", appendOpts{})
		firstDone <- outcome{res, err}
	}()
	<-lockHeld

	// Goroutine 2: the real SendMessage, racing the still-open first send.
	// Blocks on the SAME conversations row — either at its own conflicting
	// upsert or (once past that) at appendMessage's lock — so "any backend
	// waiting on a lock" is unambiguous here with only one other statement in
	// flight.
	secondDone := make(chan outcome, 1)
	go func() {
		res, err := s.SendMessage(ctx, orgID, alice, bob, "second", dupClientID, SendOptions{})
		secondDone <- outcome{res, err}
	}()

	waitForBlockedQuery(t, s, "%", proceed)

	first := <-firstDone
	if first.err != nil {
		t.Fatalf("first (held) send: %v", first.err)
	}
	second := <-secondDone
	if second.err != nil {
		t.Fatalf("second (blocked) send: %v", second.err)
	}

	if first.res.ThreadID != second.res.ThreadID {
		t.Errorf("concurrent same-clientMsgId sends created two threads: %s vs %s",
			first.res.ThreadID, second.res.ThreadID)
	}
	if first.res.MessageID != second.res.MessageID {
		t.Errorf("concurrent same-clientMsgId sends created two messages: %s vs %s",
			first.res.MessageID, second.res.MessageID)
	}

	var threadCount int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM threads WHERE conversation_id = $1 AND root_message_id = $2`,
			convID, first.res.MessageID).Scan(&threadCount)
	}); err != nil {
		t.Fatalf("count threads: %v", err)
	}
	if threadCount != 1 {
		t.Errorf("threads rooted at message %s = %d, want exactly 1", first.res.MessageID, threadCount)
	}
}
