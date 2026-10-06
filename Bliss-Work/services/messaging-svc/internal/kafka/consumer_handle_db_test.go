package kafka

// AuthConsumer/TaskProjectionConsumer's handle() true/false contract, against
// a real Postgres.
//
// ── Why this cannot be a pure-Go unit test ────────────────────────────────────
// The bug this file exists to catch was about ORDERING against a real
// database: does a failed write leave the dedup row unwritten (so a later
// redelivery would actually retry it), or does dedup land regardless and
// silently swallow the retry. A fake/mock store can't tell that story — it
// can only prove the Go code CALLS things in some order, not that a genuine
// Postgres failure and a genuine redelivery interact the way the fix intends.
//
// See store/calls_lifecycle_db_test.go's header for the harness this mirrors
// (opt-in via MESSAGING_TEST_DATABASE_URL, least-privilege role required, and
// why migrations are applied file-by-file rather than via Store.Migrate).
//
//	docker run -d --name kafka-handle-pg -e POSTGRES_PASSWORD=pw -p 5599:5432 postgres:16
//	psql … -c "CREATE ROLE messaging_user LOGIN PASSWORD 'pw';
//	           GRANT ALL ON SCHEMA public TO messaging_user;
//	           ALTER SCHEMA public OWNER TO messaging_user;"
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/kafka/ -run TestHandle -v

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/messaging-svc/migrations"
)

// handleTestStore opens the opt-in test database, migrates it, and returns
// both the Store the consumer uses and a raw verification pool this test file
// queries directly (set_config('app.bypass_rls', ...) itself) — mirroring
// store/calls_lifecycle_db_test.go's lifecycleStore, duplicated rather than
// imported since that helper is unexported from a different package.
func handleTestStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("MESSAGING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("MESSAGING_TEST_DATABASE_URL not set; see the header of this file")
	}
	ctx := context.Background()

	kek, err := crypto.NewDevKEKProvider("kafka-handle-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatalf("dev KEK: %v", err)
	}
	s, err := store.New(ctx, url, crypto.New(kek, time.Minute))
	if err != nil {
		t.Fatalf("connect (store): %v", err)
	}
	t.Cleanup(s.Close)

	verify, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect (verify pool): %v", err)
	}
	t.Cleanup(verify.Close)

	handleMigrateOnce(t, verify)
	return s, verify
}

var handleMigrated bool

