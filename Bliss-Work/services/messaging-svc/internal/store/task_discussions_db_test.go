package store

// task_discussions.go, against a real Postgres with RLS actually enforcing.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) reused here.

import (
	"context"
	"math"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedChannelMember adds an EXTRA member to a channel seedChannel already
// created (seedChannel seeds only the owner).
func seedChannelMember(t *testing.T, s *Store, orgID, channelID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, userID)
		return err
	}); err != nil {
		t.Fatalf("seed channel member: %v", err)
	}
}

// TestOpenTaskDiscussionDMIsIdempotent: two "Chat" clicks for the same
// task+peer must return the same discussion row, not a duplicate — the whole
// point of the partial unique index in 0035_task_discussions.sql.
func TestOpenTaskDiscussionDMIsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	allocator := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, allocator, "priya", "Priya Nair")
	seedUser(t, s, orgID, assignee, "sam", "Sam Okafor")

	first, err := s.OpenTaskDiscussion(ctx, orgID, allocator, taskID, &assignee, nil)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	second, err := s.OpenTaskDiscussion(ctx, orgID, allocator, taskID, &assignee, nil)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if first.ID != second.ID {
		t.Errorf("second open created a NEW row: first.ID=%q second.ID=%q, want the same id", first.ID, second.ID)
	}
	if first.ConversationID == nil || second.ConversationID == nil || *first.ConversationID != *second.ConversationID {
		t.Errorf("conversationId did not stay stable across opens: %v vs %v", first.ConversationID, second.ConversationID)
	}
	if first.Kind != TaskDiscussionKindDM {
		t.Errorf("kind = %q, want DM", first.Kind)
	}
}

// TestOpenTaskDiscussionChannelIsIdempotent is the channel twin of the above.
func TestOpenTaskDiscussionChannelIsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, member, "priya", "Priya Nair")
	seedChannel(t, s, orgID, channelID, member)

	first, err := s.OpenTaskDiscussion(ctx, orgID, member, taskID, nil, &channelID)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	second, err := s.OpenTaskDiscussion(ctx, orgID, member, taskID, nil, &channelID)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if first.ID != second.ID {
		t.Errorf("second open created a NEW row: first.ID=%q second.ID=%q, want the same id", first.ID, second.ID)
	}
	if first.Kind != TaskDiscussionKindChannel {
		t.Errorf("kind = %q, want CHANNEL", first.Kind)
	}
}

// TestOpenTaskDiscussionNonMemberOfChannelIsForbidden: tagging a channel task
// discussion requires channel membership, same gate SendChannelMessage uses.
func TestOpenTaskDiscussionNonMemberOfChannelIsForbidden(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	outsider := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, owner, "priya", "Priya Nair")
	seedUser(t, s, orgID, outsider, "sam", "Sam Okafor")
	seedChannel(t, s, orgID, channelID, owner)

	if _, err := s.OpenTaskDiscussion(ctx, orgID, outsider, taskID, nil, &channelID); err != ErrForbidden {
		t.Fatalf("OpenTaskDiscussion by non-member: got %v, want ErrForbidden", err)
	}
}

// TestOpenTaskDiscussionBothOrNeitherTargetIsRejected guards the "exactly
// one of peerId/channelId" contract at the store layer too, not only in the
// HTTP handler's own validation.
func TestOpenTaskDiscussionBothOrNeitherTargetIsRejected(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()

	if _, err := s.OpenTaskDiscussion(ctx, orgID, caller, taskID, nil, nil); err != ErrTaskDiscussionTargetRequired {
		t.Errorf("neither target: got %v, want ErrTaskDiscussionTargetRequired", err)
	}
	if _, err := s.OpenTaskDiscussion(ctx, orgID, caller, taskID, &peer, &channelID); err != ErrTaskDiscussionTargetRequired {
		t.Errorf("both targets: got %v, want ErrTaskDiscussionTargetRequired", err)
	}
}

