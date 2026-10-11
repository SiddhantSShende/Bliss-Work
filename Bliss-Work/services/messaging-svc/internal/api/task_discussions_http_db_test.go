package api

// Task-linked chat ("Chat" button) through the REAL router. See
// meeting_series_http_db_test.go's header for the harness
// (MESSAGING_API_TEST_DATABASE_URL, a non-superuser role).

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func newTestTaskID() string { return uuid.Must(uuid.NewV7()).String() }

// TestOpenTaskDiscussionRejectsSelf: the DM target cannot be the caller
// themselves, same rule openConversation enforces.
func TestOpenTaskDiscussionRejectsSelf(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)

	code, body := host("POST", "/api/v1/tasks/"+newTestTaskID()+"/discussion", map[string]any{"peerId": f.host})
	if code != 400 {
		t.Fatalf("open with self as peer = %d: %s", code, body)
	}
}

// TestOpenTaskDiscussionChannelRequiresMembership: tagging a channel task
// discussion is gated by ordinary channel membership — a non-member gets
// forbidden, exactly as sending an ordinary channel message would.
func TestOpenTaskDiscussionChannelRequiresMembership(t *testing.T) {
	f := newHTTPFixture(t)
	stranger := f.as(f.stranger, f.other)

	code, body := stranger("POST", "/api/v1/tasks/"+newTestTaskID()+"/discussion", map[string]any{"channelId": f.channel})
	if code != 403 {
		t.Fatalf("non-member open = %d: %s", code, body)
	}
}

// TestTaskDiscussionTargetValidation: neither target, or both, is a 400 —
// the HTTP layer's own copy of the store's ErrTaskDiscussionTargetRequired
// check.
func TestTaskDiscussionTargetValidation(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	taskID := newTestTaskID()

	if code, body := host("POST", "/api/v1/tasks/"+taskID+"/discussion", map[string]any{}); code != 400 {
		t.Fatalf("neither target = %d: %s", code, body)
	}
	if code, body := host("POST", "/api/v1/tasks/"+taskID+"/discussion", map[string]any{"peerId": f.ada, "channelId": f.channel}); code != 400 {
		t.Fatalf("both targets = %d: %s", code, body)
	}
}

// TestTaskDiscussionDMRoundTripThroughTheAPI: open, send, and the bulk unread
// endpoint agrees — the whole "Chat" flow a client actually drives.
func TestTaskDiscussionDMRoundTripThroughTheAPI(t *testing.T) {
	f := newHTTPFixture(t)
	host := f.as(f.host, f.org)
	ada := f.as(f.ada, f.org)
	taskID := newTestTaskID()

	code, body := host("POST", "/api/v1/tasks/"+taskID+"/discussion", map[string]any{"peerId": f.ada})
	if code != 200 {
		t.Fatalf("open = %d: %s", code, body)
	}
	var opened struct {
		ID             string  `json:"id"`
		Kind           string  `json:"kind"`
		ConversationID *string `json:"conversationId"`
		ThreadID       *string `json:"threadId"`
	}
	if err := json.Unmarshal(body, &opened); err != nil {
		t.Fatalf("decode open: %v (%s)", err, body)
	}
	if opened.Kind != "DM" || opened.ConversationID == nil || opened.ThreadID != nil {
		t.Fatalf("opened = %+v, want kind DM, a conversationId, and no threadId yet", opened)
	}

	code, body = host("POST", "/api/v1/tasks/"+taskID+"/discussion/messages",
		map[string]any{"peerId": f.ada, "body": "about this task", "clientMsgId": newTestTaskID()})
	if code != 201 {
		t.Fatalf("send = %d: %s", code, body)
	}

	code, body = ada("GET", "/api/v1/tasks/discussions?taskIds="+taskID, nil)
	if code != 200 {
		t.Fatalf("bulk = %d: %s", code, body)
	}
	var summaries []struct {
		TaskID      string `json:"taskId"`
		UnreadCount int64  `json:"unreadCount"`
	}
	if err := json.Unmarshal(body, &summaries); err != nil {
		t.Fatalf("decode bulk: %v (%s)", err, body)
	}
	if len(summaries) != 1 || summaries[0].TaskID != taskID || summaries[0].UnreadCount != 1 {
		t.Fatalf("summaries = %+v, want one row for %s with UnreadCount 1", summaries, taskID)
	}
}
