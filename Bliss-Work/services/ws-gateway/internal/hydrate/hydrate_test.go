package hydrate

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

	"github.com/task-board/shared-backoff"
	"github.com/task-board/ws-gateway/internal/contract"
)

// The frame Hydrate rebuilds is what a reconnecting client replays. The client
// validates every frame against its ServerEvent schema and DROPS any that fail,
// so a rebuilt message.created missing a field the schema requires vanishes from
// replay: every chat message received while disconnected, silently gone.
//
// requiredByClient is that schema's message.created field set (packages/shared/
// src/types/events.ts: the envelope's eventId/orgId/occurredAt, plus the
// MessageCreated object's own required fields). orgId and clientMsgId were the
// two the rebuilt frame lacked, on the belief that no client used them.
var requiredByClient = []string{
	"type", "eventId", "orgId", "occurredAt",
	"conversationId", "messageId", "seq", "senderId", "recipientId", "body", "clientMsgId",
}

func TestHydrate_RebuildsAFrameCarryingEveryFieldTheClientRequires(t *testing.T) {
	eventID, messageID := uuid.NewString(), uuid.NewString()
	orgID, clientMsgID := uuid.NewString(), uuid.NewString()

	// messaging-svc's /internal/messages/hydrate, answering for one message.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			messageID: map[string]any{
				"messageId":      messageID,
				"orgId":          orgID,
				"clientMsgId":    clientMsgID,
				"conversationId": uuid.NewString(),
				"seq":            7,
				"senderId":       uuid.NewString(),
				"recipientId":    uuid.NewString(),
				"body":           "hello",
				"occurredAt":     "2026-09-21T09:00:00Z",
			},
		})
	}))
	defer srv.Close()

	ref := contract.TryCompact(&contract.Event{Type: "message.created", EventID: eventID, MessageID: messageID}, nil)
	h := New(srv.URL, "", slog.New(slog.NewTextHandler(io.Discard, nil)))

	out, err := h.Hydrate(context.Background(), [][]byte{ref})
	if err != nil {
		t.Fatalf("Hydrate: %v", err)
	}

	if len(out) != 1 {
		t.Fatalf("Hydrate returned %d entries, want 1", len(out))
	}
	var frame map[string]any
	if err := json.Unmarshal(out[0], &frame); err != nil {
		t.Fatalf("hydrated entry is not JSON: %v", err)
	}
	for _, key := range requiredByClient {
		if v, ok := frame[key]; !ok || v == "" || v == nil {
			t.Errorf("rebuilt message.created is missing %q, which the client requires — it would drop the frame", key)
		}
	}
	if frame["eventId"] != eventID {
		t.Errorf("eventId = %v, want the one from the Redis reference (%s), preserved for client dedup", frame["eventId"], eventID)
	}
	if frame["orgId"] != orgID || frame["clientMsgId"] != clientMsgID {
		t.Errorf("orgId/clientMsgId = %v/%v, want %s/%s", frame["orgId"], frame["clientMsgId"], orgID, clientMsgID)
	}
}

// ── A failed hydrate call must surface, not look like an empty replay ─────────
//
// Hydrate used to swallow a failed call (timeout / 5xx), drop every compact entry
// from the burst, and return the rest as if nothing was wrong. The gateway then
// sent replay.done and the client's cursor moved past the missing messages.

