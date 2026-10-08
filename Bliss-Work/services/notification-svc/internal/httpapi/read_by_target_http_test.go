package httpapi

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/task-board/notification-svc/internal/events"
)

// seedTargeted inserts a notification pointing at a conversation, a channel or a
// call (any may be nil), the three things read-by-target can scope to.
func (e *testEnv) seedTargeted(t *testing.T, userID, text, kind string, conversationID, channelID, callID *string, read bool, at time.Time) string {
	t.Helper()
	id := uuid.NewString()
	var readAt any
	if read {
		readAt = at
	}
	if _, err := e.pool.Exec(context.Background(),
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text, conversation_id, channel_id, call_id, read_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		id, e.orgID, userID, kind, text, conversationID, channelID, callID, readAt, at); err != nil {
		t.Fatalf("seed notification %q: %v", text, err)
	}
	return id
}

// Opening ONE chat, channel or meeting reads that one's notifications and nothing
// else: not another conversation, channel or meeting, not a task, not somebody
// else's copy, and not rows that were already read.
func TestReadByTargetMarksOnlyThatTargetsNotifications(t *testing.T) {
	env := newTestEnv(t)
	me, other := uuid.NewString(), uuid.NewString()
	convA, convB := uuid.NewString(), uuid.NewString()
	chanA, chanB := uuid.NewString(), uuid.NewString()
	callA, callB := uuid.NewString(), uuid.NewString()
	taskA := uuid.NewString()
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return base.Add(time.Duration(m) * time.Minute) }

	seed := func(user, text, kind string, conv, ch, call *string, read bool, m int) string {
		return env.seedTargeted(t, user, text, kind, conv, ch, call, read, at(m))
	}

	dmA1 := seed(me, "dmA1", events.KindDMMessage, &convA, nil, nil, false, 1)
	dmA2 := seed(me, "dmA2", events.KindDMMessage, &convA, nil, nil, false, 2)
	seed(me, "dmA-old-read", events.KindDMMessage, &convA, nil, nil, true, -60)
	seed(me, "dmB", events.KindDMMessage, &convB, nil, nil, false, 3)
	seed(other, "dmA-someone-elses", events.KindDMMessage, &convA, nil, nil, false, 4)

	chMsg := seed(me, "chA-msg", events.KindChannelMessage, nil, &chanA, nil, false, 5)
	chAdd := seed(me, "chA-added", events.KindChannelAdded, nil, &chanA, nil, false, 6)
	chNew := seed(me, "chA-created", events.KindChannelCreated, nil, &chanA, nil, false, 7)
	seed(me, "chB-msg", events.KindChannelMessage, nil, &chanB, nil, false, 8)

	mtgInv := seed(me, "mtgA-invite", events.KindMeetingInvite, nil, nil, &callA, false, 9)
	mtgStart := seed(me, "mtgA-started", events.KindMeetingStarted, nil, nil, &callA, false, 10)
	seed(me, "mtgB-invite", events.KindMeetingInvite, nil, nil, &callB, false, 11)
	// A cancellation carries no call id, so there is nothing to scope it by.
	seed(me, "mtg-cancelled", events.KindMeetingCancelled, nil, nil, nil, false, 12)

	env.seedTask(t, me, "task", &taskA, false, at(13))

	c := stateClient{t, env, env.sign(me)}
	if n := c.count(); n != 12 {
		t.Fatalf("setup: badge = %d, want 12", n)
	}

	steps := []struct {
		name    string
		body    map[string]any
		flipped []string
		badge   int // unread left after this step
	}{
		{"chat", map[string]any{"conversationId": convA}, []string{dmA1, dmA2}, 10},
		{"channel", map[string]any{"channelId": chanA}, []string{chMsg, chAdd, chNew}, 7},
		{"meeting", map[string]any{"callId": callA}, []string{mtgInv, mtgStart}, 5},
	}
	var allFlipped []string
	for _, st := range steps {
		status, body := c.do(http.MethodPost, "/read-by-target", st.body)
		wantUpdated := `"updated":` + string(rune('0'+len(st.flipped)))
		if status != http.StatusOK || !strings.Contains(string(body), wantUpdated) {
			t.Fatalf("%s: read-by-target = %d %s, want 200 %s", st.name, status, body, wantUpdated)
		}
		if n := c.count(); n != st.badge {
			t.Errorf("%s: badge = %d, want %d", st.name, n, st.badge)
		}
		allFlipped = append(allFlipped, st.flipped...)
	}

	// What is left unread is exactly the rows that belong to no opened target.
	want := map[string]bool{
		"dmA1": true, "dmA2": true, "dmA-old-read": true, "dmB": false,
		"chA-msg": true, "chA-added": true, "chA-created": true, "chB-msg": false,
		"mtgA-invite": true, "mtgA-started": true, "mtgB-invite": false, "mtg-cancelled": false,
		"task": false,
	}
	if got := states(c.history()); !mapsEqual(got, want) {
		t.Errorf("history = %v, want %v", got, want)
	}
	// Nothing left the history, and another user's copy for the same chat is not ours.
	if n := (stateClient{t, env, env.sign(other)}).count(); n != 1 {
		t.Errorf("other user's badge = %d, want 1", n)
	}

	// Every session hears about exactly the rows that changed, each by id — an
	// event with no id would tell other sessions to mark everything read.
	got := env.readEventIDs(t, me)
	slices.Sort(got)
	slices.Sort(allFlipped)
	if !slices.Equal(got, allFlipped) {
		t.Errorf("notification.read events = %v, want one per changed row %v", got, allFlipped)
	}

	// Idempotent: reopening reads nothing and announces nothing.
	status, body := c.do(http.MethodPost, "/read-by-target", map[string]any{"conversationId": convA})
	if status != http.StatusOK || !strings.Contains(string(body), `"updated":0`) {
		t.Errorf("repeat = %d %s, want 200 updated 0", status, body)
	}
	if n := len(env.readEventIDs(t, me)); n != len(allFlipped) {
		t.Errorf("events after repeat = %d, want still %d", n, len(allFlipped))
	}
}

