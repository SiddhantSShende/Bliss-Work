package consumer

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
	"github.com/task-board/notification-svc/internal/auth"
	"github.com/task-board/notification-svc/internal/db"
	"github.com/task-board/notification-svc/internal/events"
	"github.com/task-board/notification-svc/internal/httpapi"
)

// The notification feed is ONE table and ONE query, whatever produced the row. This
// drives every producer's event through the real consumer entry point (handle), then
// reads the result back through the real HTTP API with a real JWT — so the answer to
// "why only task notifications?" is checked on actual API data, not on SQL alone.
//
// What it pins: every kind arrives in the one newest-first feed, read and unread rows
// of different kinds coexist, and the task-scoped mark-read touches task rows only.

type feedEnv struct {
	pool  *pgxpool.Pool
	url   string
	orgID string
	sign  func(userID string) string
}

func newFeedEnv(t *testing.T) *feedEnv {
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
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubKey, _ := jwk.FromRaw(pub)
	_ = pubKey.Set(jwk.KeyIDKey, "k1")
	_ = pubKey.Set(jwk.AlgorithmKey, jwa.EdDSA)
	set := jwk.NewSet()
	_ = set.AddKey(pubKey)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(set) }))
	t.Cleanup(jwks.Close)
	verifier, err := auth.NewVerifier(ctx, jwks.URL, "feed-issuer")
	if err != nil {
		t.Fatal(err)
	}
	signKey, _ := jwk.FromRaw(priv)
	_ = signKey.Set(jwk.KeyIDKey, "k1")
	env := &feedEnv{pool: pool, orgID: uuid.NewString()}
	api := httptest.NewServer(httpapi.New(pool, verifier, "", slog.New(slog.NewTextHandler(io.Discard, nil))).Router())
	t.Cleanup(api.Close)
	env.url = api.URL
	env.sign = func(userID string) string {
		tok, _ := jwt.NewBuilder().Issuer("feed-issuer").Subject(userID).Expiration(time.Now().Add(time.Hour)).Claim("org_id", env.orgID).Build()
		signed, err := jwt.Sign(tok, jwt.WithKey(jwa.EdDSA, signKey))
		if err != nil {
			t.Fatal(err)
		}
		return string(signed)
	}
	return env
}

func (e *feedEnv) do(t *testing.T, token, method, path string, body any) (int, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, e.url+path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

type feedRow struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Text           string  `json:"text"`
	TaskID         *string `json:"taskId"`
	ChannelID      *string `json:"channelId"`
	ConversationID *string `json:"conversationId"`
	CallID         *string `json:"callId"`
	Read           bool    `json:"read"`
}

func (e *feedEnv) feed(t *testing.T, token, query string) []feedRow {
	t.Helper()
	status, raw := e.do(t, token, http.MethodGet, "/api/v1/notifications?limit=50"+query, nil)
	if status != http.StatusOK {
		t.Fatalf("GET notifications%s = %d %s", query, status, raw)
	}
	var page struct {
		Items      []feedRow `json:"items"`
		NextCursor *string   `json:"nextCursor"`
	}
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatalf("decode feed: %v (%s)", err, raw)
	}
	return page.Items
}

