package consumer

// Regression tests for B-NOT-1: a NUL in a message body (which messaging-svc
// accepts, because the body is stored encrypted) reached notifications.text,
// Postgres rejected it (22021), runBatch read that as transient and stopped the
// process, and the restarted consumer refetched the same batch and died on the
// same row — every notification behind it blocked forever.
//
// The DB tests are opt-in on NOTIFICATION_TEST_DATABASE_URL like the rest of
// this package's DB tests.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
)

func TestSanitizeTextAndPreviewDropNULAndInvalidUTF8(t *testing.T) {
	if got, want := sanitizeText("a\x00b\x00"), "ab"; got != want {
		t.Fatalf("sanitizeText(NUL) = %q, want %q", got, want)
	}
	if got := sanitizeText("ok \xff\xfe bytes"); !utf8.ValidString(got) || !strings.HasPrefix(got, "ok ") {
		t.Fatalf("sanitizeText(invalid utf-8) = %q", got)
	}
	if got, want := sanitizeText("plain ünïcode ✓"), "plain ünïcode ✓"; got != want {
		t.Fatalf("sanitizeText altered valid text: %q", got)
	}
	// NULs are removed BEFORE the 140-rune cut, so they do not eat the budget.
	body := strings.Repeat("\x00", 200) + strings.Repeat("a", 140)
	if got := messagePreview(body); got != strings.Repeat("a", 140) {
		t.Fatalf("messagePreview with leading NULs = %q (%d runes)", got, len([]rune(got)))
	}
	if got, want := messagePreview("\x00\x00"), "Sent an attachment"; got != want {
		t.Fatalf("NUL-only body preview = %q, want %q", got, want)
	}
}

func TestIsPermanentDBErrorClassification(t *testing.T) {
	pg := func(code string) error { return fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code}) }
	for _, code := range []string{"22021", "22P05", "22P02", "22001", "23502", "23503", "23514"} {
		if !isPermanentDBError(pg(code)) {
			t.Errorf("SQLSTATE %s must be permanent", code)
		}
	}
	// Anything a retry or a restart can cure must stay transient.
	for _, code := range []string{"23505", "40001", "40P01", "08006", "53300", "57P01", "42P01", "25P02"} {
		if isPermanentDBError(pg(code)) {
			t.Errorf("SQLSTATE %s must stay transient", code)
		}
	}
	if isPermanentDBError(fmt.Errorf("connection refused")) || isPermanentDBError(nil) {
		t.Error("a non-Postgres error / nil must not be permanent")
	}
}

func poisonTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("NOTIFICATION_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NOTIFICATION_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect notification test DB: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate notification test DB: %v", err)
	}
	return pool
}

