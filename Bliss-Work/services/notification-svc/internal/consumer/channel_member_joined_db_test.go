package consumer

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

func TestChannelMemberJoinedPersistsUnreadNotificationOnce(t *testing.T) {
	dsn := os.Getenv("NOTIFICATION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTIFICATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect notification test DB: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate notification test DB: %v", err)
	}

	event := events.ChannelMemberJoined{
		Type:             events.TypeChannelMemberJoined,
		EventID:          uuid.NewString(),
		OrgID:            uuid.NewString(),
		ChannelID:        uuid.NewString(),
		ChannelName:      "project room",
		UserID:           uuid.NewString(),
		ActorID:          uuid.NewString(),
		ActorDisplayName: "Jordan Doe",
	}
	payload, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	c := &Consumer{pool: pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for range 2 {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin consumer tx: %v", err)
		}
		if err := c.channelMemberJoined(ctx, tx, payload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("channelMemberJoined: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit consumer tx: %v", err)
		}
	}

	var count int
	var text, channelID string
	var unread bool
	if err := pool.QueryRow(ctx,
		`SELECT count(*), max(text), bool_and(read_at IS NULL), max(channel_id::text)
		   FROM notifications WHERE org_id = $1 AND recipient_id = $2`, event.OrgID, event.UserID).
		Scan(&count, &text, &unread, &channelID); err != nil {
		t.Fatalf("read notification state: %v", err)
	}
	if count != 1 {
		t.Fatalf("notification count = %d, want one after redelivery", count)
	}
	if text != "Jordan Doe added you to the channel project room" {
		t.Errorf("notification text = %q", text)
	}
	if !unread {
		t.Error("new channel-added notification is not unread")
	}
	if channelID != event.ChannelID {
		t.Errorf("stored channelId = %q, want %q", channelID, event.ChannelID)
	}
}

func TestMessageCreatedPersistsDMAndChannelNotificationsOnce(t *testing.T) {
	dsn := os.Getenv("NOTIFICATION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTIFICATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect notification test DB: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate notification test DB: %v", err)
	}

	orgID := uuid.NewString()
	senderID := uuid.NewString()
	dmRecipientID := uuid.NewString()
	dmConversationID := uuid.NewString()
	dmMessageID := uuid.NewString()
	dmEvent := events.MessageCreated{
		Type:              events.TypeMessageCreated,
		EventID:           uuid.NewString(),
		OrgID:             orgID,
		ConversationID:    dmConversationID,
		MessageID:         dmMessageID,
		SenderID:          senderID,
		RecipientID:       dmRecipientID,
		Body:              "Hello there",
		SenderDisplayName: "Priya Shah",
	}
	dmPayload, err := json.Marshal(dmEvent)
	if err != nil {
		t.Fatalf("marshal DM event: %v", err)
	}

	channelID := uuid.NewString()
	channelMessageID := uuid.NewString()
	channelRecipientIDs := []string{uuid.NewString(), uuid.NewString()}
	channelEvent := events.ChannelMessageCreated{
		Type:              events.TypeChannelMessageCreated,
		EventID:           uuid.NewString(),
		OrgID:             orgID,
		ChannelID:         channelID,
		MessageID:         channelMessageID,
		SenderID:          senderID,
		SenderUsername:    "priya",
		SenderDisplayName: "Priya Shah",
		ChannelName:       "design-team",
		Body:              "Review is ready",
		Members:           append([]string{senderID}, channelRecipientIDs...),
	}
	channelPayload, err := json.Marshal(channelEvent)
	if err != nil {
		t.Fatalf("marshal channel event: %v", err)
	}

	c := &Consumer{pool: pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for range 2 {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin DM consumer tx: %v", err)
		}
		if err := c.messageCreated(ctx, tx, dmPayload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("messageCreated: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit DM consumer tx: %v", err)
		}

		tx, err = pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin channel consumer tx: %v", err)
		}
		if err := c.channelMessageCreated(ctx, tx, channelPayload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("channelMessageCreated: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit channel consumer tx: %v", err)
		}
	}

	var dmCount int
	var dmText, storedConversationID, storedMessageID string
	var dmUnread bool
	if err := pool.QueryRow(ctx,
		`SELECT count(*), max(text), bool_and(read_at IS NULL), max(conversation_id::text), max(message_id::text)
		   FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
		orgID, dmRecipientID, events.KindDMMessage).
		Scan(&dmCount, &dmText, &dmUnread, &storedConversationID, &storedMessageID); err != nil {
		t.Fatalf("read DM notification: %v", err)
	}
	if dmCount != 1 || !dmUnread || dmText != "Priya Shah: Hello there" || storedConversationID != dmConversationID || storedMessageID != dmMessageID {
		t.Errorf("DM notification = count %d, unread %t, text %q, destination %q/%q", dmCount, dmUnread, dmText, storedConversationID, storedMessageID)
	}

	for _, recipientID := range channelRecipientIDs {
		var count int
		var text, storedChannelID string
		var unread bool
		if err := pool.QueryRow(ctx,
			`SELECT count(*), max(text), bool_and(read_at IS NULL), max(channel_id::text)
			   FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
			orgID, recipientID, events.KindChannelMessage).
			Scan(&count, &text, &unread, &storedChannelID); err != nil {
			t.Fatalf("read channel notification: %v", err)
		}
		if count != 1 || !unread || text != "Priya Shah in #design-team: Review is ready" || storedChannelID != channelID {
			t.Errorf("channel notification for %s = count %d, unread %t, text %q, channel %q", recipientID, count, unread, text, storedChannelID)
		}
	}

	var senderCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
		orgID, senderID, events.KindChannelMessage).Scan(&senderCount); err != nil {
		t.Fatalf("read channel sender notifications: %v", err)
	}
	if senderCount != 0 {
		t.Errorf("channel sender received %d notifications, want none", senderCount)
	}
}
