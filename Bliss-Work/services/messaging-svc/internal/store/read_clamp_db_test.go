package store

// B-MSG-1: a read cursor must never run past the newest seq that exists.
//
// The unified inbox's THREAD "read" passes math.MaxInt64, and the /read
// endpoints pass whatever the client sends. Taken verbatim, last_read_seq
// became 9.2e18: new messages were born "already read" (unread badge stuck at
// 0), later reads stamped no read receipts (the window (prevReadSeq, upToSeq]
// starts above every real seq) so the sender never saw "Seen", and a
// message.read event for non-existent seqs went to the peer.
//
// Real Postgres, same opt-in harness as calls_lifecycle_db_test.go
// (MESSAGING_TEST_DATABASE_URL, least-privilege role).

import (
	"context"
	"math"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func readInt(t *testing.T, s *Store, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), sql, args...).Scan(&n)
	}); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	return n
}

// lastReadEventSeq is the upToSeq of the newest message.read event for convID.
func lastReadEventSeq(t *testing.T, s *Store, convID string) int64 {
	t.Helper()
	return readInt(t, s,
		`SELECT (payload->>'upToSeq')::bigint FROM outbox
		 WHERE payload->>'type' = 'message.read' AND payload->>'conversationId' = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, convID)
}

func seedDMPair(t *testing.T, s *Store) (orgID, sender, reader string) {
	t.Helper()
	orgID, sender, reader = uuid.NewString(), uuid.NewString(), uuid.NewString()
	seedUser(t, s, orgID, sender, "sender", "Sender")
	seedUser(t, s, orgID, reader, "reader", "Reader")
	return
}

// reply appends to an existing thread. A bare SendMessage opens a NEW thread
// each time, so tests that need several messages in one thread must reply.
func reply(t *testing.T, s *Store, orgID, from, threadID string) *SendResult {
	t.Helper()
	res, err := s.ReplyToThread(context.Background(), orgID, from, threadID, "", "hi", uuid.NewString(), "")
	if err != nil {
		t.Fatalf("ReplyToThread: %v", err)
	}
	return res
}

func send(t *testing.T, s *Store, orgID, from, to string) *SendResult {
	t.Helper()
	res, err := s.SendMessage(context.Background(), orgID, from, to, "hi", uuid.NewString(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	return res
}

// The exact inbox path: MarkReadThread(math.MaxInt64).
func TestMarkReadThread_MaxInt64IsClampedToTheNewestRealSeq(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, sender, reader := seedDMPair(t, s)

	root := send(t, s, orgID, sender, reader)
	second := reply(t, s, orgID, sender, root.ThreadID)
	if root.ThreadID == "" {
		t.Fatal("test setup: SendMessage did not report a thread")
	}
	second.ThreadID = root.ThreadID

	if err := s.MarkReadThread(ctx, orgID, reader, second.ThreadID, math.MaxInt64); err != nil {
		t.Fatalf("MarkReadThread: %v", err)
	}

	got := readInt(t, s, `SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, second.ThreadID, reader)
	if got != second.Seq {
		t.Fatalf("thread cursor = %d, want %d (the newest real seq), not the requested MaxInt64", got, second.Seq)
	}
	if ev := lastReadEventSeq(t, s, second.ConversationID); ev != second.Seq {
		t.Errorf("message.read event upToSeq = %d, want %d: the peer must not be told about seqs that do not exist", ev, second.Seq)
	}

	// The consequences the bug had. A message sent afterwards is UNREAD...
	third := reply(t, s, orgID, sender, root.ThreadID)
	th, err := s.GetThread(ctx, orgID, reader, second.ThreadID)
	if err != nil {
		t.Fatalf("GetThread: %v", err)
	}
	if th.UnreadCount != 1 {
		t.Errorf("unread after a new message = %d, want 1 (cursor ran past it)", th.UnreadCount)
	}
	// ...and reading it stamps the receipt the sender sees as "Seen".
	if err := s.MarkReadThread(ctx, orgID, reader, second.ThreadID, math.MaxInt64); err != nil {
		t.Fatalf("second MarkReadThread: %v", err)
	}
	if n := readInt(t, s,
		`SELECT count(*) FROM message_delivery WHERE message_id = $1 AND recipient_id = $2 AND read_at IS NOT NULL`,
		third.MessageID, reader); n != 1 {
		t.Errorf("read receipts for the new message = %d, want 1 — the sender would never see \"Seen\"", n)
	}
}