func quietConsumer(pool *pgxpool.Pool) *Consumer {
	return &Consumer{pool: pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func msg(t *testing.T, v any) kafka.Message {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return kafka.Message{Topic: events.TopicMessaging, Value: b}
}

// The exact production trigger: a DM and a channel message whose body (and the
// sender / channel names, which feed the same text) contain U+0000.
func TestNULInMessageBodyIsStrippedNotFatal(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	orgID, senderID, dmRecipient, channelRecipient := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	dm := msg(t, events.MessageCreated{
		Type: events.TypeMessageCreated, EventID: uuid.NewString(), OrgID: orgID,
		ConversationID: uuid.NewString(), MessageID: uuid.NewString(),
		SenderID: senderID, RecipientID: dmRecipient,
		SenderDisplayName: "Pri\x00ya", Body: "hel\x00lo\x00",
	})
	ch := msg(t, events.ChannelMessageCreated{
		Type: events.TypeChannelMessageCreated, EventID: uuid.NewString(), OrgID: orgID,
		ChannelID: uuid.NewString(), MessageID: uuid.NewString(),
		SenderID: senderID, SenderDisplayName: "Priya", ChannelName: "de\x00sign",
		Body: "\x00review\x00", Members: []string{senderID, channelRecipient},
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{dm, ch})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v; a NUL body must be projected, not abandoned or dead-lettered", len(poison), err)
	}

	for _, tc := range []struct{ recipient, kind, want string }{
		{dmRecipient, events.KindDMMessage, "Priya: hello"},
		{channelRecipient, events.KindChannelMessage, "Priya in #design: review"},
	} {
		var text string
		if err := pool.QueryRow(ctx,
			`SELECT text FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
			orgID, tc.recipient, tc.kind).Scan(&text); err != nil {
			t.Fatalf("%s notification not stored: %v", tc.kind, err)
		}
		if text != tc.want {
			t.Errorf("%s text = %q, want %q", tc.kind, text, tc.want)
		}
	}
	// The same text rides in the jsonb outbox payload, which rejects \u0000 too.
	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox WHERE org_id = $1 AND payload ->> 'text' = 'Priya: hello'`, orgID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("outbox rows for the sanitized DM = %d, err %v; want 1", n, err)
	}
}

// A permanent database error that survives sanitizing (forced here with a CHECK
// constraint, SQLSTATE 23514) must dead-letter ONLY that message, commit the
// rest of the batch, and not be reported as an abandon (which stops the
// process and re-meets the same row after the restart).
func TestPermanentDBErrorIsIsolatedAndDeadLettered(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	if _, err := pool.Exec(ctx,
		`ALTER TABLE notifications ADD CONSTRAINT bw_poison_chk CHECK (text NOT LIKE '%POISONPILL%')`); err != nil {
		t.Fatalf("add test constraint: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `ALTER TABLE notifications DROP CONSTRAINT IF EXISTS bw_poison_chk`)
	})

	orgID := uuid.NewString()
	mk := func(who string) (kafka.Message, string) {
		recipient := uuid.NewString()
		return msg(t, events.TaskEvent{
			Type: events.TypeTaskCompleted, EventID: uuid.NewString(), OrgID: orgID,
			SenderID: recipient, AssigneeUsername: who,
		}), recipient
	}
	good1, r1 := mk("alice")
	bad, rBad := mk("POISONPILL")
	good2, r2 := mk("bob")

	poison, err := c.projectBatch(ctx, []kafka.Message{good1, bad, good2})
	if err != nil {
		t.Fatalf("projectBatch returned %v; a permanent DB error must not abandon the batch", err)
	}
	if len(poison) != 1 || string(poison[0].Value) != string(bad.Value) {
		t.Fatalf("poison = %d messages, want exactly the offending one", len(poison))
	}
	count := func(recipient string) int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgID, recipient).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(r1) != 1 || count(r2) != 1 {
		t.Errorf("healthy neighbours stored = %d and %d, want 1 and 1", count(r1), count(r2))
	}
	if count(rBad) != 0 {
		t.Error("the poison message must leave no notification behind")
	}
	// Its dedup claim was rolled back with it, and the rest are claimed once.
	var claimed int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox WHERE org_id = $1`, orgID).Scan(&claimed); err != nil || claimed != 2 {
		t.Errorf("outbox rows = %d (err %v), want 2", claimed, err)
	}
}

// Transient failure keeps its meaning: the batch is abandoned (error returned,
// nothing dead-lettered) so the caller stops the process and the batch is
// redelivered.
func TestTransientErrorStillAbandonsTheBatch(t *testing.T) {
	pool := poisonTestPool(t)
	c := quietConsumer(pool)
	pool.Close() // every Begin now fails, like a database that went away

	poison, err := c.projectBatch(context.Background(), []kafka.Message{
		msg(t, events.TaskEvent{Type: events.TypeTaskCompleted, EventID: uuid.NewString(), OrgID: uuid.NewString(), SenderID: uuid.NewString()}),
	})
	if err == nil {
		t.Fatal("a transient (connection) error must abandon the batch so it is redelivered")
	}
	if len(poison) != 0 {
		t.Fatalf("a transient error must never dead-letter anything, got %d", len(poison))
	}
}
