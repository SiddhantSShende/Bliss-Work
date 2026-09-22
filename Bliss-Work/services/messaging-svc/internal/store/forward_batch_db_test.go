package store

// ForwardMessages, against a real Postgres with RLS actually enforcing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// Ordering is the load-bearing claim here — sources land at a destination in
// `seq` order regardless of the order they were requested in — and `seq` is
// allocated by a real UPDATE ... RETURNING seq_counter against a real row.
// Nothing about that is fakeable without re-implementing the allocator inside
// the test double, which would just be testing the double.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedProjectedUser gives a forward TARGET user id a user_projection row in
// orgID — resolveForwardDestUser looks the target up there (it is the org
// membership check for "does this user exist and belong to my org"), which a
// bare fresh uuid with no such row correctly fails as ErrForbidden.
func seedProjectedUser(t *testing.T, s *Store, orgID, userID string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1,$2,$3,$4)`,
			userID, orgID, "forward-target", "Forward Target")
		return err
	}); err != nil {
		t.Fatalf("seed user_projection: %v", err)
	}
}

// channelMessageSeq reads back one channel message's own seq, so a test can
// assert on destination ORDER rather than trusting the order it sent things in.
func messagesInOrder(t *testing.T, s *Store, convID string, ids []string) bool {
	t.Helper()
	ctx := context.Background()
	seqs := make(map[string]int64, len(ids))
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for _, id := range ids {
			var seq int64
			if err := tx.QueryRow(ctx, `SELECT seq FROM messages WHERE id = $1 AND conversation_id = $2`, id, convID).Scan(&seq); err != nil {
				return err
			}
			seqs[id] = seq
		}
		return nil
	}); err != nil {
		t.Fatalf("read seqs: %v", err)
	}
	for i := 1; i < len(ids); i++ {
		if seqs[ids[i-1]] >= seqs[ids[i]] {
			return false
		}
	}
	return true
}

// ── Sources land at BOTH a user and a channel destination, in seq order,
// regardless of the order they were listed in the request ───────────────────
func TestForwardMessages_DeliversInSeqOrder_NotRequestOrder(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	forwarder, other := seedMessageUsers(t, s, orgID)
	channelID := seedChannelWithRoles(t, s, orgID, forwarder, nil)

	// Three sources in a source DM, sent in order 1, 2, 3.
	seed, err := s.SendMessage(ctx, orgID, forwarder, other, "one", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send 1: %v", err)
	}
	two, err := s.Reply(ctx, orgID, forwarder, seed.ConversationID, "two", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("send 2: %v", err)
	}
	three, err := s.Reply(ctx, orgID, forwarder, seed.ConversationID, "three", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("send 3: %v", err)
	}

	// Deliberately shuffled in the request: 3, 1, 2.
	shuffled := []string{three.MessageID, seed.MessageID, two.MessageID}
	targetUser := uuid.Must(uuid.NewV7()).String()
	seedProjectedUser(t, s, orgID, targetUser)
	results, err := s.ForwardMessages(ctx, orgID, forwarder, shuffled,
		[]ForwardTarget{
			{Kind: ForwardTargetUser, ID: targetUser},
			{Kind: ForwardTargetChannel, ID: channelID},
		}, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ForwardMessages: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}

	for _, res := range results {
		if res.Err != nil {
			t.Errorf("destination %s/%s failed: %v", res.Target.Kind, res.Target.ID, res.Err)
		}
		if len(res.MessageIDs) != 3 {
			t.Errorf("destination %s/%s delivered %d messages, want 3", res.Target.Kind, res.Target.ID, len(res.MessageIDs))
		}
	}

	userRes := results[0]
	if !messagesInOrder(t, s, userRes.ConversationID, userRes.MessageIDs) {
		t.Errorf("user destination's clones are not in ascending seq order: %v", userRes.MessageIDs)
	}
}

// ── One bad destination fails alone; a good one still delivers ──────────────
func TestForwardMessages_OneBadDestinationDoesNotBlockOthers(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	forwarder, other := seedMessageUsers(t, s, orgID)

	seed, err := s.SendMessage(ctx, orgID, forwarder, other, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	goodTarget := uuid.Must(uuid.NewV7()).String()
	seedProjectedUser(t, s, orgID, goodTarget)
	// The forwarder is not a member of this channel — resolveForwardDestChannel
	// must refuse it without touching the other destination.
	notMyChannel := seedChannelWithRoles(t, s, orgID, uuid.Must(uuid.NewV7()).String(), nil)

	results, err := s.ForwardMessages(ctx, orgID, forwarder, []string{seed.MessageID},
		[]ForwardTarget{
			{Kind: ForwardTargetChannel, ID: notMyChannel},
			{Kind: ForwardTargetUser, ID: goodTarget},
		}, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ForwardMessages: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %d, want 2", len(results))
	}
	if results[0].Err == nil {
		t.Error("forwarding to a channel the forwarder is not a member of should have failed")
	}
	if results[1].Err != nil {
		t.Errorf("the good destination failed too: %v — one bad destination must not block another", results[1].Err)
	}
	if len(results[1].MessageIDs) != 1 {
		t.Errorf("good destination delivered %d messages, want 1", len(results[1].MessageIDs))
	}
}

// ── Retrying the whole batch with the SAME clientBatchId delivers nothing
// new ──────────────────────────────────────────────────────────────────────
func TestForwardMessages_RetryWithSameBatchID_DeliversNothingNew(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	forwarder, other := seedMessageUsers(t, s, orgID)

	seed, err := s.SendMessage(ctx, orgID, forwarder, other, "hello", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	target := uuid.Must(uuid.NewV7()).String()
	seedProjectedUser(t, s, orgID, target)
	batchID := uuid.Must(uuid.NewV7()).String()

	first, err := s.ForwardMessages(ctx, orgID, forwarder, []string{seed.MessageID},
		[]ForwardTarget{{Kind: ForwardTargetUser, ID: target}}, batchID)
	if err != nil {
		t.Fatalf("first forward: %v", err)
	}
	second, err := s.ForwardMessages(ctx, orgID, forwarder, []string{seed.MessageID},
		[]ForwardTarget{{Kind: ForwardTargetUser, ID: target}}, batchID)
	if err != nil {
		t.Fatalf("second (retry) forward: %v", err)
	}

	if first[0].Err != nil || second[0].Err != nil {
		t.Fatalf("forward failed: first=%v second=%v", first[0].Err, second[0].Err)
	}
	if first[0].MessageIDs[0] != second[0].MessageIDs[0] {
		t.Errorf("retry delivered a DIFFERENT clone id (%s vs %s) — the derived client_msg_id did not dedupe",
			first[0].MessageIDs[0], second[0].MessageIDs[0])
	}

	var count int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM messages WHERE conversation_id = $1 AND is_forward`,
			first[0].ConversationID).Scan(&count)
	}); err != nil {
		t.Fatalf("count clones: %v", err)
	}
	if count != 1 {
		t.Errorf("forwarded-message rows in the destination = %d, want exactly 1 after two identical batches", count)
	}
}

