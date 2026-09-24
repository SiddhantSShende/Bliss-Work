package store

// channel_messages.reply_to_id (migration 0031), against a real Postgres.
//
// This has to be a DB test for the same reason screenshot_attempt_db_test.go
// is one: the column is written and read back inside SendChannelMessage /
// ChannelMessages' own encrypt/scan plumbing, so the only way to see whether a
// reply id actually round-trips is to send one and read it back.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) reused here.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func seedChannel(t *testing.T, s *Store, orgID, channelID, ownerID string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "general", ownerID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, ownerID)
		return err
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
}

// TestChannelMessageReplyToIDRoundTrips is the regression test for channel
// reply-to-message: the id sent on send must come back on read, the same way
// it already does for DM messages (messages.reply_to_id).
func TestChannelMessageReplyToIDRoundTrips(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "priya", "Priya Nair")
	seedChannel(t, s, orgID, channelID, senderID)

	original, err := s.SendChannelMessage(ctx, orgID, channelID, senderID, "the original",
		uuid.Must(uuid.NewV7()).String(), "", "", "")
	if err != nil {
		t.Fatalf("send original: %v", err)
	}
	reply, err := s.SendChannelMessage(ctx, orgID, channelID, senderID, "quoting it",
		uuid.Must(uuid.NewV7()).String(), "", original.MessageID, "")
	if err != nil {
		t.Fatalf("send reply: %v", err)
	}

	msgs, err := s.ChannelMessages(ctx, orgID, channelID, senderID, 0, 10)
	if err != nil {
		t.Fatalf("ChannelMessages: %v", err)
	}
	var got string
	var found bool
	for _, m := range msgs {
		if m.ID == reply.MessageID {
			got, found = m.ReplyToID, true
		}
	}
	if !found {
		t.Fatalf("reply message %s not found in ChannelMessages result", reply.MessageID)
	}
	if got != original.MessageID {
		t.Errorf("reply.ReplyToID = %q, want %q (the original message's id)", got, original.MessageID)
	}
}

// TestChannelMessageWithNoReplyLeavesReplyToIDEmpty guards the common case: an
// ordinary send must not pick up a stray reply_to_id.
func TestChannelMessageWithNoReplyLeavesReplyToIDEmpty(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "priya", "Priya Nair")
	seedChannel(t, s, orgID, channelID, senderID)

	res, err := s.SendChannelMessage(ctx, orgID, channelID, senderID, "no reply here",
		uuid.Must(uuid.NewV7()).String(), "", "", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	msgs, err := s.ChannelMessages(ctx, orgID, channelID, senderID, 0, 10)
	if err != nil {
		t.Fatalf("ChannelMessages: %v", err)
	}
	for _, m := range msgs {
		if m.ID == res.MessageID && m.ReplyToID != "" {
			t.Errorf("ordinary message got a ReplyToID = %q, want empty", m.ReplyToID)
		}
	}
}
