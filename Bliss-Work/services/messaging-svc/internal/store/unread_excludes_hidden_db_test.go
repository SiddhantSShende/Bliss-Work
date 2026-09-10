package store

// ListConversations' and GetThread's unread counts, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch is a SQL predicate omission — both
// unread-count queries counted raw `messages` rows with no message_hides
// exclusion, unlike the sibling preview queries right next to them (see
// cleared_preview_db_test.go) — and whether the count actually changes when a
// message is hidden can only be observed against a real query plan and real
// rows. HideMessage/ClearConversation only ever insert into message_hides,
// never touch last_read_seq, so before this fix a cleared conversation kept
// an unread badge with no message left for the client to ever mark read.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// ── The bug: ListConversations must not count a message the caller hid ───────
func TestListConversations_HiddenMessageNotCountedUnread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()

	res, err := s.SendMessage(ctx, orgID, peer, caller, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	unreadFor := func() int64 {
		t.Helper()
		convs, err := s.ListConversations(ctx, orgID, caller)
		if err != nil {
			t.Fatalf("ListConversations: %v", err)
		}
		for _, c := range convs {
			if c.ID == res.ConversationID {
				return c.Unread
			}
		}
		t.Fatalf("conversation %s missing from ListConversations", res.ConversationID)
		return -1
	}

	if got := unreadFor(); got != 1 {
		t.Fatalf("unread before hiding = %d, want 1 (sanity check on the baseline)", got)
	}

	if err := s.HideMessage(ctx, orgID, caller, res.MessageID); err != nil {
		t.Fatalf("HideMessage: %v", err)
	}

	if got := unreadFor(); got != 0 {
		t.Errorf("unread after hiding the only message = %d, want 0 — a hidden message left no way "+
			"for the client to ever mark it read, so this badge would be stuck forever", got)
	}
}

// ── Same bug, ClearConversation's bulk hide ───────────────────────────────────
func TestListConversations_ClearedConversationHasZeroUnread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()

	res, err := s.SendMessage(ctx, orgID, peer, caller, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := s.Reply(ctx, orgID, peer, res.ConversationID, "again", uuid.Must(uuid.NewV7()).String(), ""); err != nil {
		t.Fatalf("reply: %v", err)
	}

	if err := s.ClearConversation(ctx, orgID, caller, res.ConversationID); err != nil {
		t.Fatalf("ClearConversation: %v", err)
	}

	convs, err := s.ListConversations(ctx, orgID, caller)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	for _, c := range convs {
		if c.ID == res.ConversationID {
			if c.Unread != 0 {
				t.Errorf("unread after ClearConversation = %d, want 0", c.Unread)
			}
			return
		}
	}
	t.Fatalf("conversation %s missing from ListConversations", res.ConversationID)
}

// ── The bug: GetThread must not count a message the caller hid ───────────────
func TestGetThread_HiddenMessageNotCountedUnread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()

	res, err := s.SendMessage(ctx, orgID, peer, caller, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	before, err := s.GetThread(ctx, orgID, caller, res.ThreadID)
	if err != nil {
		t.Fatalf("GetThread (before): %v", err)
	}
	if before.UnreadCount != 1 {
		t.Fatalf("UnreadCount before hiding = %d, want 1 (sanity check on the baseline)", before.UnreadCount)
	}

	if err := s.HideMessage(ctx, orgID, caller, res.MessageID); err != nil {
		t.Fatalf("HideMessage: %v", err)
	}

	after, err := s.GetThread(ctx, orgID, caller, res.ThreadID)
	if err != nil {
		t.Fatalf("GetThread (after): %v", err)
	}
	if after.UnreadCount != 0 {
		t.Errorf("UnreadCount after hiding the only message = %d, want 0", after.UnreadCount)
	}
}

// ── Positive control: an UNHIDDEN message must still count ───────────────────
func TestGetThread_UnhiddenMessageStillCountsUnread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	caller := uuid.Must(uuid.NewV7()).String()
	peer := uuid.Must(uuid.NewV7()).String()

	res, err := s.SendMessage(ctx, orgID, peer, caller, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	d, err := s.GetThread(ctx, orgID, caller, res.ThreadID)
	if err != nil {
		t.Fatalf("GetThread: %v", err)
	}
	if d.UnreadCount != 1 {
		t.Errorf("UnreadCount = %d, want 1 — the fix must not blank counts it has no business touching", d.UnreadCount)
	}
}
