package kafka

// B-MSG-3, against a real Postgres: an event that can NEVER succeed (a bad
// uuid, unparseable JSON) is skipped with an ERROR log and a counter and does
// not stall its partition; an event that fails for a reason a retry can cure
// (here a 40001 serialization failure standing in for any outage) is NEVER
// reported done, however long it takes. See consumer_handle_db_test.go for the
// harness.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/metrics"
)

// failWritesTransiently makes every INSERT/UPDATE on table fail with SQLSTATE
// 40001 (a transient, retryable class) until the returned func — or test
// cleanup — drops the trigger.
func failWritesTransiently(t *testing.T, pool *pgxpool.Pool, table string) (drop func()) {
	t.Helper()
	ctx := context.Background()
	fn := "bw_fail_" + table
	for _, q := range []string{
		fmt.Sprintf(`CREATE OR REPLACE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'simulated outage' USING ERRCODE = '40001'; END $$`, fn),
		fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION %s()`, fn, table, fn),
	} {
		if err := bypassExec(ctx, pool, q); err != nil {
			t.Fatalf("install failing trigger on %s: %v", table, err)
		}
	}
	drop = func() {
		_ = bypassExec(context.Background(), pool, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON %s`, fn, table))
	}
	t.Cleanup(drop)
	return drop
}

func skipped(consumer, reason string) float64 {
	return testutil.ToFloat64(metrics.ConsumerEventsSkippedTotal.WithLabelValues(consumer, reason))
}

func TestHandle_PermanentDBError_IsSkippedCountedAndNeverClaimed(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()
	userID := uuid.Must(uuid.NewV7()).String()
	before := skipped("auth", "permanent_db")

	// org_id is not a uuid: UpsertUser fails with 22P02 on every delivery.
	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: userID, OrgID: "not-a-uuid", Username: "alice", DisplayName: "Alice",
	})
	if ok := c.handle(context.Background(), payload); !ok {
		t.Fatal("handle() = false for an event the database rejects permanently; it would be retried forever and stall the partition")
	}
	if got := skipped("auth", "permanent_db") - before; got != 1 {
		t.Fatalf("permanent_db skip counter moved by %v, want 1: a dropped event must be visible", got)
	}
	if bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM consumed_events WHERE event_id = $1)`, eventID) {
		t.Fatal("a skipped event must not be recorded as consumed")
	}
	if bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM user_projection WHERE user_id = $1)`, userID) {
		t.Fatal("a rejected write left a projection row")
	}
}

func TestHandle_PermanentDBErrorOnOrgDeleted_IsSkipped(t *testing.T) {
	s, _ := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger(), blobs: fakeBlobStore{}}
	before := skipped("auth", "permanent_db")
	payload, _ := json.Marshal(struct {
		Type  string `json:"type"`
		OrgID string `json:"orgId"`
	}{Type: events.TypeOrgDeleted, OrgID: "not-a-uuid"})

	if ok := c.handle(context.Background(), payload); !ok {
		t.Fatal("org.deleted with an unusable orgId must be skipped, not retried forever")
	}
	if got := skipped("auth", "permanent_db") - before; got != 1 {
		t.Fatalf("skip counter moved by %v, want 1", got)
	}
}

func TestTaskHandle_PermanentDBError_IsSkippedAndCounted(t *testing.T) {
	s, verify := handleTestStore(t)
	c := &TaskProjectionConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()
	before := skipped("task_projector", "permanent_db")

	payload, _ := json.Marshal(taskEvent{
		Type: typeTaskAssigned, EventID: eventID,
		OrgID: "not-a-uuid", TaskID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: uuid.Must(uuid.NewV7()).String(), SenderID: uuid.Must(uuid.NewV7()).String(),
		Title: "t", OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if ok := c.handle(context.Background(), payload); !ok {
		t.Fatal("handle() = false for a permanently rejected task event; it would wedge the partition")
	}
	if got := skipped("task_projector", "permanent_db") - before; got != 1 {
		t.Fatalf("skip counter moved by %v, want 1", got)
	}
	if bypassQueryExists(t, verify,
		`SELECT EXISTS (SELECT 1 FROM consumed_events_inbox_tasks WHERE event_id = $1)`, eventID) {
		t.Fatal("a skipped event must not be recorded as consumed")
	}
}

func TestHandle_MalformedJSON_IsCountedAsASkip(t *testing.T) {
	c := &AuthConsumer{store: nil, log: testLogger()}
	before := skipped("auth", "malformed")
	if ok := c.handle(context.Background(), []byte("not json")); !ok {
		t.Fatal("malformed JSON must be skipped")
	}
	if got := skipped("auth", "malformed") - before; got != 1 {
		t.Fatalf("malformed skip counter moved by %v, want 1", got)
	}
}

// The scenario B-MSG-3 is about, end to end through the retry helper and the
// real handler: the database is down (every write fails transiently) for far
// more attempts than the old cap of 8, then recovers. The event must still be
// applied — before the fix the helper reported it done on attempt 8 and the
// user never reached user_projection.
func TestUserCreated_SurvivesAnOutageLongerThanTheOldRetryCap(t *testing.T) {
	fastBackoff(t)
	s, verify := handleTestStore(t)
	c := &AuthConsumer{store: s, log: testLogger()}
	eventID := uuid.Must(uuid.NewV7()).String()
	userID := uuid.Must(uuid.NewV7()).String()
	before := skipped("auth", "permanent_db") + skipped("auth", "malformed")

	payload, _ := json.Marshal(events.UserCreated{
		Type: events.TypeUserCreated, EventID: eventID,
		UserID: userID, OrgID: uuid.Must(uuid.NewV7()).String(), Username: "alice", DisplayName: "Alice",
	})
	dropTrigger := failWritesTransiently(t, verify, "user_projection")

	attempts := 0
	ok := handleWithRetry(context.Background(), testLogger(), "auth consumer", kafka.Message{Topic: "auth.events"},
		func(ctx context.Context) bool {
			attempts++
			if attempts == 25 { // the outage ends before this, the 25th, attempt (24 failed ones)
				dropTrigger()
			}
			return c.handleSafely(ctx, payload)
		})

	if !ok || attempts != 25 {
		t.Fatalf("ok=%v after %d attempts, want true on attempt 25 (24 failures, well past the old cap of 8)", ok, attempts)
	}
	if !bypassQueryExists(t, verify, `SELECT EXISTS (SELECT 1 FROM user_projection WHERE user_id = $1)`, userID) {
		t.Fatal("the event was committed past without ever being applied")
	}
	if got := skipped("auth", "permanent_db") + skipped("auth", "malformed") - before; got != 0 {
		t.Fatalf("a transient outage was counted as %v skipped event(s)", got)
	}
}

// Shutdown must stay responsive while retrying an unbounded failure.
func TestHandleWithRetry_StopsPromptlyOnShutdownDuringALongOutage(t *testing.T) {
	fastBackoff(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() {
		done <- handleWithRetry(ctx, testLogger(), "t", testMsg, func(context.Context) bool { return false })
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("reported done on shutdown: the offset would be committed past an unprocessed message")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not stop after the context was cancelled")
	}
}