func quietHydrator(url string) *Hydrator {
	return New(url, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func fastRetries(t *testing.T) {
	t.Helper()
	old := fetchRetryPolicy
	fetchRetryPolicy = backoff.Policy{Base: time.Millisecond, Max: 5 * time.Millisecond}
	t.Cleanup(func() { fetchRetryPolicy = old })
}

func compactRef(t *testing.T) (ref []byte, messageID string) {
	t.Helper()
	eventID, messageID := uuid.NewString(), uuid.NewString()
	return contract.TryCompact(&contract.Event{Type: "message.created", EventID: eventID, MessageID: messageID}, nil), messageID
}

// answerFor serves messaging-svc's response for exactly the ids it was asked about.
func answerFor(w http.ResponseWriter, r *http.Request, skip map[string]bool) {
	var req struct {
		MessageIDs []string `json:"messageIds"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	out := map[string]any{}
	for _, id := range req.MessageIDs {
		if skip[id] {
			continue
		}
		out[id] = map[string]any{
			"messageId": id, "orgId": uuid.NewString(), "clientMsgId": uuid.NewString(),
			"conversationId": uuid.NewString(), "seq": 1, "senderId": uuid.NewString(),
			"recipientId": uuid.NewString(), "body": "hi", "occurredAt": "2026-10-07T09:00:00Z",
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func TestHydrate_ReportsAnErrorWhenTheCallKeepsFailing(t *testing.T) {
	fastRetries(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "boom", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	ref, _ := compactRef(t)
	plain := []byte(`{"type":"task.assigned","eventId":"x"}`)
	out, err := quietHydrator(srv.URL).Hydrate(context.Background(), [][]byte{plain, ref})

	if err == nil {
		t.Fatalf("Hydrate returned %d entries and no error after every attempt failed; the caller would send replay.done with messages missing", len(out))
	}
	if out != nil {
		t.Errorf("Hydrate returned entries %q alongside an error; a caller must not replay a partial burst", out)
	}
	if got := calls.Load(); got != fetchMaxAttempts {
		t.Errorf("hydrate attempts = %d, want %d (bounded retry)", got, fetchMaxAttempts)
	}
}

func TestHydrate_RetriesATransientFailureAndSucceeds(t *testing.T) {
	fastRetries(t)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < fetchMaxAttempts { // fail all but the last allowed attempt
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		answerFor(w, r, nil)
	}))
	defer srv.Close()

	ref, _ := compactRef(t)
	out, err := quietHydrator(srv.URL).Hydrate(context.Background(), [][]byte{ref})
	if err != nil || len(out) != 1 {
		t.Fatalf("Hydrate = %d entries, %v; want 1 entry after retrying through a transient failure", len(out), err)
	}
}

func TestHydrate_AMessageMessagingSvcNoLongerHasIsDroppedWithoutError(t *testing.T) {
	ref1, _ := compactRef(t)
	ref2, gone := compactRef(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		answerFor(w, r, map[string]bool{gone: true})
	}))
	defer srv.Close()

	out, err := quietHydrator(srv.URL).Hydrate(context.Background(), [][]byte{ref1, ref2})
	if err != nil || len(out) != 1 {
		t.Fatalf("Hydrate = %d entries, %v; want 1 entry (the deleted message is permanently gone, not a failure)", len(out), err)
	}
}

func TestHydrate_BurstLargerThanOneBatchLosesNothing(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		answerFor(w, r, nil)
	}))
	defer srv.Close()

	var entries [][]byte
	for i := 0; i < maxBatch+10; i++ {
		ref, _ := compactRef(t)
		entries = append(entries, ref)
	}
	out, err := quietHydrator(srv.URL).Hydrate(context.Background(), entries)
	if err != nil || len(out) != len(entries) {
		t.Fatalf("Hydrate = %d entries, %v; want all %d (the tail beyond one batch used to be dropped)", len(out), err, len(entries))
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2 batches", calls.Load())
	}
}

func TestHydrate_CancelledContextStopsRetrying(t *testing.T) {
	old := fetchRetryPolicy
	fetchRetryPolicy = backoff.Policy{Base: time.Hour, Max: time.Hour} // would block ~forever if not cancellable
	t.Cleanup(func() { fetchRetryPolicy = old })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	ref, _ := compactRef(t)

	done := make(chan error, 1)
	go func() { _, err := quietHydrator(srv.URL).Hydrate(ctx, [][]byte{ref}); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Hydrate reported success after its context was cancelled mid-retry")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Hydrate kept retrying after its context was cancelled")
	}
}

func TestHydrate_NoCompactEntriesNeedsNoCall(t *testing.T) {
	entries := [][]byte{[]byte(`{"type":"a"}`), []byte(`{"type":"b"}`)}
	out, err := quietHydrator("http://127.0.0.1:1").Hydrate(context.Background(), entries)
	if err != nil || len(out) != 2 {
		t.Fatalf("Hydrate = %d entries, %v; want both passed through untouched", len(out), err)
	}
}