// TestSendTaskDiscussionMessageBackfillsThreadOnFirstSend: the discussion has
// no thread right after OpenTaskDiscussion; the first send must create one and
// backfill it, and a second send must reuse that SAME thread rather than
// minting another.
func TestSendTaskDiscussionMessageBackfillsThreadOnFirstSend(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	allocator := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, allocator, "priya", "Priya Nair")
	seedUser(t, s, orgID, assignee, "sam", "Sam Okafor")

	opened, err := s.OpenTaskDiscussion(ctx, orgID, allocator, taskID, &assignee, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if opened.ThreadID != nil {
		t.Fatalf("freshly opened discussion already has a threadId: %v", *opened.ThreadID)
	}

	first, err := s.SendTaskDiscussionMessage(ctx, orgID, allocator, taskID, assignee, "about this task", uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if first.ThreadID == "" {
		t.Fatalf("first send produced no threadId")
	}

	var backfilled *string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT thread_id FROM task_discussions WHERE id = $1`, opened.ID).Scan(&backfilled)
	}); err != nil {
		t.Fatalf("read back thread_id: %v", err)
	}
	if backfilled == nil || *backfilled != first.ThreadID {
		t.Fatalf("task_discussions.thread_id = %v, want %q", backfilled, first.ThreadID)
	}

	second, err := s.SendTaskDiscussionMessage(ctx, orgID, allocator, taskID, assignee, "a follow-up", uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("second send: %v", err)
	}
	if second.ThreadID != first.ThreadID {
		t.Errorf("second send used threadId %q, want the same thread %q as the first", second.ThreadID, first.ThreadID)
	}
}

// TestBulkTaskDiscussionsDMUnreadCount: the recipient's unread count reflects
// the sender's message and never counts the recipient's own replies, and
// drops to zero once the thread is marked read.
func TestBulkTaskDiscussionsDMUnreadCount(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	allocator := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, allocator, "priya", "Priya Nair")
	seedUser(t, s, orgID, assignee, "sam", "Sam Okafor")

	if _, err := s.SendTaskDiscussionMessage(ctx, orgID, allocator, taskID, assignee, "please take a look", uuid.Must(uuid.NewV7()).String()); err != nil {
		t.Fatalf("send: %v", err)
	}

	summaries, err := s.BulkTaskDiscussions(ctx, orgID, assignee, []string{taskID})
	if err != nil {
		t.Fatalf("bulk (assignee): %v", err)
	}
	if len(summaries) != 1 || summaries[0].UnreadCount != 1 {
		t.Fatalf("assignee's summaries = %+v, want exactly one row with UnreadCount 1", summaries)
	}

	// The sender's own message must never count against the sender.
	senderSummaries, err := s.BulkTaskDiscussions(ctx, orgID, allocator, []string{taskID})
	if err != nil {
		t.Fatalf("bulk (allocator): %v", err)
	}
	if len(senderSummaries) != 1 || senderSummaries[0].UnreadCount != 0 {
		t.Fatalf("allocator's summaries = %+v, want exactly one row with UnreadCount 0", senderSummaries)
	}

	if err := s.MarkReadThread(ctx, orgID, assignee, *summaries[0].ThreadID, math.MaxInt64); err != nil {
		t.Fatalf("mark thread read: %v", err)
	}
	after, err := s.BulkTaskDiscussions(ctx, orgID, assignee, []string{taskID})
	if err != nil {
		t.Fatalf("bulk after read: %v", err)
	}
	if len(after) != 1 || after[0].UnreadCount != 0 {
		t.Fatalf("after marking read, summaries = %+v, want UnreadCount 0", after)
	}
}

// TestBulkTaskDiscussionsChannelUnreadCount is the channel twin: unread counts
// only messages TAGGED with this task, never a channel's ordinary traffic.
func TestBulkTaskDiscussionsChannelUnreadCount(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	taskID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, sender, "priya", "Priya Nair")
	seedUser(t, s, orgID, member, "sam", "Sam Okafor")
	seedChannel(t, s, orgID, channelID, sender)
	seedChannelMember(t, s, orgID, channelID, member)

	// Untagged, ordinary channel traffic must not count.
	if _, err := s.SendChannelMessage(ctx, orgID, channelID, sender, "unrelated chatter", uuid.Must(uuid.NewV7()).String(), "", "", ""); err != nil {
		t.Fatalf("send ordinary message: %v", err)
	}
	if _, err := s.SendChannelTaskMessage(ctx, orgID, sender, taskID, channelID, "about this task", uuid.Must(uuid.NewV7()).String()); err != nil {
		t.Fatalf("send task message: %v", err)
	}

	summaries, err := s.BulkTaskDiscussions(ctx, orgID, member, []string{taskID})
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if len(summaries) != 1 || summaries[0].UnreadCount != 1 {
		t.Fatalf("summaries = %+v, want exactly one row with UnreadCount 1 (the ordinary message must not count)", summaries)
	}

	if err := s.MarkChannelRead(ctx, orgID, member, channelID, math.MaxInt64); err != nil {
		t.Fatalf("mark channel read: %v", err)
	}
	after, err := s.BulkTaskDiscussions(ctx, orgID, member, []string{taskID})
	if err != nil {
		t.Fatalf("bulk after read: %v", err)
	}
	if len(after) != 1 || after[0].UnreadCount != 0 {
		t.Fatalf("after marking read, summaries = %+v, want UnreadCount 0", after)
	}
}