// A target nobody has notifications for is a quiet no-op, not an error: every
// time a chat is opened this is asked, and most of the time there is nothing.
func TestReadByTargetWithNothingToReadIsANoop(t *testing.T) {
	env := newTestEnv(t)
	me := uuid.NewString()
	env.seedTask(t, me, "unrelated", nil, false, time.Now().UTC())
	c := stateClient{t, env, env.sign(me)}

	for _, key := range []string{"conversationId", "channelId", "callId"} {
		status, body := c.do(http.MethodPost, "/read-by-target", map[string]any{key: uuid.NewString()})
		if status != http.StatusOK || !strings.Contains(string(body), `"updated":0`) {
			t.Errorf("%s: %d %s, want 200 updated 0", key, status, body)
		}
	}
	if n := c.count(); n != 1 {
		t.Errorf("badge = %d, want 1 (an unrelated unread must survive)", n)
	}
}

// Exactly one target, always: zero or several would turn this into a read-all or
// an ambiguous request, and neither is something the bell is allowed to do.
func TestReadByTargetValidatesItsInput(t *testing.T) {
	env := newTestEnv(t)
	me := uuid.NewString()
	env.seedTargeted(t, me, "dm", events.KindDMMessage, ptr(uuid.NewString()), nil, nil, false, time.Now().UTC())
	c := stateClient{t, env, env.sign(me)}

	cases := []struct {
		name string
		body any
		want int
	}{
		{"no target", map[string]any{}, http.StatusBadRequest},
		{"null target", map[string]any{"conversationId": nil}, http.StatusBadRequest},
		{"two targets", map[string]any{"conversationId": uuid.NewString(), "channelId": uuid.NewString()}, http.StatusBadRequest},
		{"three targets", map[string]any{"conversationId": uuid.NewString(), "channelId": uuid.NewString(), "callId": uuid.NewString()}, http.StatusBadRequest},
		{"not a uuid", map[string]any{"channelId": "nope"}, http.StatusBadRequest},
		{"empty string", map[string]any{"callId": ""}, http.StatusBadRequest},
		{"task ids are not accepted here", map[string]any{"taskIds": []string{uuid.NewString()}}, http.StatusBadRequest},
		{"not json", "{", http.StatusBadRequest},
	}
	for _, tc := range cases {
		var status int
		if s, ok := tc.body.(string); ok {
			req, _ := http.NewRequest(http.MethodPost, env.url+"/api/v1/notifications/read-by-target", strings.NewReader(s))
			req.Header.Set("Authorization", "Bearer "+c.token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			status = resp.StatusCode
		} else {
			status, _ = c.do(http.MethodPost, "/read-by-target", tc.body)
		}
		if status != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, status, tc.want)
		}
	}
	// Every rejected request left the unread row alone.
	if n := c.count(); n != 1 {
		t.Errorf("badge = %d after rejected requests, want 1", n)
	}

	unauth := stateClient{t, env, "not-a-token"}
	if status, _ := unauth.do(http.MethodPost, "/read-by-target", map[string]any{"callId": uuid.NewString()}); status != http.StatusUnauthorized {
		t.Errorf("bad token = %d, want 401", status)
	}
}

func ptr(s string) *string { return &s }