func (e *feedEnv) badge(t *testing.T, token string) int {
	t.Helper()
	_, raw := e.do(t, token, http.MethodGet, "/api/v1/notifications/unread-count", nil)
	var out struct {
		UnreadCount int `json:"unreadCount"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out.UnreadCount
}

func kindsOf(rows []feedRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Kind
	}
	return out
}

func TestGlobalFeedCarriesEveryProducersNotificationsInOneNewestFirstList(t *testing.T) {
	env := newFeedEnv(t)
	ctx := context.Background()
	me, other := uuid.NewString(), uuid.NewString()
	taskA, taskB := uuid.NewString(), uuid.NewString()
	channel, conversation, call, meeting := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	c := &Consumer{pool: env.pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	// One event per producer, in the order they "happen". Each is a separate
	// transaction, as in production, so created_at strictly increases.
	feedEvents := []struct {
		name string
		ev   any
	}{
		{"task.assigned", events.TaskEvent{Type: events.TypeTaskAssigned, EventID: uuid.NewString(), OrgID: env.orgID, TaskID: taskA, AssigneeID: me, SenderID: other, SenderUsername: "priya", Title: "Quarterly report"}},
		{"message.created", events.MessageCreated{Type: events.TypeMessageCreated, EventID: uuid.NewString(), OrgID: env.orgID, ConversationID: conversation, MessageID: uuid.NewString(), SenderID: other, RecipientID: me, Body: "Lunch at one?", SenderDisplayName: "Priya Shah"}},
		{"channel.message.created", events.ChannelMessageCreated{Type: events.TypeChannelMessageCreated, EventID: uuid.NewString(), OrgID: env.orgID, ChannelID: channel, MessageID: uuid.NewString(), SenderID: other, SenderUsername: "priya", SenderDisplayName: "Priya Shah", ChannelName: "design", Body: "Review is ready", Members: []string{other, me}}},
		{"channel.member.joined", events.ChannelMemberJoined{Type: events.TypeChannelMemberJoined, EventID: uuid.NewString(), OrgID: env.orgID, ChannelID: channel, ChannelName: "design", UserID: me, ActorID: other, ActorDisplayName: "Priya Shah"}},
		{"call.scheduled", events.CallLifecycle{Type: events.TypeCallScheduled, EventID: uuid.NewString(), OrgID: env.orgID, CallID: meeting, Kind: "MEETING", Title: "Sprint planning", ScheduledAt: "2026-10-06T09:00:00Z", ActorID: other, Members: []string{other, me}}},
		{"call.ring", events.CallLifecycle{Type: events.TypeCallRing, EventID: uuid.NewString(), OrgID: env.orgID, CallID: call, Kind: "DIRECT", Title: "Priya Shah", ActorID: other, Members: []string{other, me}}},
		{"task.completed", events.TaskEvent{Type: events.TypeTaskCompleted, EventID: uuid.NewString(), OrgID: env.orgID, TaskID: taskB, SenderID: me, AssigneeID: other, AssigneeUsername: "piyush"}},
	}
	for _, fe := range feedEvents {
		payload, _ := json.Marshal(fe.ev)
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.handle(ctx, tx, payload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("%s: handle: %v", fe.name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Adding a person to a call emits call.ring (to them) AND call.participant_added (to
	// the whole room). Only the ring is an invitation: the newcomer gets exactly one,
	// and someone already in the call gets none.
	roomMember, newcomer, addedCall := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, evType := range []string{events.TypeCallRing, events.TypeCallParticipantAdded} {
		members := []string{newcomer}
		if evType == events.TypeCallParticipantAdded {
			members = []string{other, roomMember, newcomer}
		}
		payload, _ := json.Marshal(events.CallLifecycle{Type: evType, EventID: uuid.NewString(), OrgID: env.orgID, CallID: addedCall, Kind: "MEETING", Title: "Ad hoc", ActorID: other, Members: members})
		tx, _ := env.pool.Begin(ctx)
		if err := c.handle(ctx, tx, payload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("%s: handle: %v", evType, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := env.feed(t, env.sign(newcomer), ""); len(got) != 1 || got[0].Kind != "MEETING_INVITATION" {
		t.Errorf("newcomer's feed = %v, want exactly one MEETING_INVITATION", kindsOf(got))
	}
	if got := env.feed(t, env.sign(roomMember), ""); len(got) != 0 {
		t.Errorf("someone already in the call was sent %v", kindsOf(got))
	}

	// A kind this build has no producer for — e.g. a newer service wrote it. It must
	// ride along in the feed untouched, not be filtered out by a whitelist.
	if _, err := env.pool.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text) VALUES ($1,$2,$3,'FUTURE_KIND','Something new happened')`,
		uuid.New(), env.orgID, me); err != nil {
		t.Fatal(err)
	}

	token := env.sign(me)
	want := []string{"FUTURE_KIND", "TASK_COMPLETED", "MEETING_INVITATION", "MEETING_SCHEDULED", "CHANNEL_ADDED", "CHANNEL_MESSAGE", "DM_MESSAGE", "TASK_ASSIGNED"}
	// newest first
	all := env.feed(t, token, "")
	if !slices.Equal(kindsOf(all), want) {
		t.Fatalf("feed kinds (newest first) = %v, want %v", kindsOf(all), want)
	}
	byKind := map[string]feedRow{}
	for _, r := range all {
		byKind[r.Kind] = r
		if r.Read {
			t.Errorf("%s arrived read", r.Kind)
		}
	}
	// Each category carries the ids its destination needs, from the real producers.
	if r := byKind["DM_MESSAGE"]; r.ConversationID == nil || *r.ConversationID != conversation || r.Text != "Priya Shah: Lunch at one?" {
		t.Errorf("DM row = %+v", r)
	}
	if r := byKind["CHANNEL_MESSAGE"]; r.ChannelID == nil || *r.ChannelID != channel {
		t.Errorf("channel message row = %+v", r)
	}
	if r := byKind["CHANNEL_ADDED"]; r.ChannelID == nil || *r.ChannelID != channel {
		t.Errorf("channel added row = %+v", r)
	}
	if r := byKind["MEETING_SCHEDULED"]; r.CallID == nil || *r.CallID != meeting {
		t.Errorf("meeting row = %+v", r)
	}
	if r := byKind["MEETING_INVITATION"]; r.CallID == nil || *r.CallID != call {
		t.Errorf("call-ring row = %+v (a ringing call is persisted as MEETING_INVITATION with its callId)", r)
	}
	if r := byKind["TASK_ASSIGNED"]; r.TaskID == nil || *r.TaskID != taskA {
		t.Errorf("task row = %+v", r)
	}
	if got := env.badge(t, token); got != len(want) {
		t.Errorf("badge = %d, want %d (every kind counts)", got, len(want))
	}
	// Another user's feed holds none of it.
	if rows := env.feed(t, env.sign(uuid.NewString()), ""); len(rows) != 0 {
		t.Errorf("a stranger sees %d rows", len(rows))
	}

	// Opening task A marks ONLY task A's notification read — not task B's, and not a
	// single chat / channel / call / meeting / unknown row.
	status, raw := env.do(t, token, http.MethodPost, "/api/v1/notifications/read-by-tasks", map[string]any{"taskIds": []string{taskA}})
	if status != http.StatusOK {
		t.Fatalf("read-by-tasks = %d %s", status, raw)
	}
	after := env.feed(t, token, "")
	if len(after) != len(want) {
		t.Fatalf("history lost rows: %d -> %d", len(want), len(after))
	}
	for _, r := range after {
		wantRead := r.Kind == "TASK_ASSIGNED"
		if r.Read != wantRead {
			t.Errorf("%s read=%v, want %v", r.Kind, r.Read, wantRead)
		}
	}
	if got := env.badge(t, token); got != len(want)-1 {
		t.Errorf("badge after opening the task = %d, want %d", got, len(want)-1)
	}
	// Read and unread rows of different kinds coexist, each in its own server filter.
	if got := kindsOf(env.feed(t, token, "&read=true")); !slices.Equal(got, []string{"TASK_ASSIGNED"}) {
		t.Errorf("read feed = %v", got)
	}
	if got := env.feed(t, token, "&read=false"); len(got) != len(want)-1 || slices.Contains(kindsOf(got), "TASK_ASSIGNED") {
		t.Errorf("unread feed = %v", kindsOf(got))
	}
}

