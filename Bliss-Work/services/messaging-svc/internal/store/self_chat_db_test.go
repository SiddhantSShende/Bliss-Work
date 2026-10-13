package store

// Notes-to-Self: OpenSelfChat, sending into it via the ordinary Reply path,
// and ShareTaskToSelfChat — against a real Postgres with RLS enforcing.
//
// ── Why this needs a database ────────────────────────────────────────────────
// OpenSelfChat's whole point is the ON CONFLICT (org_id, user_low, user_high)
// upsert resolving concurrent callers to the SAME row — exactly the race
// OpenConversation already relies on a real unique index for. A fake pgx.Tx
// would prove the SQL parses, not that two concurrent opens never produce two
// rows.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it, e.g.:
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run TestSelfChat -v
//	MESSAGING_TEST_DATABASE_URL='...' go test ./internal/store/ -run TestOpenSelfChat -v

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOpenSelfChat_IdempotentAndConcurrent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")

	id1, err := s.OpenSelfChat(ctx, orgID, caller)
	if err != nil {
		t.Fatalf("OpenSelfChat: %v", err)
	}
	id2, err := s.OpenSelfChat(ctx, orgID, caller)
	if err != nil {
		t.Fatalf("OpenSelfChat (second call): %v", err)
	}
	if id1 != id2 {
		t.Fatalf("OpenSelfChat not idempotent: %q then %q", id1, id2)
	}

	// Concurrent opens (e.g. two devices' first app launch racing) must all
	// resolve to the same row, the same way OpenConversation's ON CONFLICT
	// already guarantees for an ordinary 1:1.
	const n = 8
	ids := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ids[i], errs[i] = s.OpenSelfChat(ctx, orgID, caller)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent OpenSelfChat[%d]: %v", i, err)
		}
		if ids[i] != id1 {
			t.Errorf("concurrent OpenSelfChat[%d] = %q, want %q", i, ids[i], id1)
		}
	}

	var rowCount int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM conversations WHERE org_id = $1 AND user_low = $2 AND user_high = $2`,
			orgID, caller).Scan(&rowCount)
	}); err != nil {
		t.Fatalf("count self-chat rows: %v", err)
	}
	if rowCount != 1 {
		t.Fatalf("self-chat rows for %s = %d, want exactly 1", caller, rowCount)
	}
}

// Regression guard: a self-chat is a deliberately separate, explicitly-named
// path (OpenSelfChat), not a loosening of OpenConversation's own
// `callerID == peerID` guard. If this ever starts passing, OpenConversation
// has quietly started letting ordinary "message this person" callers open a
// conversation with themselves, which is the bug store.OpenConversation's doc
// comment exists to prevent.
func TestOpenConversation_StillRefusesSelf(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")

	if _, err := s.OpenConversation(ctx, orgID, caller, caller); !errors.Is(err, ErrForbidden) {
		t.Fatalf("OpenConversation(caller, caller) = %v, want ErrForbidden", err)
	}
}

func TestSelfChat_SendReceiveOrderAndIdempotency(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")

	convID, err := s.OpenSelfChat(ctx, orgID, caller)
	if err != nil {
		t.Fatalf("OpenSelfChat: %v", err)
	}

	// The composer's actual send path (DMView always calls reply(), never
	// sendMessage() — see packages/app/src/routes/DMView.tsx) is Reply, which
	// has no senderID == recipientID guard at all. This is what makes a
	// self-chat sendable with NO new send-side store code: only the
	// conversation's own existence (OpenSelfChat) was missing.
	clientMsgID1 := uuid.Must(uuid.NewV7()).String()
	res1, err := s.Reply(ctx, orgID, caller, convID, "first note", clientMsgID1, "")
	if err != nil {
		t.Fatalf("Reply (first note): %v", err)
	}

	clientMsgID2 := uuid.Must(uuid.NewV7()).String()
	res2, err := s.Reply(ctx, orgID, caller, convID, "second note", clientMsgID2, res1.MessageID)
	if err != nil {
		t.Fatalf("Reply (second note): %v", err)
	}
	if res2.Seq <= res1.Seq {
		t.Fatalf("second message seq %d did not advance past first's %d", res2.Seq, res1.Seq)
	}

	// Idempotent replay: the same clientMsgId must return the SAME message,
	// not append a duplicate — this is appendMessageTx's general idempotency
	// check, exercised here specifically for a conversation whose sender and
	// recipient are the same person.
	resRetry, err := s.Reply(ctx, orgID, caller, convID, "first note", clientMsgID1, "")
	if err != nil {
		t.Fatalf("Reply (retry of first note): %v", err)
	}
	if resRetry.MessageID != res1.MessageID || resRetry.Seq != res1.Seq {
		t.Fatalf("retried send produced a new message: got %+v, want it to match %+v", resRetry, res1)
	}

	msgs, err := s.ListMessages(ctx, orgID, caller, convID, 0, 10)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("ListMessages returned %d messages, want 2 (idempotent retry must not add a third)", len(msgs))
	}
	// ListMessages returns ascending-by-seq history (see api.messages()'s own
	// doc comment on the client) — oldest first.
	var bodies []string
	for _, m := range msgs {
		bodies = append(bodies, m.Body)
		if m.SenderID != caller {
			t.Errorf("message %s senderId = %q, want caller %q", m.ID, m.SenderID, caller)
		}
	}
	if !(bodies[0] == "first note" && bodies[1] == "second note") {
		t.Fatalf("messages = %v, want [first note, second note] (oldest first)", bodies)
	}
}

func TestShareTaskToSelfChat(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, caller, "caller", "Caller")
	taskID := uuid.Must(uuid.NewV7()).String()

	// No prior OpenSelfChat call — this is also the "share a task before
	// Notes to Self has ever been opened" path, and must create it.
	clientMsgID := uuid.Must(uuid.NewV7()).String()
	res, err := s.ShareTaskToSelfChat(ctx, orgID, caller, taskID, "Shared a task", clientMsgID)
	if err != nil {
		t.Fatalf("ShareTaskToSelfChat: %v", err)
	}

	msgs, err := s.ListMessages(ctx, orgID, caller, res.ConversationID, 0, 10)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if msgs[0].TaskID != taskID {
		t.Fatalf("message taskId = %q, want %q", msgs[0].TaskID, taskID)
	}

	// Sharing a second task into the SAME self-chat must not open a second
	// conversation.
	taskID2 := uuid.Must(uuid.NewV7()).String()
	res2, err := s.ShareTaskToSelfChat(ctx, orgID, caller, taskID2, "Shared another task", uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ShareTaskToSelfChat (second task): %v", err)
	}
	if res2.ConversationID != res.ConversationID {
		t.Fatalf("second share opened conversation %q, want the same %q", res2.ConversationID, res.ConversationID)
	}
}