// An arbitrary huge upToSeq from a client is the same bug by another door.
func TestMarkReadThread_ClientSuppliedHugeSeqCannotSpoofReadsOfUnsentMessages(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, sender, reader := seedDMPair(t, s)
	first := send(t, s, orgID, sender, reader)

	if err := s.MarkReadThread(ctx, orgID, reader, first.ThreadID, 1<<50); err != nil {
		t.Fatalf("MarkReadThread: %v", err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, first.ThreadID, reader); got != first.Seq {
		t.Fatalf("cursor = %d, want %d", got, first.Seq)
	}
	next := reply(t, s, orgID, sender, first.ThreadID)
	if got := readInt(t, s,
		`SELECT count(*) FROM messages m WHERE m.thread_id = $1 AND m.sender_id <> $2
		   AND m.seq > (SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2)`,
		first.ThreadID, reader); got != 1 || next.Seq <= first.Seq {
		t.Errorf("messages beyond the cursor = %d, want 1 (a pre-read future message)", got)
	}
}

func TestMarkRead_ConversationCursorAndThreadCursorsAreClamped(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, sender, reader := seedDMPair(t, s)
	send(t, s, orgID, sender, reader)
	last := send(t, s, orgID, sender, reader)

	if err := s.MarkRead(ctx, orgID, reader, last.ConversationID, math.MaxInt64); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, last.ConversationID, reader); got != last.Seq {
		t.Errorf("conversation cursor = %d, want %d", got, last.Seq)
	}
	if got := readInt(t, s, `SELECT max(tm.last_read_seq) FROM thread_members tm JOIN threads t ON t.id = tm.thread_id
		WHERE t.conversation_id = $1 AND tm.user_id = $2`, last.ConversationID, reader); got != last.Seq {
		t.Errorf("thread cursor via MarkRead = %d, want %d", got, last.Seq)
	}
	if ev := lastReadEventSeq(t, s, last.ConversationID); ev != last.Seq {
		t.Errorf("message.read upToSeq = %d, want %d", ev, last.Seq)
	}

	send(t, s, orgID, sender, reader)
	convs, err := s.ListConversations(ctx, orgID, reader)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	if len(convs) != 1 || convs[0].Unread != 1 {
		t.Errorf("conversation unread after a new message = %+v, want exactly 1", convs)
	}
}