// The meeting lifecycle, end to end through the real consumer and the real HTTP feed:
// an edit, a start and a cancellation each reach the people they concern as their own
// kind, in the same newest-first feed as everything else, without notifying whoever
// caused them, and an ordinary end of a meeting says nothing.
func TestMeetingLifecycleNotificationsReachTheFeed(t *testing.T) {
	env := newFeedEnv(t)
	ctx := context.Background()
	me, organiser := uuid.NewString(), uuid.NewString()
	meeting, cancelledMeeting := uuid.NewString(), uuid.NewString()
	c := &Consumer{pool: env.pool, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	both := []string{organiser, me}

	call := func(evType, callID, status, change, actor string) events.CallLifecycle {
		return events.CallLifecycle{Type: evType, EventID: uuid.NewString(), OrgID: env.orgID, CallID: callID,
			Kind: "MEETING", Title: "Sprint planning", ScheduledAt: "2026-10-06T09:00:00Z",
			Status: status, Change: change, ActorID: actor, Members: both}
	}
	for _, ev := range []events.CallLifecycle{
		call(events.TypeCallScheduled, meeting, "SCHEDULED", "", organiser),
		call(events.TypeCallScheduled, meeting, "SCHEDULED", events.CallChangeUpdated, organiser),
		call(events.TypeCallStarted, meeting, "LIVE", "", ""),       // the clock started it: nobody to exclude
		call(events.TypeCallEnded, meeting, "ENDED", "", organiser), // it took place: not news
		call(events.TypeCallEnded, cancelledMeeting, "CANCELLED", "", organiser),
	} {
		payload, _ := json.Marshal(ev)
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.handle(ctx, tx, payload); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("%s: handle: %v", ev.Type, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}

	token := env.sign(me)
	got := env.feed(t, token, "")
	want := []string{"MEETING_CANCELLED", "MEETING_STARTED", "MEETING_UPDATED", "MEETING_SCHEDULED"} // newest first
	if !slices.Equal(kindsOf(got), want) {
		t.Fatalf("feed kinds = %v, want %v (an ordinary end must not appear)", kindsOf(got), want)
	}
	byKind := map[string]feedRow{}
	for _, r := range got {
		byKind[r.Kind] = r
	}
	for _, k := range []string{"MEETING_SCHEDULED", "MEETING_UPDATED", "MEETING_STARTED"} {
		if r := byKind[k]; r.CallID == nil || *r.CallID != meeting {
			t.Errorf("%s row = %+v, want it to carry the meeting's id", k, r)
		}
	}
	// The cancelled meeting's rows are gone, so its notification leads to the list, not a dead id.
	if r := byKind["MEETING_CANCELLED"]; r.CallID != nil || r.Text != "Meeting cancelled: Sprint planning · 2026-10-06T09:00:00Z" {
		t.Errorf("cancelled row = %+v", r)
	}
	if r := byKind["MEETING_UPDATED"]; r.Text != "Meeting updated: Sprint planning · 2026-10-06T09:00:00Z" {
		t.Errorf("updated row text = %q", r.Text)
	}

	// The organiser caused the scheduling, the edit and the cancellation: they hear about
	// none of them. The clock started the meeting, so they are told that it began.
	if got := kindsOf(env.feed(t, env.sign(organiser), "")); !slices.Equal(got, []string{"MEETING_STARTED"}) {
		t.Errorf("the organiser's feed = %v, want only the start", got)
	}

	// Every kind counts toward the bell's badge.
	if got := env.badge(t, token); got != len(want) {
		t.Errorf("badge = %d, want %d", got, len(want))
	}

	// Read state works like any other kind: opening one flips only that row.
	cancelled := byKind["MEETING_CANCELLED"]
	if status, raw := env.do(t, token, http.MethodPost, "/api/v1/notifications/"+cancelled.ID+"/read", nil); status != http.StatusOK && status != http.StatusNoContent {
		t.Fatalf("mark read = %d %s", status, raw)
	}
	for _, r := range env.feed(t, token, "") {
		if wantRead := r.ID == cancelled.ID; r.Read != wantRead {
			t.Errorf("%s read=%v, want %v", r.Kind, r.Read, wantRead)
		}
	}
	if got := env.badge(t, token); got != len(want)-1 {
		t.Errorf("badge after opening one = %d, want %d", got, len(want)-1)
	}
}
