package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"

	"github.com/task-board/notification-svc/internal/events"
)

// mustMarshal JSON-encodes v or fails the test.
func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// newTestConsumer builds a Consumer with a NIL pool and no kafka wiring. This is
// only safe for handle() inputs that return BEFORE the first DB access
// (c.pool.Begin). For those inputs the nil pool is never dereferenced. A logger
// is required because handle() logs on the early-return paths.
func newTestConsumer() *Consumer {
	return &Consumer{
		pool: nil,
		log:  slog.New(slog.DiscardHandler),
	}
}

// callHandle invokes handle and reports whether it reached the DB. The only DB
// access in handle() is c.pool.Begin on a nil pool, which nil-derefs and panics.
// So a recovered panic means "routing classified this event as something that
// gets persisted" (acknowledged/completed with a valid eventId); no panic means
// the call returned a Go error before any DB use.
func callHandle(c *Consumer, value []byte) (err error, reachedDB bool) {
	defer func() {
		if rec := recover(); rec != nil {
			reachedDB = true
		}
	}()
	err = c.handle(context.Background(), value)
	return err, false
}

// TestHandle_MalformedPayload_ReturnsErrMalformed covers the poison-pill
// classification: unparseable JSON must map to errMalformed (the only error that
// routes to the DLQ + commit) and must do so before touching the DB. errMalformed
// is the contract runOnce switches on, so this guards the dead-letter path.
func TestHandle_MalformedPayload_ReturnsErrMalformed(t *testing.T) {
	c := newTestConsumer()

	cases := []struct {
		name  string
		value []byte
	}{
		{"not json", []byte("this is not json")},
		{"truncated object", []byte(`{"type":`)},
		{"bare bytes", []byte{0x00, 0x01, 0x02}},
		{"empty", []byte("")},
		{"nil", nil},
		{"json array not object", []byte(`["task.acknowledged"]`)},
		{"wrong field type", []byte(`{"type": 12345}`)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err, reachedDB := callHandle(c, tc.value)
			if reachedDB {
				t.Fatalf("handle reached the DB on malformed input; want early errMalformed return")
			}
			if !errors.Is(err, errMalformed) {
				t.Fatalf("got err %v, want errMalformed", err)
			}
		})
	}
}

// TestHandle_EventTypeRouting covers the type discriminant switch. Acknowledged
// and completed events are projected into notifications (so with a valid eventId
// they proceed to the DB), while every other type is ignored (returns nil before
// any DB use). All inputs here use valid JSON so unmarshal succeeds and only the
// routing decision is under test.
func TestHandle_EventTypeRouting(t *testing.T) {
	c := newTestConsumer()

	// validEventID is a well-formed UUID so uuid.Parse succeeds and the
	// acknowledged/completed paths fall through to c.pool.Begin (the DB).
	const validEventID = "11111111-1111-1111-1111-111111111111"

	cases := []struct {
		name          string
		typ           string
		wantReachedDB bool // true => classified as a persisted notification kind
	}{
		{"acknowledged is projected", events.TypeTaskAcknowledged, true},
		{"completed is projected", events.TypeTaskCompleted, true},
		{"created is ignored", events.TypeNotificationCreated, false},
		{"unknown type is ignored", "task.something.else", false},
		{"empty type is ignored", "", false},
		{"case sensitive: uppercase ignored", "TASK.ACKNOWLEDGED", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := events.TaskEvent{
				Type:             tc.typ,
				EventID:          validEventID,
				OrgID:            "org-1",
				SenderID:         "user-1",
				AssigneeUsername: "alice",
			}
			value := mustMarshal(t, ev)

			err, reachedDB := callHandle(c, value)

			if reachedDB != tc.wantReachedDB {
				t.Fatalf("reachedDB = %v, want %v (type %q)", reachedDB, tc.wantReachedDB, tc.typ)
			}
			if !tc.wantReachedDB {
				// Ignored types must return nil (not errMalformed, not transient).
				if err != nil {
					t.Fatalf("ignored type %q returned err %v, want nil", tc.typ, err)
				}
			}
		})
	}
}

// TestHandle_InvalidEventID_IgnoredBeforeDB covers the guard between routing and
// persistence: an acknowledged/completed event whose eventId is not a UUID is
// skipped (returns nil) BEFORE c.pool.Begin, so a single bad id cannot wedge the
// partition. This is why the routing test above must use a valid UUID to reach
// the DB.
func TestHandle_InvalidEventID_IgnoredBeforeDB(t *testing.T) {
	c := newTestConsumer()

	cases := []struct {
		name string
		typ  string
		id   string
	}{
		{"acknowledged empty id", events.TypeTaskAcknowledged, ""},
		{"acknowledged garbage id", events.TypeTaskAcknowledged, "not-a-uuid"},
		{"completed garbage id", events.TypeTaskCompleted, "12345"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := events.TaskEvent{Type: tc.typ, EventID: tc.id, OrgID: "org-1", SenderID: "user-1"}
			value := mustMarshal(t, ev)

			err, reachedDB := callHandle(c, value)
			if reachedDB {
				t.Fatalf("invalid eventId reached the DB; want early nil return")
			}
			if err != nil {
				t.Fatalf("got err %v, want nil for invalid eventId", err)
			}
		})
	}
}
