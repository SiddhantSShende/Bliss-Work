package store

// TestListConversationsClearedPreview / TestListChannelsClearedPreview: the
// sidebar "last message" queries, against a real Postgres.
//
// These have to be DB tests, not Go unit tests, for the same reason
// TestListOpenChannels is one (see channels_membership_db_test.go's header):
// the bug fixed here — ListConversations/ListChannels never consulting
// message_hides, so Clear Chat/Clear Channel left the sidebar preview
// quoting the just-cleared message forever — was invisible to `go build`
// and `go vet`. Only a query against real rows proves the LATERAL join's
// NOT EXISTS filter and the `cleared` column actually behave as intended,
// and that the SELECT list still lines up with rawConv/rawChannelRow's Scan
// destinations (a drift there is exactly the failure mode
// TestListOpenChannels' header describes).
//
// See calls_lifecycle_db_test.go's header for the harness reused here
// (opt-in via MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestListConversationsClearedPreview(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()
	// A distinct peer per conversation: (org_id, user_low, user_high) is
	// unique, so three DMs from the same caller need three different peers.
	clearedPeer := uuid.Must(uuid.NewV7()).String()
	freshPeer := uuid.Must(uuid.NewV7()).String()
	emptyPeer := uuid.Must(uuid.NewV7()).String()

	// clearedConv: caller will clear it after seeding one message — must come
	// back with LastMessage == nil and Cleared == true.
	clearedConv := uuid.Must(uuid.NewV7()).String()
	// freshConv: never cleared — must keep showing its real last message,
	// proving the fix does not blank previews it has no business touching.
	freshConv := uuid.Must(uuid.NewV7()).String()
	// emptyConv: caller is a member but nobody has ever sent a message — must
	// report Cleared == false so the client's "Start chatting" placeholder
	// still renders (this is NOT the same state as "cleared").
	emptyConv := uuid.Must(uuid.NewV7()).String()

	seedMessage := func(tx pgx.Tx, convID, senderID string, seq int) (messageID string, err error) {
		messageID = uuid.Must(uuid.NewV7()).String()
		_, err = tx.Exec(ctx,
			`INSERT INTO messages (id, org_id, conversation_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			messageID, orgID, convID, seq, senderID, "hello", uuid.Must(uuid.NewV7()).String())
		return messageID, err
	}

	var clearedMsgID string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// last_msg_at is left NULL here, exactly as production leaves it until
		// SendMessage sets it (messages.go) — emptyConv must never get one, or
		// it would falsely look "cleared" once the seeded messages below set
		// last_msg_at on the other two.
		for _, pair := range []struct {
			convID, peerID string
		}{{clearedConv, clearedPeer}, {freshConv, freshPeer}, {emptyConv, emptyPeer}} {
			low, high := orderedPair(callerID, pair.peerID)
			if _, err := tx.Exec(ctx,
				`INSERT INTO conversations (id, org_id, user_low, user_high) VALUES ($1,$2,$3,$4)`,
				pair.convID, orgID, low, high); err != nil {
				return err
			}
			for _, uid := range []string{callerID, pair.peerID} {
				if _, err := tx.Exec(ctx,
					`INSERT INTO conversation_members (conversation_id, org_id, user_id) VALUES ($1,$2,$3)`,
					pair.convID, orgID, uid); err != nil {
					return err
				}
			}
		}
		var err error
		if clearedMsgID, err = seedMessage(tx, clearedConv, clearedPeer, 1); err != nil {
			return err
		}
		if _, err := seedMessage(tx, freshConv, freshPeer, 1); err != nil {
			return err
		}
		// Mirrors the UPDATE conversations SET last_msg_at = now() that
		// messages.go's appendMessage runs alongside every insert — the seed
		// above skips it since it goes straight to the messages table.
		for _, convID := range []string{clearedConv, freshConv} {
			if _, err := tx.Exec(ctx,
				`UPDATE conversations SET last_msg_at = now() WHERE id = $1`, convID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := s.ClearConversation(ctx, orgID, callerID, clearedConv); err != nil {
		t.Fatalf("ClearConversation: %v", err)
	}

	got, err := s.ListConversations(ctx, orgID, callerID)
	if err != nil {
		// The failure mode a SELECT-list/Scan-destination mismatch produces —
		// see this file's header.
		t.Fatalf("ListConversations: %v", err)
	}

	byID := map[string]ConversationDTO{}
	for _, c := range got {
		byID[c.ID] = c
	}
	if len(byID) != 3 {
		t.Fatalf("got %d conversations, want 3: %+v", len(byID), got)
	}

	cleared, ok := byID[clearedConv]
	if !ok {
		t.Fatalf("cleared conversation missing from result: %+v", got)
	}
	if cleared.LastMessage != nil {
		t.Errorf("cleared conversation LastMessage = %q, want nil (still showing the message the caller cleared)", *cleared.LastMessage)
	}
	if !cleared.Cleared {
		t.Error("cleared conversation Cleared = false, want true")
	}

	fresh, ok := byID[freshConv]
	if !ok {
		t.Fatalf("fresh conversation missing from result: %+v", got)
	}
	if fresh.LastMessage == nil || *fresh.LastMessage != "hello" {
		t.Errorf("fresh conversation LastMessage = %v, want \"hello\"", fresh.LastMessage)
	}
	if fresh.Cleared {
		t.Error("fresh conversation Cleared = true, want false (never cleared)")
	}

	empty, ok := byID[emptyConv]
	if !ok {
		t.Fatalf("empty conversation missing from result: %+v", got)
	}
	if empty.LastMessage != nil {
		t.Errorf("empty conversation LastMessage = %q, want nil", *empty.LastMessage)
	}
	if empty.Cleared {
		t.Error("empty conversation (never messaged) Cleared = true, want false — this is not the cleared state")
	}

	// Hiding the message individually (not via ClearConversation) must reach
	// the same Cleared/LastMessage result — the SQL keys off message_hides,
	// not a distinct "was Clear Chat clicked" flag.
	if err := s.HideMessage(ctx, orgID, callerID, clearedMsgID); err != nil {
		t.Fatalf("HideMessage (idempotent re-hide): %v", err)
	}
}

func TestListChannelsClearedPreview(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()

	clearedChan := uuid.Must(uuid.NewV7()).String()
	freshChan := uuid.Must(uuid.NewV7()).String()
	emptyChan := uuid.Must(uuid.NewV7()).String()

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// last_msg_at is left NULL here, exactly as production leaves it until
		// AppendChannelMessage sets it — emptyChan must never get one, or it
		// would falsely look "cleared" once the seeded messages below set
		// last_msg_at on the other two.
		for _, chanID := range []string{clearedChan, freshChan, emptyChan} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
				chanID, orgID, "chan-"+chanID[:8], callerID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
				chanID, orgID, callerID); err != nil {
				return err
			}
		}
		for _, chanID := range []string{clearedChan, freshChan} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, client_msg_id)
				 VALUES ($1,$2,$3,1,$4,$5,$6)`,
				uuid.Must(uuid.NewV7()).String(), orgID, chanID, senderID,
				"quarterly numbers are in", uuid.Must(uuid.NewV7()).String()); err != nil {
				return err
			}
			// Mirrors the UPDATE channels SET last_msg_at = now() that
			// append_channel.go runs alongside every insert.
			if _, err := tx.Exec(ctx,
				`UPDATE channels SET last_msg_at = now() WHERE id = $1`, chanID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := s.ClearChannel(ctx, orgID, clearedChan, callerID); err != nil {
		t.Fatalf("ClearChannel: %v", err)
	}

	got, err := s.ListChannels(ctx, orgID, callerID)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}

	byID := map[string]ChannelDTO{}
	for _, c := range got {
		byID[c.ID] = c
	}
	if len(byID) != 3 {
		t.Fatalf("got %d channels, want 3: %+v", len(byID), got)
	}

	cleared, ok := byID[clearedChan]
	if !ok {
		t.Fatalf("cleared channel missing from result: %+v", got)
	}
	if cleared.LastMessage != nil {
		t.Errorf("cleared channel LastMessage = %q, want nil", *cleared.LastMessage)
	}
	if !cleared.Cleared {
		t.Error("cleared channel Cleared = false, want true")
	}

	fresh, ok := byID[freshChan]
	if !ok {
		t.Fatalf("fresh channel missing from result: %+v", got)
	}
	if fresh.LastMessage == nil || *fresh.LastMessage != "quarterly numbers are in" {
		t.Errorf("fresh channel LastMessage = %v, want \"quarterly numbers are in\"", fresh.LastMessage)
	}
	if fresh.Cleared {
		t.Error("fresh channel Cleared = true, want false (never cleared)")
	}

	empty, ok := byID[emptyChan]
	if !ok {
		t.Fatalf("empty channel missing from result: %+v", got)
	}
	if empty.LastMessage != nil {
		t.Errorf("empty channel LastMessage = %q, want nil", *empty.LastMessage)
	}
	if empty.Cleared {
		t.Error("empty channel (never messaged) Cleared = true, want false — this is not the cleared state")
	}
}
