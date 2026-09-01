package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

/*
Regression coverage for cross-platform notification sync: handleRead and
handleReadAll used to update the database and return, with no signal to any
other active session (another browser tab, another device, the desktop app)
that the read state changed — they only found out on their next full GET. See
markRead/markAllRead in httpapi.go.

auth.FromContext requires claims set by the real Verifier.Middleware (keyed on
an unexported type in the shared jwtauth package, unreachable from here), so
these tests exercise markRead/markAllRead — the actual DB+outbox logic this
fix adds — directly, rather than through HTTP. The auth/routing layer above
them is unchanged by this fix.

Set NOTIFICATION_TEST_DATABASE_URL to run, mirroring the REDIS_TEST_URL
convention in ws-gateway's integration tests. Skipped otherwise, so `go test
./...` stays green with no Postgres available (e.g. in CI).
*/

func testServer(t *testing.T) *Server {
	t.Helper()
	url := os.Getenv("NOTIFICATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NOTIFICATION_TEST_DATABASE_URL not set; skipping Postgres integration test")
	}

	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := db.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Each test gets a clean slate — order-independence matters since these
	// tests share one database.
	if _, err := pool.Exec(context.Background(), `TRUNCATE notifications, outbox, consumed_events`); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	return &Server{pool: pool, log: slog.New(slog.DiscardHandler)}
}

// seedNotification inserts one unread notification row directly, bypassing
// the Kafka consumer entirely — these tests are about what happens to an
// EXISTING row when it's marked read, not how it got created.
func seedNotification(t *testing.T, s *Server, orgID, recipientID string) uuid.UUID {
	t.Helper()
	id := uuid.Must(uuid.NewV7())
	_, err := s.pool.Exec(context.Background(),
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text) VALUES ($1, $2, $3, 'TASK_COMPLETED', 'Task completed by someone')`,
		id, orgID, recipientID)
	if err != nil {
		t.Fatalf("seed notification: %v", err)
	}
	return id
}

// outboxNotificationReadRows returns every NotificationRead payload currently
// in the outbox, decoded. The publisher goroutine isn't running in these
// tests, so rows stay put for inspection.
func outboxNotificationReadRows(t *testing.T, s *Server) []events.NotificationRead {
	t.Helper()
	rows, err := s.pool.Query(context.Background(),
		`SELECT payload FROM outbox WHERE topic = $1 ORDER BY created_at`, events.TopicNotification)
	if err != nil {
		t.Fatalf("query outbox: %v", err)
	}
	defer rows.Close()

	var out []events.NotificationRead
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			t.Fatalf("scan outbox row: %v", err)
		}
		var evt events.NotificationRead
		if err := json.Unmarshal(payload, &evt); err != nil {
			t.Fatalf("unmarshal outbox payload: %v", err)
		}
		if evt.Type == events.TypeNotificationRead {
			out = append(out, evt)
		}
	}
	return out
}

// inTx begins a transaction, runs fn against it, and commits — the harness
// every test below uses to call markRead/markAllRead exactly the way the real
// handlers do (same transaction boundary), without needing HTTP or auth.
func inTx(t *testing.T, s *Server, fn func(ctx context.Context, tx pgx.Tx) error) {
	t.Helper()
	ctx := context.Background()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(ctx, tx); err != nil {
		t.Fatalf("fn: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

const (
	testOrg  = "018f0000-0000-7000-8000-00000000aaa1"
	testUser = "018f0000-0000-7000-8000-00000000bbb1"
)

func TestMarkRead_EnqueuesNotificationRead_OnRealChange(t *testing.T) {
	s := testServer(t)
	notifID := seedNotification(t, s, testOrg, testUser)

	var exists bool
	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		exists, err = s.markRead(ctx, tx, notifID, testUser, testOrg)
		return err
	})

	if !exists {
		t.Fatalf("markRead: got exists=false, want true")
	}
	rows := outboxNotificationReadRows(t, s)
	if len(rows) != 1 {
		t.Fatalf("outbox rows: got %d, want 1", len(rows))
	}
	if rows[0].RecipientID != testUser {
		t.Errorf("recipientId: got %q, want %q", rows[0].RecipientID, testUser)
	}
	if rows[0].NotificationID == nil || *rows[0].NotificationID != notifID.String() {
		t.Errorf("notificationId: got %v, want %q", rows[0].NotificationID, notifID.String())
	}
}

func TestMarkRead_AlreadyRead_EnqueuesNothing(t *testing.T) {
	s := testServer(t)
	notifID := seedNotification(t, s, testOrg, testUser)

	// First call does the real flip.
	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		_, err := s.markRead(ctx, tx, notifID, testUser, testOrg)
		return err
	})
	if got := len(outboxNotificationReadRows(t, s)); got != 1 {
		t.Fatalf("after first mark-read: got %d outbox rows, want 1", got)
	}

	// Second call is the idempotent re-read: a UI double-click, or two tabs
	// racing to clear the same row. It must not re-broadcast.
	var exists bool
	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		exists, err = s.markRead(ctx, tx, notifID, testUser, testOrg)
		return err
	})

	if !exists {
		t.Fatalf("markRead on already-read row: got exists=false, want true (it exists, just already read)")
	}
	if got := len(outboxNotificationReadRows(t, s)); got != 1 {
		t.Fatalf("after redundant mark-read: got %d outbox rows, want still 1 (no duplicate event)", got)
	}
}

func TestMarkRead_UnknownNotification_ReturnsNotExists_EnqueuesNothing(t *testing.T) {
	s := testServer(t)

	var exists bool
	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		exists, err = s.markRead(ctx, tx, uuid.Must(uuid.NewV7()), testUser, testOrg)
		return err
	})

	if exists {
		t.Fatalf("markRead on unknown id: got exists=true, want false")
	}
	if got := len(outboxNotificationReadRows(t, s)); got != 0 {
		t.Fatalf("outbox rows for a 404: got %d, want 0", got)
	}
}

func TestMarkAllRead_EnqueuesOneEvent_NotOnePerRow(t *testing.T) {
	s := testServer(t)
	seedNotification(t, s, testOrg, testUser)
	seedNotification(t, s, testOrg, testUser)
	seedNotification(t, s, testOrg, testUser)

	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		return s.markAllRead(ctx, tx, testUser, testOrg)
	})

	rows := outboxNotificationReadRows(t, s)
	if len(rows) != 1 {
		t.Fatalf("outbox rows for a 3-row read-all: got %d, want 1 (one event per action, not per row)", len(rows))
	}
	if rows[0].NotificationID != nil {
		t.Errorf("notificationId on a bulk read-all event: got %v, want nil", *rows[0].NotificationID)
	}
}

func TestMarkAllRead_NothingUnread_EnqueuesNothing(t *testing.T) {
	s := testServer(t)
	// No notifications seeded at all — the caller's unread set is empty.

	inTx(t, s, func(ctx context.Context, tx pgx.Tx) error {
		return s.markAllRead(ctx, tx, testUser, testOrg)
	})

	if got := len(outboxNotificationReadRows(t, s)); got != 0 {
		t.Fatalf("outbox rows for a no-op read-all: got %d, want 0", got)
	}
}
