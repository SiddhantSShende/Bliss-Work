package httpapi

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

func TestMarkReadFlipsUnreadNotificationOnce(t *testing.T) {
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

	orgID, recipientID, notificationID := uuid.NewString(), uuid.NewString(), uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text)
		 VALUES ($1, $2, $3, $4, $5)`, notificationID, orgID, recipientID,
		events.KindChannelAdded, "Jordan Doe added you to the channel project room"); err != nil {
		t.Fatalf("insert unread notification: %v", err)
	}

	server := New(pool, nil, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	for range 2 {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin mark-read tx: %v", err)
		}
		exists, err := server.markRead(ctx, tx, notificationID, recipientID, orgID)
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("markRead: %v", err)
		}
		if !exists {
			t.Fatal("markRead reported that the notification does not exist")
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit mark-read tx: %v", err)
		}
	}

	var read bool
	var readEvents int
	if err := pool.QueryRow(ctx,
		`SELECT read_at IS NOT NULL FROM notifications WHERE id = $1`, notificationID).Scan(&read); err != nil {
		t.Fatalf("read notification state: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox WHERE org_id = $1 AND kafka_key = $2 AND payload->>'type' = $3`,
		orgID, recipientID, events.TypeNotificationRead).Scan(&readEvents); err != nil {
		t.Fatalf("count read events: %v", err)
	}
	if !read {
		t.Error("notification remained unread after markRead")
	}
	if readEvents != 1 {
		t.Errorf("notification.read events = %d, want one", readEvents)
	}
}

func TestMarkReadAllowsRecipientOwnedNotificationAfterOrgSwitch(t *testing.T) {
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

	ownerID, notificationOrgID, activeOrgID, notificationID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text)
		 VALUES ($1, $2, $3, $4, $5)`, notificationID, notificationOrgID, ownerID,
		events.KindMeetingInvite, "Meeting invitation: Planning"); err != nil {
		t.Fatalf("insert cross-org notification: %v", err)
	}

	server := New(pool, nil, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin mark-read tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	exists, err := server.markRead(ctx, tx, notificationID, ownerID, activeOrgID)
	if err != nil {
		t.Fatalf("markRead after org switch: %v", err)
	}
	if !exists {
		t.Fatal("recipient-owned notification was not found after org switch")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit mark-read tx: %v", err)
	}

	var read bool
	if err := pool.QueryRow(ctx,
		`SELECT read_at IS NOT NULL FROM notifications WHERE id=$1 AND org_id=$2`,
		notificationID, notificationOrgID).Scan(&read); err != nil {
		t.Fatalf("read cross-org notification state: %v", err)
	}
	if !read {
		t.Error("recipient-owned notification remained unread after org switch")
	}
}