// ── A source the caller cannot read fails the WHOLE request, not just that
// source's share of it ───────────────────────────────────────────────────────
func TestForwardMessages_UnreadableSource_FailsWholeRequest(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	forwarder, other := seedMessageUsers(t, s, orgID)
	stranger := uuid.Must(uuid.NewV7()).String()

	// A message in a conversation `forwarder` has never been part of.
	notMine, err := s.SendMessage(ctx, orgID, stranger, other, "not yours", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	_, err = s.ForwardMessages(ctx, orgID, forwarder, []string{notMine.MessageID},
		[]ForwardTarget{{Kind: ForwardTargetUser, ID: uuid.Must(uuid.NewV7()).String()}},
		uuid.Must(uuid.NewV7()).String())
	if err != ErrForbidden {
		t.Errorf("forwarding an unreadable source = %v, want ErrForbidden", err)
	}
}

// ── Sources spanning two different conversations are rejected outright ──────
func TestForwardMessages_MixedScopeSources_Rejected(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	forwarder, other := seedMessageUsers(t, s, orgID)
	carol := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, carol, "carol", "Carol")

	inAB, err := s.SendMessage(ctx, orgID, forwarder, other, "in AB", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send AB: %v", err)
	}
	inAC, err := s.SendMessage(ctx, orgID, forwarder, carol, "in AC", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("send AC: %v", err)
	}

	_, err = s.ForwardMessages(ctx, orgID, forwarder, []string{inAB.MessageID, inAC.MessageID},
		[]ForwardTarget{{Kind: ForwardTargetUser, ID: uuid.Must(uuid.NewV7()).String()}},
		uuid.Must(uuid.NewV7()).String())
	if err != ErrMixedForwardScope {
		t.Errorf("mixed-scope batch = %v, want ErrMixedForwardScope", err)
	}
}
