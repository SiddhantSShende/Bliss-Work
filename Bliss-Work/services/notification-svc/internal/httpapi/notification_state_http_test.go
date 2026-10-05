package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/events"
)

// stateClient drives the real HTTP API as one user: the same calls the bell
// (count), the panel (list) and the mark-read actions make.
type stateClient struct {
	t     *testing.T
	env   *testEnv
	token string
}

func (c stateClient) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, c.env.url+"/api/v1/notifications"+path, rd)
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

func (c stateClient) count() int {
	c.t.Helper()
	status, body := c.do(http.MethodGet, "/unread-count", nil)
	if status != http.StatusOK {
		c.t.Fatalf("unread-count = %d", status)
	}
	var out unreadCountDTO
	_ = json.Unmarshal(body, &out)
	return int(out.UnreadCount)
}

// history is the panel's feed: every notification, no read filter, newest first.
func (c stateClient) history() []notificationDTO {
	c.t.Helper()
	status, body := c.do(http.MethodGet, "?limit=50", nil)
	if status != http.StatusOK {
		c.t.Fatalf("list = %d", status)
	}
	var page notificationPageDTO
	_ = json.Unmarshal(body, &page)
	return page.Items
}

func states(items []notificationDTO) map[string]bool {
	out := map[string]bool{}
	for _, n := range items {
		out[n.Text] = n.Read
	}
	return out
}

func (e *testEnv) seedTask(t *testing.T, userID, text string, taskID *string, read bool, at time.Time) string {
	t.Helper()
	id := uuid.NewString()
	var readAt any
	if read {
		readAt = at
	}
	if _, err := e.pool.Exec(context.Background(),
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text, task_id, read_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, e.orgID, userID, events.KindTaskAssigned, text, taskID, readAt, at); err != nil {
		t.Fatalf("seed notification %q: %v", text, err)
	}
	return id
}

func (e *testEnv) readEventIDs(t *testing.T, userID string) []string {
	t.Helper()
	rows, err := e.pool.Query(context.Background(),
		`SELECT payload->>'notificationId' FROM outbox
		  WHERE kafka_key = $1 AND payload->>'type' = $2 ORDER BY id`, userID, events.TypeNotificationRead)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id *string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		if id != nil {
			ids = append(ids, *id)
		}
	}
	return ids
}

// The bell is the unread count and the panel is the list; both come from the one
// notifications table, and READING a notification only changes its state. The
// badge falls, the row stays in the history.
func TestBadgeAndHistoryAgreeThroughTheWholeReadLifecycle(t *testing.T) {
	env := newTestEnv(t)
	me := uuid.NewString()
	c := stateClient{t, env, env.sign(me)}
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	// A truly empty account: no badge, and nothing in the history.
	if n := c.count(); n != 0 {
		t.Fatalf("empty account badge = %d, want 0", n)
	}
	if h := c.history(); len(h) != 0 {
		t.Fatalf("empty account history = %v, want none", h)
	}

	// Three notifications — one of them old and already read.
	first := env.seedTask(t, me, "first", nil, false, base.Add(3*time.Minute))
	env.seedTask(t, me, "second", nil, false, base.Add(2*time.Minute))
	env.seedTask(t, me, "old-read", nil, true, base.Add(-48*time.Hour))

	if n := c.count(); n != 2 {
		t.Fatalf("badge = %d, want 2 (the read one does not count)", n)
	}
	want := map[string]bool{"first": false, "second": false, "old-read": true}
	if got := states(c.history()); !mapsEqual(got, want) {
		t.Fatalf("history = %v, want %v — every notification, old/read included", got, want)
	}

	// Mark one read: the badge drops by one, the row is still there, now read.
	if status, _ := c.do(http.MethodPost, "/"+first+"/read", nil); status != http.StatusNoContent {
		t.Fatalf("mark read = %d", status)
	}
	if n := c.count(); n != 1 {
		t.Errorf("badge after one read = %d, want 1", n)
	}
	want["first"] = true
	if got := states(c.history()); !mapsEqual(got, want) {
		t.Errorf("history after one read = %v, want %v", got, want)
	}

	// Mark all read: no badge, every row still in the history.
	if status, _ := c.do(http.MethodPost, "/read-all", nil); status != http.StatusNoContent {
		t.Fatalf("read-all = %d", status)
	}
	if n := c.count(); n != 0 {
		t.Errorf("badge after read-all = %d, want 0", n)
	}
	want["second"] = true
	if got := states(c.history()); !mapsEqual(got, want) {
		t.Errorf("history after read-all = %v, want %v — read-all must not delete anything", got, want)
	}
}

func mapsEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

// Viewing tasks reads THEIR notifications and nothing else.
func TestReadByTasksMarksOnlyTheNamedTasksNotifications(t *testing.T) {
	env := newTestEnv(t)
	me, other := uuid.NewString(), uuid.NewString()
	taskA, taskB := uuid.NewString(), uuid.NewString()
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	c := stateClient{t, env, env.sign(me)}

	a1 := env.seedTask(t, me, "a1", &taskA, false, base.Add(1*time.Minute))
	a2 := env.seedTask(t, me, "a2", &taskA, false, base.Add(2*time.Minute))
	env.seedTask(t, me, "a-old-read", &taskA, true, base.Add(-time.Hour))
	env.seedTask(t, me, "b1", &taskB, false, base.Add(3*time.Minute))
	env.seedTask(t, me, "no-task", nil, false, base.Add(4*time.Minute))
	env.seedTask(t, other, "someone-elses", &taskA, false, base.Add(5*time.Minute))

	status, body := c.do(http.MethodPost, "/read-by-tasks", map[string]any{"taskIds": []string{taskA}})
	if status != http.StatusOK || !strings.Contains(string(body), `"updated":2`) {
		t.Fatalf("read-by-tasks = %d %s, want 200 updated 2", status, body)
	}

	// The badge keeps the unrelated unread notifications...
	if n := c.count(); n != 2 {
		t.Errorf("badge = %d, want 2 (task B and the task-less one stay unread)", n)
	}
	// ...and nothing left the history.
	want := map[string]bool{"a1": true, "a2": true, "a-old-read": true, "b1": false, "no-task": false}
	if got := states(c.history()); !mapsEqual(got, want) {
		t.Errorf("history = %v, want %v", got, want)
	}
	// Another user's notification for the same task is not ours to read.
	if n := (stateClient{t, env, env.sign(other)}).count(); n != 1 {
		t.Errorf("other user's badge = %d, want 1", n)
	}

	// Every session hears about exactly the rows that changed, by id — an event
	// with no id would tell other sessions to mark everything read.
	got := env.readEventIDs(t, me)
	slices.Sort(got)
	wantIDs := []string{a1, a2}
	slices.Sort(wantIDs)
	if !slices.Equal(got, wantIDs) {
		t.Errorf("notification.read events = %v, want one per changed row %v", got, wantIDs)
	}

	// Idempotent: nothing left to change, no new events.
	status, body = c.do(http.MethodPost, "/read-by-tasks", map[string]any{"taskIds": []string{taskA}})
	if status != http.StatusOK || !strings.Contains(string(body), `"updated":0`) {
		t.Errorf("repeat = %d %s, want 200 updated 0", status, body)
	}
	if n := len(env.readEventIDs(t, me)); n != 2 {
		t.Errorf("events after repeat = %d, want still 2", n)
	}
}

func TestReadByTasksValidatesItsInput(t *testing.T) {
	env := newTestEnv(t)
	c := stateClient{t, env, env.sign(uuid.NewString())}

	tooMany := make([]string, maxReadByTasks+1)
	for i := range tooMany {
		tooMany[i] = uuid.NewString()
	}
	cases := []struct {
		name string
		body any
		want int
	}{
		{"empty list is a no-op", map[string]any{"taskIds": []string{}}, http.StatusOK},
		{"missing list is a no-op", map[string]any{}, http.StatusOK},
		{"not a uuid", map[string]any{"taskIds": []string{"nope"}}, http.StatusBadRequest},
		{"too many ids", map[string]any{"taskIds": tooMany}, http.StatusBadRequest},
		{"not json", "{", http.StatusBadRequest},
	}
	for _, tc := range cases {
		var status int
		if s, ok := tc.body.(string); ok {
			req, _ := http.NewRequest(http.MethodPost, env.url+"/api/v1/notifications/read-by-tasks", strings.NewReader(s))
			req.Header.Set("Authorization", "Bearer "+c.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			status = resp.StatusCode
		} else {
			status, _ = c.do(http.MethodPost, "/read-by-tasks", tc.body)
		}
		if status != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, status, tc.want)
		}
	}

	unauth := stateClient{t, env, "not-a-token"}
	if status, _ := unauth.do(http.MethodPost, "/read-by-tasks", map[string]any{"taskIds": []string{uuid.NewString()}}); status != http.StatusUnauthorized {
		t.Errorf("bad token = %d, want 401", status)
	}
}
