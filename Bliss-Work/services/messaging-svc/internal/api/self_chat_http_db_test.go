package api

// Notes to Self through the REAL router: POST /conversations/self and
// POST /conversations/self/share-task. See meeting_series_http_db_test.go's
// header for the harness (MESSAGING_API_TEST_DATABASE_URL, a non-superuser
// role) and newHTTPFixture for the shared fixture (f.host, f.ada, f.org, ...).

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// TestOpenSelfChat_IdempotentThroughTheAPI: opening twice returns the same
// conversation id, and it never appears for anyone else.
func TestOpenSelfChat_IdempotentThroughTheAPI(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)

	code, body := host("POST", "/api/v1/conversations/self", nil)
	if code != 200 {
		t.Fatalf("open self chat = %d: %s", code, body)
	}
	var opened struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(body, &opened); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if opened.ConversationID == "" {
		t.Fatalf("no conversationId in %s", body)
	}

	code, body = host("POST", "/api/v1/conversations/self", nil)
	if code != 200 {
		t.Fatalf("open self chat (second call) = %d: %s", code, body)
	}
	var reopened struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(body, &reopened); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if reopened.ConversationID != opened.ConversationID {
		t.Fatalf("second open returned %q, want the same %q", reopened.ConversationID, opened.ConversationID)
	}
}

// TestSelfChat_SendAndListThroughTheAPI: once opened, the ordinary
// /conversations/{id}/reply and /conversations/{id}/messages endpoints — the
// same ones DMView uses for every other chat — work unmodified, and nobody
// else's conversations list ever contains it.
func TestSelfChat_SendAndListThroughTheAPI(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	ada := f.as(f.ada, f.org)

	code, body := host("POST", "/api/v1/conversations/self", nil)
	if code != 200 {
		t.Fatalf("open = %d: %s", code, body)
	}
	var opened struct {
		ConversationID string `json:"conversationId"`
	}
	_ = json.Unmarshal(body, &opened)

	code, body = host("POST", "/api/v1/conversations/"+opened.ConversationID+"/reply",
		map[string]any{"body": "pick up milk", "clientMsgId": uuid.Must(uuid.NewV7()).String()})
	if code != 201 {
		t.Fatalf("reply = %d: %s", code, body)
	}

	code, body = host("GET", "/api/v1/conversations/"+opened.ConversationID+"/messages", nil)
	if code != 200 {
		t.Fatalf("list messages = %d: %s", code, body)
	}
	var msgs []struct {
		Body     string `json:"body"`
		SenderID string `json:"senderId"`
	}
	if err := json.Unmarshal(body, &msgs); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if len(msgs) != 1 || msgs[0].Body != "pick up milk" || msgs[0].SenderID != f.host {
		t.Fatalf("messages = %+v, want one from %s saying \"pick up milk\"", msgs, f.host)
	}

	// Isolation: another member of the same org must never see this
	// conversation in their own list, nor be able to read into it directly.
	code, body = ada("GET", "/api/v1/conversations", nil)
	if code != 200 {
		t.Fatalf("ada's conversations = %d: %s", code, body)
	}
	var adaConvs []struct {
		ID     string `json:"id"`
		PeerID string `json:"peerId"`
	}
	_ = json.Unmarshal(body, &adaConvs)
	for _, c := range adaConvs {
		if c.ID == opened.ConversationID {
			t.Fatalf("ada's conversation list leaked host's self-chat: %+v", c)
		}
	}
	if code, _ := ada("GET", "/api/v1/conversations/"+opened.ConversationID+"/messages", nil); code != 403 {
		t.Fatalf("ada reading host's self-chat messages = %d, want 403", code)
	}
}

// TestShareTaskToSelfChat_ThroughTheAPI: the task-card "Share to Notes to
// Self" action, end to end — opens the self-chat implicitly on first use and
// tags the message with taskId, same as the store-level test but through
// validation and routing.
func TestShareTaskToSelfChat_ThroughTheAPI(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	taskID := uuid.Must(uuid.NewV7()).String()

	code, body := host("POST", "/api/v1/conversations/self/share-task",
		map[string]any{"taskId": taskID, "body": "Shared a task", "clientMsgId": uuid.Must(uuid.NewV7()).String()})
	if code != 201 {
		t.Fatalf("share-task = %d: %s", code, body)
	}
	var res struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}

	code, body = host("GET", "/api/v1/conversations/"+res.ConversationID+"/messages", nil)
	if code != 200 {
		t.Fatalf("list = %d: %s", code, body)
	}
	var msgs []struct {
		TaskID string `json:"taskId"`
	}
	_ = json.Unmarshal(body, &msgs)
	if len(msgs) != 1 || msgs[0].TaskID != taskID {
		t.Fatalf("messages = %+v, want one tagged with taskId %s", msgs, taskID)
	}

	// Validation: a malformed taskId/body/clientMsgId is a 400, same shape as
	// every other send endpoint.
	if code, body := host("POST", "/api/v1/conversations/self/share-task",
		map[string]any{"taskId": "not-a-uuid", "body": "x", "clientMsgId": uuid.Must(uuid.NewV7()).String()}); code != 400 {
		t.Fatalf("malformed taskId = %d: %s", code, body)
	}
}
