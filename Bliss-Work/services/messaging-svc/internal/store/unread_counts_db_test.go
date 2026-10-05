package store

// UnreadCounts, against a real Postgres — proving its three aggregate
// queries produce the SAME numbers ListConversations/ListChannels/
// ListInboxPeers compute per-row and the client today sums itself (see
// docs/API-LAZY-LOADING-AUDIT.md D1/S3). A unit test can't catch a subquery
// that silently diverges from its source; only comparing against the real
// list endpoints, against a real database, can.
//
// Opt-in, same harness as calls_lifecycle_db_test.go.

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestUnreadCounts_MatchesConversationsSum(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.NewString()
	sender := uuid.NewString()
	recipient := uuid.NewString()
	seedUser(t, s, orgID, sender, "sender", "Sender")
	seedUser(t, s, orgID, recipient, "recipient", "Recipient")

	for i := 0; i < 3; i++ {
		if _, err := s.SendMessage(ctx, orgID, sender, recipient, "hi", uuid.NewString(), SendOptions{}); err != nil {
			t.Fatalf("SendMessage %d: %v", i, err)
		}
	}

	convs, err := s.ListConversations(ctx, orgID, recipient)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	var wantSum int64
	for _, c := range convs {
		wantSum += c.Unread
	}
	if wantSum != 3 {
		t.Fatalf("test setup sanity check failed: ListConversations summed to %d, want 3", wantSum)
	}

	counts, err := s.UnreadCounts(ctx, orgID, recipient)
	if err != nil {
		t.Fatalf("UnreadCounts: %v", err)
	}
	if counts.Conversations != wantSum {
		t.Errorf("UnreadCounts.Conversations = %d, want %d (ListConversations' own sum)", counts.Conversations, wantSum)
	}

	// Mark read and confirm both drop together.
	if err := s.MarkRead(ctx, orgID, recipient, convs[0].ID, 3); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	counts2, err := s.UnreadCounts(ctx, orgID, recipient)
	if err != nil {
		t.Fatalf("UnreadCounts after MarkRead: %v", err)
	}
	if counts2.Conversations != 0 {
		t.Errorf("UnreadCounts.Conversations after MarkRead = %d, want 0", counts2.Conversations)
	}
}

func TestUnreadCounts_MatchesChannelsSum(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.NewString()
	creator := uuid.NewString()
	member := uuid.NewString()

	// CreateChannel verifies every seed member actually belongs to the org
	// (verifyMembersInOrg, channels.go) via user_projection — creatorID is
	// exempt (their own JWT identity), member is not. RLS-protected, so this
	// runs in an org-scoped tx, same as the inbox_items fixture below.
	if err := func() error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1,$2,$3,$4)`,
			member, orgID, "member", "Member"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}(); err != nil {
		t.Fatalf("seed user_projection: %v", err)
	}

	ch, err := s.CreateChannel(ctx, orgID, creator, "general", false, []string{member})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Creating the channel already left the member unread system messages (the
	// creation notice and the "added" notice), so measure that baseline rather
	// than hard-coding how many there are.
	seeded, err := s.ListChannels(ctx, orgID, member)
	if err != nil {
		t.Fatalf("ListChannels (before sends): %v", err)
	}
	var systemUnread int64
	for _, c := range seeded {
		systemUnread += c.Unread
	}

	var lastSeq int64
	for i := 0; i < 4; i++ {
		res, err := s.SendChannelMessage(ctx, orgID, ch.ID, creator, "hello", uuid.NewString(), "", "", "")
		if err != nil {
			t.Fatalf("SendChannelMessage %d: %v", i, err)
		}
		lastSeq = res.Seq
	}

	channels, err := s.ListChannels(ctx, orgID, member)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	var wantSum int64
	for _, c := range channels {
		wantSum += c.Unread
	}
	if wantSum != systemUnread+4 {
		t.Fatalf("test setup sanity check failed: ListChannels summed to %d, want %d", wantSum, systemUnread+4)
	}

	counts, err := s.UnreadCounts(ctx, orgID, member)
	if err != nil {
		t.Fatalf("UnreadCounts: %v", err)
	}
	if counts.Channels != wantSum {
		t.Errorf("UnreadCounts.Channels = %d, want %d (ListChannels' own sum)", counts.Channels, wantSum)
	}

	if err := s.MarkChannelRead(ctx, orgID, member, ch.ID, lastSeq); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	counts2, err := s.UnreadCounts(ctx, orgID, member)
	if err != nil {
		t.Fatalf("UnreadCounts after MarkChannelRead: %v", err)
	}
	if counts2.Channels != 0 {
		t.Errorf("UnreadCounts.Channels after MarkChannelRead = %d, want 0", counts2.Channels)
	}
}

func TestUnreadCounts_MatchesInboxPeersSum(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.NewString()
	owner := uuid.NewString()
	peerA := uuid.NewString()
	peerB := uuid.NewString()

	// Direct fixture rows — the aggregation logic under test is UnreadCounts'
	// own SUM, not the mail-send pipeline that would normally produce these
	// rows (already covered by mail_send_db_test.go's unreadCountFor helper).
	// inbox_items is RLS-protected, so the inserts run in an org-scoped tx —
	// same setOrgGUC pattern CreateChannel uses (channels.go) — rather than
	// through the plain pool.
	insert := `INSERT INTO inbox_items
		(org_id, owner_user_id, item_kind, ref_id, peer_user_id, unread_count, last_event_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())`
	hiddenInsert := `INSERT INTO inbox_items
		(org_id, owner_user_id, item_kind, ref_id, peer_user_id, unread_count, hidden_for_owner, last_event_at)
		VALUES ($1, $2, 'MAIL', $3, $4, 9, true, now())`
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		t.Fatalf("setOrgGUC: %v", err)
	}
	if _, err := tx.Exec(ctx, insert, orgID, owner, "MAIL", uuid.NewString(), peerA, 2); err != nil {
		t.Fatalf("insert MAIL row: %v", err)
	}
	if _, err := tx.Exec(ctx, insert, orgID, owner, "THREAD", uuid.NewString(), peerB, 5); err != nil {
		t.Fatalf("insert THREAD row: %v", err)
	}
	// A TASK-kind row must NOT count — INBOX_KINDS (client) / inboxBadgeKinds
	// (server) both deliberately exclude it (see inboxKinds.ts's own comment).
	if _, err := tx.Exec(ctx, insert, orgID, owner, "TASK", uuid.NewString(), peerB, 100); err != nil {
		t.Fatalf("insert TASK row: %v", err)
	}
	// A hidden row must not count either.
	if _, err := tx.Exec(ctx, hiddenInsert, orgID, owner, uuid.NewString(), peerA); err != nil {
		t.Fatalf("insert hidden row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture rows: %v", err)
	}

	peers, err := s.ListInboxPeers(ctx, orgID, owner, []string{"MAIL", "THREAD"})
	if err != nil {
		t.Fatalf("ListInboxPeers: %v", err)
	}
	var wantSum int64
	for _, p := range peers {
		wantSum += p.UnreadCount
	}
	if wantSum != 7 {
		t.Fatalf("test setup sanity check failed: ListInboxPeers summed to %d, want 7", wantSum)
	}

	counts, err := s.UnreadCounts(ctx, orgID, owner)
	if err != nil {
		t.Fatalf("UnreadCounts: %v", err)
	}
	if counts.InboxPeers != wantSum {
		t.Errorf("UnreadCounts.InboxPeers = %d, want %d (ListInboxPeers' own sum, excluding TASK/hidden rows)", counts.InboxPeers, wantSum)
	}
}
