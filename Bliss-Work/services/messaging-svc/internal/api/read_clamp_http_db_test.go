package api

// B-MSG-1 through the real router: POST /inbox/items/THREAD/{id}/read sends an
// unbounded upToSeq on the caller's behalf, and /conversations|threads|channels
// /{id}/read forward whatever the client wrote. Neither may park a read cursor
// above the newest message that exists.
//
// Opt-in on MESSAGING_API_TEST_DATABASE_URL; see meeting_series_http_db_test.go.

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/store"
)

func TestReadEndpointsNeverParkACursorAboveTheNewestMessage(t *testing.T) {
	f := newHTTPFixture(t)
	ctx := context.Background()

	root, err := f.srv.store.SendMessage(ctx, f.org, f.host, f.ada, "hello", uuid.NewString(), store.SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	last, err := f.srv.store.ReplyToThread(ctx, f.org, f.host, root.ThreadID, "", "again", uuid.NewString(), "")
	if err != nil {
		t.Fatalf("ReplyToThread: %v", err)
	}
	ada := f.as(f.ada, f.org)

	cursor := func(sql string, id string) int64 {
		var n int64
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		_, _ = tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
		if err := tx.QueryRow(ctx, sql, id, f.ada).Scan(&n); err != nil {
			t.Fatalf("read cursor: %v", err)
		}
		return n
	}

	// The unified-inbox "mark read" (server-chosen MaxInt64).
	if code, body := ada("POST", "/api/v1/inbox/items/THREAD/"+root.ThreadID+"/read", nil); code != http.StatusNoContent {
		t.Fatalf("inbox read = %d %s", code, body)
	}
	if got := cursor(`SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, root.ThreadID); got != last.Seq {
		t.Fatalf("thread cursor after inbox read = %d, want %d", got, last.Seq)
	}

	// Client-supplied huge values on the three explicit endpoints.
	huge := map[string]any{"upToSeq": int64(1) << 60}
	for _, path := range []string{
		"/api/v1/threads/" + root.ThreadID + "/read",
		"/api/v1/conversations/" + root.ConversationID + "/read",
	} {
		if code, body := ada("POST", path, huge); code != http.StatusNoContent {
			t.Fatalf("POST %s = %d %s", path, code, body)
		}
	}
	if got := cursor(`SELECT last_read_seq FROM thread_members WHERE thread_id = $1 AND user_id = $2`, root.ThreadID); got != last.Seq {
		t.Errorf("thread cursor after huge client seq = %d, want %d", got, last.Seq)
	}
	if got := cursor(`SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`, root.ConversationID); got != last.Seq {
		t.Errorf("conversation cursor after huge client seq = %d, want %d", got, last.Seq)
	}

	// Channel: f.channel is seeded without messages, so its ceiling is 0.
	f.exec(`UPDATE channels SET seq_counter = 4 WHERE id = $1`, f.channel)
	if code, body := ada("POST", fmt.Sprintf("/api/v1/channels/%s/read", f.channel), huge); code != http.StatusNoContent {
		t.Fatalf("channel read = %d %s", code, body)
	}
	if got := cursor(`SELECT last_read_seq FROM channel_members WHERE channel_id = $1 AND user_id = $2`, f.channel); got != 4 {
		t.Errorf("channel cursor after huge client seq = %d, want the channel's newest seq 4", got)
	}
}
