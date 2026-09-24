package store

// DeleteMessagesForAll / DeleteChannelMessagesForAll, against a real Postgres
// with RLS actually enforcing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The set-based UPDATE ... WHERE id = ANY($1) AND sender_id = $2 predicate is
// exactly the kind of thing that is easy to get subtly wrong — matching one
// row too many, or too few — in a way a mock store cannot catch: the
// authorization report (Deleted vs. Skipped) is read back from the database's
// own RETURNING set, not asserted against by the test author's own idea of
// what should have matched.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func outboxCount(t *testing.T, s *Store, key, eventType string) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
			key, eventType).Scan(&n)
	}); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return n
}

// ── DM: a mixed selection deletes only the caller's own messages ────────────
func TestDeleteMessagesForAll_MixedSelection_DeletesOnlyOwn(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	mine1, err := s.SendMessage(ctx, orgID, alice, bob, "mine 1", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	convID := mine1.ConversationID
	mine2, err := s.Reply(ctx, orgID, alice, convID, "mine 2", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("reply: %v", err)
	}
	theirs, err := s.Reply(ctx, orgID, bob, convID, "theirs", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("reply: %v", err)
	}

	res, err := s.DeleteMessagesForAll(ctx, orgID, alice, convID,
		[]string{mine1.MessageID, mine2.MessageID, theirs.MessageID})
	if err != nil {
		t.Fatalf("bulk delete: %v", err)
	}
	sort.Strings(res.Deleted)
	want := []string{mine1.MessageID, mine2.MessageID}
	sort.Strings(want)
	if len(res.Deleted) != 2 || res.Deleted[0] != want[0] || res.Deleted[1] != want[1] {
		t.Errorf("Deleted = %v, want %v", res.Deleted, want)
	}
	if len(res.Skipped) != 1 || res.Skipped[0] != theirs.MessageID {
		t.Errorf("Skipped = %v, want [%s]", res.Skipped, theirs.MessageID)
	}

	// The database agrees: alice's two are tombstoned, bob's is not.
	var mineDeleted1, mineDeleted2, theirsDeleted bool
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT deleted_for_all_at IS NOT NULL FROM messages WHERE id = $1`, mine1.MessageID).Scan(&mineDeleted1); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT deleted_for_all_at IS NOT NULL FROM messages WHERE id = $1`, mine2.MessageID).Scan(&mineDeleted2); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT deleted_for_all_at IS NOT NULL FROM messages WHERE id = $1`, theirs.MessageID).Scan(&theirsDeleted)
	}); err != nil {
		t.Fatalf("read messages: %v", err)
	}
	if !mineDeleted1 || !mineDeleted2 {
		t.Error("alice's own messages were not tombstoned")
	}
	if theirsDeleted {
		t.Error("bob's message was tombstoned by alice's bulk delete — authorization was bypassed")
	}

	if n := outboxCount(t, s, convID, "message.deleted"); n != 2 {
		t.Errorf("message.deleted events = %d, want exactly 2 (one per newly-deleted message)", n)
	}
}

// ── DM: a non-member gets ErrForbidden, not a 200 with everything skipped ───
func TestDeleteMessagesForAll_NonMember_IsForbidden(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)
	stranger := uuid.Must(uuid.NewV7()).String()

	seed, err := s.SendMessage(ctx, orgID, alice, bob, "seed", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, err = s.DeleteMessagesForAll(ctx, orgID, stranger, seed.ConversationID, []string{seed.MessageID})
	if err != ErrForbidden {
		t.Errorf("DeleteMessagesForAll by a non-member = %v, want ErrForbidden", err)
	}
}

// ── DM: re-running the same call is a no-op that reports the same ids and
// writes no second outbox event ──────────────────────────────────────────────
func TestDeleteMessagesForAll_Retry_IsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	seed, err := s.SendMessage(ctx, orgID, alice, bob, "seed", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	first, err := s.DeleteMessagesForAll(ctx, orgID, alice, seed.ConversationID, []string{seed.MessageID})
	if err != nil {
		t.Fatalf("first delete: %v", err)
	}
	if len(first.Deleted) != 1 || first.Deleted[0] != seed.MessageID {
		t.Fatalf("first delete: Deleted = %v, want [%s]", first.Deleted, seed.MessageID)
	}

	second, err := s.DeleteMessagesForAll(ctx, orgID, alice, seed.ConversationID, []string{seed.MessageID})
	if err != nil {
		t.Fatalf("second (retry) delete: %v", err)
	}
	if len(second.Deleted) != 1 || second.Deleted[0] != seed.MessageID {
		t.Errorf("retry: Deleted = %v, want [%s] — a retry must still report it as deleted", second.Deleted, seed.MessageID)
	}

	if n := outboxCount(t, s, seed.ConversationID, "message.deleted"); n != 1 {
		t.Errorf("message.deleted events after two calls = %d, want exactly 1 — the retry must not re-emit", n)
	}
}

// ── Channel: a moderator's batch authorizes everyone's messages; a plain
// member's authorizes only their own, and a deleted pinned message unpins ────
func TestDeleteChannelMessagesForAll_ModeratorVsMember(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	member := uuid.Must(uuid.NewV7()).String()
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{member: RoleMember})

	ownerMsg, err := s.SendChannelMessage(ctx, orgID, channelID, owner, "owner's", uuid.Must(uuid.NewV7()).String(), "", "", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	memberMsg, err := s.SendChannelMessage(ctx, orgID, channelID, member, "member's", uuid.Must(uuid.NewV7()).String(), "", "", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	// Pin the member's message so the delete-unpins-it assertion below means
	// something.
	if err := s.SetChannelMessagePin(ctx, orgID, owner, memberMsg.MessageID, true, []string{}); err != nil {
		t.Fatalf("pin: %v", err)
	}

	// A plain member's batch only authorizes their own message.
	memberRes, err := s.DeleteChannelMessagesForAll(ctx, orgID, member, channelID,
		[]string{ownerMsg.MessageID, memberMsg.MessageID}, []string{})
	if err != nil {
		t.Fatalf("member bulk delete: %v", err)
	}
	if len(memberRes.Deleted) != 1 || memberRes.Deleted[0] != memberMsg.MessageID {
		t.Errorf("member's Deleted = %v, want [%s]", memberRes.Deleted, memberMsg.MessageID)
	}
	if len(memberRes.Skipped) != 1 || memberRes.Skipped[0] != ownerMsg.MessageID {
		t.Errorf("member's Skipped = %v, want [%s]", memberRes.Skipped, ownerMsg.MessageID)
	}

	var pinnedAt any
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT pinned_at FROM channel_messages WHERE id = $1`, memberMsg.MessageID).Scan(&pinnedAt)
	}); err != nil {
		t.Fatalf("read pinned_at: %v", err)
	}
	if pinnedAt != nil {
		t.Error("deleted channel message is still pinned — a tombstone must not stay pinned")
	}

	// The owner (a moderator) can now delete the message the member could not.
	ownerRes, err := s.DeleteChannelMessagesForAll(ctx, orgID, owner, channelID, []string{ownerMsg.MessageID}, []string{})
	if err != nil {
		t.Fatalf("owner bulk delete: %v", err)
	}
	if len(ownerRes.Deleted) != 1 || ownerRes.Deleted[0] != ownerMsg.MessageID {
		t.Errorf("owner's Deleted = %v, want [%s]", ownerRes.Deleted, ownerMsg.MessageID)
	}
}

