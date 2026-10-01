package httpapi

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

// A first page of read rows must not hide unread ones further down: the read
// filter is applied in SQL, so each filtered feed pages through only its own rows.
func TestListNotificationsReadFilterPagesOnlyMatchingRows(t *testing.T) {
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

	orgID, recipientID := uuid.NewString(), uuid.NewString()
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	// Newest five are read; the one unread row is the OLDEST.
	for i := 0; i < 6; i++ {
		var readAt interface{}
		if i < 5 {
			readAt = base
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO notifications (id, org_id, recipient_id, kind, text, read_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			uuid.New(), orgID, recipientID, events.KindChannelAdded, "n", readAt,
			base.Add(time.Duration(10-i)*time.Minute)); err != nil {
			t.Fatalf("insert notification %d: %v", i, err)
		}
	}

	count := func(filter interface{}, limit int) (n int, unread int) {
		rows, err := pool.Query(ctx, listNotificationsSQL, recipientID, nil, nil, limit, filter)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id, kind, text            string
				task, ch, conv, msg, call *uuid.UUID
				readAt                    *time.Time
				createdAt                 time.Time
			)
			_ = id
			if err := rows.Scan(&id, &kind, &text, &task, &ch, &conv, &msg, &call, &readAt, &createdAt); err != nil {
				t.Fatalf("scan: %v", err)
			}
			n++
			if readAt == nil {
				unread++
			}
		}
		return n, unread
	}

	if n, unread := count(false, 3); n != 1 || unread != 1 {
		t.Errorf("read=false first page: %d rows (%d unread), want the single unread row", n, unread)
	}
	if n, unread := count(true, 10); n != 5 || unread != 0 {
		t.Errorf("read=true: %d rows (%d unread), want the five read rows", n, unread)
	}
	if n, _ := count(nil, 10); n != 6 {
		t.Errorf("no filter: %d rows, want 6", n)
	}
}