func TestMarkChannelRead_HugeSeqIsClampedAndNewMessagesStayUnread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, creator, member := uuid.NewString(), uuid.NewString(), uuid.NewString()
	seedUser(t, s, orgID, member, "member", "Member")
	ch, err := s.CreateChannel(ctx, orgID, creator, "clamp-"+uuid.NewString()[:8], false, []string{member})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	var last int64
	for i := 0; i < 3; i++ {
		res, err := s.SendChannelMessage(ctx, orgID, ch.ID, creator, "hello", uuid.NewString(), "", "", "")
		if err != nil {
			t.Fatalf("SendChannelMessage: %v", err)
		}
		last = res.Seq
	}

	if err := s.MarkChannelRead(ctx, orgID, member, ch.ID, math.MaxInt64); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM channel_members WHERE channel_id = $1 AND user_id = $2`, ch.ID, member); got != last {
		t.Fatalf("channel cursor = %d, want %d (newest real seq)", got, last)
	}

	res, err := s.SendChannelMessage(ctx, orgID, ch.ID, creator, "after", uuid.NewString(), "", "", "")
	if err != nil {
		t.Fatalf("SendChannelMessage: %v", err)
	}
	chans, err := s.ListChannels(ctx, orgID, member)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(chans) != 1 || chans[0].Unread != 1 {
		t.Errorf("channel unread after a new message = %+v, want exactly 1 (cursor %d must be below seq %d)", chans, last, res.Seq)
	}
	// A spoofed read must not make the member appear to have read a message
	// that did not exist when they "read" it.
	receipts, err := s.ChannelReadReceipts(ctx, orgID, creator, ch.ID, []string{res.MessageID})
	if err != nil {
		t.Fatalf("ChannelReadReceipts: %v", err)
	}
	if len(receipts) != 0 {
		t.Errorf("receipts for a message sent after the read = %+v, want none", receipts)
	}
}

// A cursor never moves backwards: a stale tab's lower seq is a no-op.
func TestReadCursorsNeverMoveBackwards(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, sender, reader := seedDMPair(t, s)
	send(t, s, orgID, sender, reader)
	last := send(t, s, orgID, sender, reader)

	if err := s.MarkReadThread(ctx, orgID, reader, last.ThreadID, last.Seq); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkReadThread(ctx, orgID, reader, last.ThreadID, 1); err != nil {
		t.Fatal(err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, last.ThreadID, reader); got != last.Seq {
		t.Errorf("cursor moved to %d after a stale read, want it to stay at %d", got, last.Seq)
	}
}

// Rows an older build already pushed to MaxInt64 heal on the next read instead
// of staying broken: the cursor is pulled back to the newest real seq, so the
// messages sent after that point count as unread and receipts resume.
func TestReadHealsACursorAlreadyCorruptedToMaxInt64(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID, sender, reader := seedDMPair(t, s)
	first := send(t, s, orgID, sender, reader)

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE thread_members SET last_read_seq = $3 WHERE thread_id = $1 AND user_id = $2`,
			first.ThreadID, reader, int64(math.MaxInt64)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE conversation_members SET last_read_seq = $3 WHERE conversation_id = $1 AND user_id = $2`,
			first.ConversationID, reader, int64(math.MaxInt64))
		return err
	}); err != nil {
		t.Fatalf("corrupt cursors: %v", err)
	}
	later := reply(t, s, orgID, sender, first.ThreadID) // born "read" under the corrupted cursor

	if err := s.MarkReadThread(ctx, orgID, reader, first.ThreadID, math.MaxInt64); err != nil {
		t.Fatalf("MarkReadThread: %v", err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, first.ThreadID, reader); got != later.Seq {
		t.Fatalf("thread cursor = %d after healing, want %d", got, later.Seq)
	}
	if err := s.MarkRead(ctx, orgID, reader, first.ConversationID, math.MaxInt64); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if got := readInt(t, s, `SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, first.ConversationID, reader); got != later.Seq {
		t.Fatalf("conversation cursor = %d after healing, want %d", got, later.Seq)
	}

	newest := reply(t, s, orgID, sender, first.ThreadID)
	th, err := s.GetThread(ctx, orgID, reader, first.ThreadID)
	if err != nil {
		t.Fatal(err)
	}
	if th.UnreadCount != 1 {
		t.Errorf("unread after healing = %d, want 1", th.UnreadCount)
	}
	if err := s.MarkReadThread(ctx, orgID, reader, first.ThreadID, math.MaxInt64); err != nil {
		t.Fatal(err)
	}
	if n := readInt(t, s,
		`SELECT count(*) FROM message_delivery WHERE message_id = $1 AND recipient_id = $2 AND read_at IS NOT NULL`,
		newest.MessageID, reader); n != 1 {
		t.Errorf("read receipts after healing = %d, want 1", n)
	}
}
