package hydrate

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

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

	out := h.Hydrate(context.Background(), [][]byte{ref})

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
