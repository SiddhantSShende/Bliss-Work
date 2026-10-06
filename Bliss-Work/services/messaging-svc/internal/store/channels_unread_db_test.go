package store

// TestListChannelsUnreadCount / TestListChannelsAndConversationsLastMessageSenderID:
// the channel unread badge and the Link-sent/Link-received direction fields,
// against a real Postgres.
//
// DB tests, not Go unit tests, for the same reason TestListOpenChannels and
// TestListChannelsClearedPreview are (see their headers): a SELECT-list /
// Scan-destination mismatch compiles and vets clean and is invisible against
// an empty table — only a query that returns real rows, decrypted and
// unread-counted against genuine channel_members.last_read_seq cursors under
// RLS, proves the new `unread` and `lastMessageSenderId` columns actually
// line up and compute the right numbers.
//
// See calls_lifecycle_db_test.go's header for the harness reused here
// (opt-in via MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestListChannelsUnreadCount(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	authorID := uuid.Must(uuid.NewV7()).String()
	readerID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()

	seedMsg := func(tx pgx.Tx, seq int) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			uuid.Must(uuid.NewV7()).String(), orgID, channelID, seq, authorID,
			"update", uuid.Must(uuid.NewV7()).String())
		return err
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "chan-"+channelID[:8], authorID); err != nil {
			return err
		}
		for _, uid := range []string{authorID, readerID} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
				channelID, orgID, uid); err != nil {
				return err
			}
		}
		for seq := 1; seq <= 3; seq++ {
			if err := seedMsg(tx, seq); err != nil {
				return err
			}
		}
		// seq_counter too: every real send advances it with the seq it assigns,
		// and MarkChannelRead clamps a cursor to it, so seeding rows without it
		// would describe a channel that cannot exist.
		_, err := tx.Exec(ctx, `UPDATE channels SET last_msg_at = now(), seq_counter = 3 WHERE id = $1`, channelID)
		return err
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A reader who has never read anything (last_read_seq defaults to 0, per
	// 0028_channel_read_receipts.sql) sees all 3 messages as unread.
	got, err := s.ListChannels(ctx, orgID, readerID)
	if err != nil {
		t.Fatalf("ListChannels(reader): %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d channels for reader, want 1: %+v", len(got), got)
	}
	if got[0].Unread != 3 {
		t.Errorf("reader Unread = %d, want 3 (three messages, never read)", got[0].Unread)
	}

	// The author never sees their own messages counted as unread, regardless
	// of their own last_read_seq — mirrors ListConversations' `sender_id <>
	// $2` rule exactly.
	gotAuthor, err := s.ListChannels(ctx, orgID, authorID)
	if err != nil {
		t.Fatalf("ListChannels(author): %v", err)
	}
	if len(gotAuthor) != 1 {
		t.Fatalf("got %d channels for author, want 1: %+v", len(gotAuthor), gotAuthor)
	}
	if gotAuthor[0].Unread != 0 {
		t.Errorf("author Unread = %d, want 0 (a sender's own messages are never unread to them)", gotAuthor[0].Unread)
	}

	// MarkChannelRead moves the reader's cursor to seq 2 — one message (seq 3)
	// must remain unread. This is also the ChannelView.tsx / ChannelsList.tsx
	// wiring's server-side half: the cursor this advances is exactly what the
	// query above counts against.
	if err := s.MarkChannelRead(ctx, orgID, readerID, channelID, 2); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	got, err = s.ListChannels(ctx, orgID, readerID)
	if err != nil {
		t.Fatalf("ListChannels(reader) after mark-read: %v", err)
	}
	if len(got) != 1 || got[0].Unread != 1 {
		t.Fatalf("reader Unread after marking read to seq 2 = %+v, want exactly one channel with Unread=1", got)
	}
}

func TestListChannelsAndConversationsLastMessageSenderID(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	authorID := uuid.Must(uuid.NewV7()).String()
	readerID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	convID := uuid.Must(uuid.NewV7()).String()

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "chan-"+channelID[:8], authorID); err != nil {
			return err
		}
		for _, uid := range []string{authorID, readerID} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
				channelID, orgID, uid); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, channelID, authorID,
			"https://example.com/report", uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE channels SET last_msg_at = now() WHERE id = $1`, channelID); err != nil {
			return err
		}

		low, high := orderedPair(authorID, readerID)
		if _, err := tx.Exec(ctx,
			`INSERT INTO conversations (id, org_id, user_low, user_high) VALUES ($1,$2,$3,$4)`,
			convID, orgID, low, high); err != nil {
			return err
		}
		for _, uid := range []string{authorID, readerID} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO conversation_members (conversation_id, org_id, user_id) VALUES ($1,$2,$3)`,
				convID, orgID, uid); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO messages (id, org_id, conversation_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, convID, authorID,
			"https://example.com/report", uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE conversations SET last_msg_at = now() WHERE id = $1`, convID)
		return err
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	chans, err := s.ListChannels(ctx, orgID, readerID)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(chans) != 1 || chans[0].LastMessageSenderID != authorID {
		t.Fatalf("channel LastMessageSenderID = %+v, want exactly one channel with sender %s", chans, authorID)
	}

	open, err := s.ListOpenChannels(ctx, orgID, uuid.Must(uuid.NewV7()).String(), 50, 0)
	if err != nil {
		t.Fatalf("ListOpenChannels: %v", err)
	}
	if len(open) != 1 || open[0].LastMessageSenderID != authorID {
		t.Fatalf("open channel LastMessageSenderID = %+v, want exactly one channel with sender %s", open, authorID)
	}

	convs, err := s.ListConversations(ctx, orgID, readerID)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	if len(convs) != 1 || convs[0].LastMessageSenderID != authorID {
		t.Fatalf("conversation LastMessageSenderID = %+v, want exactly one conversation with sender %s", convs, authorID)
	}
}
