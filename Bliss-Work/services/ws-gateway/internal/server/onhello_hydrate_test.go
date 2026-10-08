package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/contract"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/hydrate"
)

// When the hydrate call fails, the connect-time replay must NOT complete: no
// replay.done, no partial burst. It used to drop the unresolved message.created
// entries and send replay.done anyway, and the client's cursor then advanced past
// them for good. Real Redis (see newTestStore); skips when unreachable.

type hydrateReplayResult struct {
	frames []map[string]any
	conn   *hub.Conn
}

func runOnHello(t *testing.T, hydrateHandler http.HandlerFunc) hydrateReplayResult {
	t.Helper()
	st := newTestStore(t)
	srv := httptest.NewServer(hydrateHandler)
	defer srv.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	userID := uuid.NewString()
	ref := contract.TryCompact(&contract.Event{
		Type: "message.created", EventID: uuid.NewString(), MessageID: uuid.NewString(),
	}, nil)
	plain := []byte(`{"type":"task.assigned","eventId":"` + uuid.NewString() + `","occurredAt":"2026-10-07T09:00:00Z"}`)
	now := time.Now().UnixMilli()
	for i, raw := range [][]byte{plain, ref} {
		if err := st.AppendOutbox(context.Background(), userID, now+int64(i), raw); err != nil {
			t.Fatalf("seed outbox: %v", err)
		}
	}

	s := &Server{
		store:    st,
		hub:      hub.New(),
		hydrator: hydrate.New(srv.URL, "", log),
		log:      log,
	}
	conn := hub.NewConn(userID, uuid.NewString(), "")
	sess := &session{}
	sess.claims.Store(&auth.Claims{UserID: userID, OrgID: uuid.NewString()})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.onHello(ctx, conn, sess, nil)

	res := hydrateReplayResult{conn: conn}
	for {
		select {
		case raw := <-conn.Send:
			var f map[string]any
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("frame is not JSON: %v", err)
			}
			res.frames = append(res.frames, f)
		default:
			return res
		}
	}
}

func (r hydrateReplayResult) has(typ string) bool {
	for _, f := range r.frames {
		if f["type"] == typ {
			return true
		}
	}
	return false
}

func TestOnHello_HydrateFailureClosesTheSocketInsteadOfFinishingReplay(t *testing.T) {
	var calls atomic.Int32
	res := runOnHello(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "down", http.StatusServiceUnavailable)
	})

	if res.has("replay.done") {
		t.Fatal("replay.done was sent after the hydrate call failed: the client would treat the burst as complete and its cursor would skip the missing messages")
	}
	if res.has("task.assigned") {
		t.Error("a partial replay burst was delivered; the client cursor would advance past the entries that were withheld")
	}
	select {
	case <-res.conn.Done:
	default:
		t.Fatal("socket was left open; the client has no signal to reconnect and retry the replay")
	}
	if got := res.conn.CloseReason(); got != "replay unavailable" {
		t.Errorf("close reason = %q, want %q", got, "replay unavailable")
	}
	if calls.Load() < 2 {
		t.Errorf("hydrate called %d time(s); expected bounded retries before giving up", calls.Load())
	}
}

func TestOnHello_TransientHydrateFailureIsRetriedAndReplayCompletes(t *testing.T) {
	var calls atomic.Int32
	res := runOnHello(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "blip", http.StatusBadGateway)
			return
		}
		var req struct {
			MessageIDs []string `json:"messageIds"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		out := map[string]any{}
		for _, id := range req.MessageIDs {
			out[id] = map[string]any{
				"messageId": id, "orgId": uuid.NewString(), "clientMsgId": uuid.NewString(),
				"conversationId": uuid.NewString(), "seq": 1, "senderId": uuid.NewString(),
				"recipientId": uuid.NewString(), "body": "hi", "occurredAt": "2026-10-07T09:00:00Z",
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	})

	if !res.has("replay.done") || !res.has("message.created") || !res.has("task.assigned") {
		t.Fatalf("replay incomplete after a transient hydrate failure: %v", res.frames)
	}
	select {
	case <-res.conn.Done:
		t.Fatal("socket closed although the retry succeeded")
	default:
	}
}