func handleMigrateOnce(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if handleMigrated {
		return
	}
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	names := []string{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	ctx := context.Background()
	for _, name := range names {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if err := bypassExec(ctx, pool, string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	handleMigrated = true
}

// bypassExec runs sql in its own transaction with app.bypass_rls set, exactly
// as Store.withBypass does internally — reimplemented here (rather than
// exported from package store for one test file) since every RLS-protected
// table this file queries would otherwise fail closed (return zero rows) for
// the least-privilege role MESSAGING_TEST_DATABASE_URL must use.
func bypassExec(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func bypassQueryExists(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) bool {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		t.Fatalf("set bypass: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx, sql, args...).Scan(&exists); err != nil {
		t.Fatalf("query: %v", err)
	}
	return exists
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// ── The bug: a failed write must not be marked consumed ──────────────────────
func TestHandle_UserCreated_WriteFails_LeavesEventUnconsumed(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()

	// UpsertUser's INSERT fails at the database with a genuine Postgres
	// serialization failure (40001) — a real TRANSIENT write failure, raised by
	// a trigger so it lands after the dedup pre-check, which is the ordering
	// this test is about. (A bad uuid used to stand in here, but that is a
	// PERMANENT error, which handle now skips instead of retrying — see
	// consumer_skip_db_test.go.)
	failWritesTransiently(t, verify, "user_projection")
	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: uuid.Must(uuid.NewV7()).String(), OrgID: uuid.Must(uuid.NewV7()).String(),
		Username: "alice", DisplayName: "Alice",
	})

	if ok := c.handle(context.Background(), payload); ok {
		t.Fatal("handle() = true after a genuine store write failure; want false so Run withholds the commit")
	}
	if bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM consumed_events WHERE event_id = $1)`, eventID) {
		t.Fatal("event was marked consumed despite the write failing — a redelivery would now be silently skipped forever")
	}
}

// ── The fix actually enables retry: same event, valid data this time ─────────
func TestHandle_UserCreated_RetryAfterFailureSucceeds(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()
	userID := uuid.Must(uuid.NewV7()).String()
	orgID := uuid.Must(uuid.NewV7()).String()

	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: userID, OrgID: orgID, Username: "alice", DisplayName: "Alice",
	})
	dropTrigger := failWritesTransiently(t, verify, "user_projection")
	if ok := c.handle(context.Background(), payload); ok {
		t.Fatal("first attempt reported success unexpectedly")
	}

	// The "redelivery": same event, the outage over — exactly what Run's
	// un-committed offset would hand back to handle() after a restart.
	dropTrigger()
	if ok := c.handle(context.Background(), payload); !ok {
		t.Fatal("retry with valid data still failed — dedup must have blocked it")
	}
	if !bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM consumed_events WHERE event_id = $1)`, eventID) {
		t.Error("event not marked consumed after a successful retry")
	}
	// The assertion that actually distinguishes "the retry ran UpsertUser" from
	// "the retry was silently skipped because the first (failed) attempt had
	// already claimed the event id" — handle() reporting true and a
	// consumed_events row existing are both also true under that stale-claim
	// bug, since the claim itself doesn't care whether the write it precedes
	// ever ran.
	if !bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM user_projection WHERE user_id = $1)`, userID) {
		t.Error("user_projection has no row for the retried user — the retry was reported successful " +
			"without the write ever actually running")
	}
}

// ── The pre-check actually skips an already-applied event cheaply ────────────
func TestHandle_UserCreated_AlreadyConsumed_SkipsTheWrite(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()
	userID := uuid.Must(uuid.NewV7()).String()
	orgID := uuid.Must(uuid.NewV7()).String()

	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: userID, OrgID: orgID, Username: "alice", DisplayName: "Alice",
	})
	if ok := c.handle(context.Background(), payload); !ok {
		t.Fatal("first (valid) attempt failed unexpectedly")
	}

	// Second delivery of the SAME event id. If IsConsumed's pre-check were
	// removed (or moved after the write), this would silently redo the write
	// — harmless here since it is idempotent, but the point of the pre-check
	// is that it does not have to. The updated payload's OrgID would surface
	// as a genuine data-corruption bug if the write ran again with it.
	corrupted, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: userID, OrgID: uuid.Must(uuid.NewV7()).String(), Username: "someone-else", DisplayName: "Someone Else",
	})
	if ok := c.handle(context.Background(), corrupted); !ok {
		t.Fatal("redelivery of an already-consumed event reported failure")
	}

	username := userProjectionUsername(t, verify, userID)
	if username != "alice" {
		t.Errorf("user_projection.username = %q after a redelivery of an already-consumed event; "+
			"want %q (the first delivery's value) — the pre-check should have skipped the write entirely, "+
			"not merely succeeded at overwriting it", username, "alice")
	}
}

func userProjectionUsername(t *testing.T, pool *pgxpool.Pool, userID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		t.Fatalf("set bypass: %v", err)
	}
	var username string
	if err := tx.QueryRow(ctx, `SELECT username FROM user_projection WHERE user_id = $1`, userID).Scan(&username); err != nil {
		t.Fatalf("read user_projection: %v", err)
	}
	return username
}

// ── purgeOrg: a blob-purge failure must also withhold the commit ─────────────
//
// fakeBlobStore implements blob.Store minimally: every method but RemoveOrg
// is unused by purgeOrg and panics if ever called, so a test relying on one
// of them fails loudly rather than silently exercising the wrong path.
type fakeBlobStore struct{ removeOrgErr error }

func (fakeBlobStore) WriteStream(string, io.Reader, int64) (string, int64, error) {
	panic("unused in this test")
}
func (fakeBlobStore) Open(string, string) (blob.Reader, error)     { panic("unused in this test") }
func (fakeBlobStore) Remove(string, string) error                  { panic("unused in this test") }
func (f fakeBlobStore) RemoveOrg(string) error                     { return f.removeOrgErr }
func (fakeBlobStore) RelPath(string, string) (string, error)       { panic("unused in this test") }
func (fakeBlobStore) CacheGet(string, string) (blob.Reader, error) { panic("unused in this test") }
func (fakeBlobStore) CachePut(string, string, io.Reader, int64) error {
	panic("unused in this test")
}
func (fakeBlobStore) OpenKey(string) (blob.Reader, error) { panic("unused in this test") }

func TestPurgeOrg_BlobFailure_ReturnsFalse(t *testing.T) {
	s, _ := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger(), blobs: fakeBlobStore{removeOrgErr: errors.New("disk unavailable")}}
	orgID := uuid.Must(uuid.NewV7()).String()

	payload, _ := json.Marshal(struct {
		Type  string `json:"type"`
		OrgID string `json:"orgId"`
	}{Type: events.TypeOrgDeleted, OrgID: orgID})

	if ok := c.handle(context.Background(), payload); ok {
		t.Fatal("purgeOrg reported success despite RemoveOrg failing; want false so a redelivery retries the blob sweep")
	}
}

// ── A recovered panic must also withhold the commit, not crash the process ───
func TestHandleSafely_RecoversPanicAndReturnsFalse(t *testing.T) {
	c := &AuthConsumer{store: nil, log: testLogger()} // nil store: UpsertUser dereferences it and panics
	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: uuid.Must(uuid.NewV7()).String(),
		UserID: uuid.Must(uuid.NewV7()).String(), OrgID: uuid.Must(uuid.NewV7()).String(),
		Username: "alice", DisplayName: "Alice",
	})

	ok := c.handleSafely(context.Background(), payload) // must not panic out of the test
	if ok {
		t.Fatal("handleSafely() = true after a panic; want false so Run withholds the commit")
	}
}

// ── Malformed payloads are a deliberate skip, not a failure ──────────────────
func TestHandle_MalformedJSON_ReturnsTrue(t *testing.T) {
	c := &AuthConsumer{store: nil, log: testLogger()} // never reached: bad JSON returns before any store call
	if ok := c.handle(context.Background(), []byte("not json")); !ok {
		t.Fatal("handle() = false for malformed JSON; want true (retrying can never fix a parse error)")
	}
}

// ── Same true/false contract, TaskProjectionConsumer side ────────────────────
func TestTaskHandle_WriteFails_LeavesEventUnconsumed(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &TaskProjectionConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()

	failWritesTransiently(t, verify, "inbox_items")
	payload, _ := json.Marshal(taskEvent{
		Type: typeTaskAssigned, EventID: eventID,
		OrgID: uuid.Must(uuid.NewV7()).String(), TaskID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: uuid.Must(uuid.NewV7()).String(), SenderID: uuid.Must(uuid.NewV7()).String(),
		Title: "t", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
	})

	if ok := c.handle(context.Background(), payload); ok {
		t.Fatal("handle() = true after a genuine store write failure; want false")
	}
	if bypassQueryExists(t, verify,
		`SELECT EXISTS (SELECT 1 FROM consumed_events_inbox_tasks WHERE event_id = $1)`, eventID) {
		t.Fatal("event was marked consumed despite the write failing")
	}
}

func TestTaskHandle_MalformedJSON_ReturnsTrue(t *testing.T) {
	c := &TaskProjectionConsumer{store: nil, log: testLogger()}
	if ok := c.handle(context.Background(), []byte("not json")); !ok {
		t.Fatal("handle() = false for malformed JSON; want true")
	}
}

func TestTaskHandleSafely_RecoversPanicAndReturnsFalse(t *testing.T) {
	c := &TaskProjectionConsumer{store: nil, log: testLogger()}
	payload, _ := json.Marshal(taskEvent{
		Type: typeTaskAssigned, EventID: uuid.Must(uuid.NewV7()).String(),
		OrgID: uuid.Must(uuid.NewV7()).String(), TaskID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: uuid.Must(uuid.NewV7()).String(),
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if ok := c.handleSafely(context.Background(), payload); ok {
		t.Fatal("handleSafely() = true after a panic; want false")
	}
}