// ── An id from a DIFFERENT conversation is skipped, never deleted ───────────
func TestDeleteMessagesForAll_IDFromAnotherConversation_IsSkipped(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)
	carol := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, carol, "carol", "Carol")

	convAB, err := s.SendMessage(ctx, orgID, alice, bob, "in AB", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send AB: %v", err)
	}
	convAC, err := s.SendMessage(ctx, orgID, alice, carol, "in AC", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send AC: %v", err)
	}

	// Ask the AB endpoint to delete a message that actually lives in AC.
	res, err := s.DeleteMessagesForAll(ctx, orgID, alice, convAB.ConversationID, []string{convAC.MessageID})
	if err != nil {
		t.Fatalf("bulk delete: %v", err)
	}
	if len(res.Deleted) != 0 || len(res.Skipped) != 1 || res.Skipped[0] != convAC.MessageID {
		t.Errorf("cross-conversation id: Deleted=%v Skipped=%v, want Deleted=[] Skipped=[%s]",
			res.Deleted, res.Skipped, convAC.MessageID)
	}

	var stillThere bool
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT deleted_for_all_at IS NULL FROM messages WHERE id = $1`, convAC.MessageID).Scan(&stillThere)
	}); err != nil {
		t.Fatalf("read: %v", err)
	}
	if !stillThere {
		t.Error("a message from a DIFFERENT conversation was deleted via the wrong conversation's endpoint")
	}
}
