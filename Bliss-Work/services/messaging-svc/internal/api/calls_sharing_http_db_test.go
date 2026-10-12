package api

// Screen-share start/stop through the real HTTP router — the layer the
// original bug report actually hit (POST /calls/{id}/share/stop -> 409).
//
// calls_sharing_db_test.go (internal/store) already proves the store-level
// invariant — at most one live share per call, enforced by
// idx_call_screenshares_live_per_call — under real concurrency. This file is
// the handler layer on top: that a second participant's start is reported as
// 409 "share_active" (not a generic conflict), that a duplicate or stale stop
// is 204 and never 409, and that the room is told about a stop exactly once
// even when the client retries it.
//
// See meeting_series_http_db_test.go for how to run this
// (MESSAGING_API_TEST_DATABASE_URL, a non-superuser role).

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/task-board/messaging-svc/internal/events"
)

// shareEvents are this org's screen-share payloads of the given type, oldest
// first — actorId and source, same shape notifyShare writes.
func (f *httpFixture) shareEvents(typ string) []map[string]any {
	f.t.Helper()
	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`)
	rows, err := tx.Query(ctx, `SELECT payload FROM outbox
		WHERE payload->>'type' = $1 AND payload->>'orgId' = $2 ORDER BY created_at, id`, typ, f.org)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			f.t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		out = append(out, m)
	}
	return out
}

func TestScreenShareHTTP_SecondStartWhileFirstIsLiveReturns409WithShareActiveCode(t *testing.T) {
	f := newHTTPFixture(t)
	host, guest, _, _ := f.org4()
	code, body := f.as(host, f.org)("POST", "/api/v1/calls/direct", map[string]any{"peerId": guest})
	if code != 201 {
		t.Fatalf("1:1 = %d %s", code, body)
	}
	call := decode[callResp](t, body)

	code, body = f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share", map[string]any{"source": "monitor"})
	if code != 201 {
		t.Fatalf("host starts sharing = %d %s", code, body)
	}

	code, body = f.as(guest, f.org)("POST", "/api/v1/calls/"+call.ID+"/share", map[string]any{"source": "window"})
	if code != 409 {
		t.Fatalf("guest start while host is sharing = %d %s, want 409", code, body)
	}
	errResp := decode[map[string]any](t, body)
	errPayload, _ := errResp["error"].(map[string]any)
	if errPayload["code"] != "share_active" {
		t.Errorf("error code = %v, want %q (not a generic conflict)", errPayload["code"], "share_active")
	}

	started := f.shareEvents(events.TypeCallShareStarted)
	if len(started) != 1 {
		t.Fatalf("call.screenshare_started events = %d, want exactly 1 (the refused start must not announce anything)", len(started))
	}
	if started[0]["actorId"] != host {
		t.Errorf("started event actorId = %v, want %s", started[0]["actorId"], host)
	}
}

func TestScreenShareHTTP_DuplicateAndStaleStopsReturn204NotConflict(t *testing.T) {
	f := newHTTPFixture(t)
	host, guest, _, _ := f.org4()
	code, body := f.as(host, f.org)("POST", "/api/v1/calls/direct", map[string]any{"peerId": guest})
	if code != 201 {
		t.Fatalf("1:1 = %d %s", code, body)
	}
	call := decode[callResp](t, body)

	// A stop before anyone ever started: the "not sharing" end state already
	// holds. This used to be the 409 the bug report filed against.
	code, body = f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share/stop", nil)
	if code != 204 {
		t.Fatalf("stop with nothing to stop = %d %s, want 204", code, body)
	}

	code, body = f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share", map[string]any{"source": "monitor"})
	if code != 201 {
		t.Fatalf("host starts sharing = %d %s", code, body)
	}

	code, body = f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share/stop", nil)
	if code != 204 {
		t.Fatalf("first stop = %d %s, want 204", code, body)
	}
	// The duplicate/retried stop a lost response or a double-submit produces.
	code, body = f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share/stop", nil)
	if code != 204 {
		t.Fatalf("duplicate stop = %d %s, want 204 (not 409)", code, body)
	}

	stopped := f.shareEvents(events.TypeCallShareStopped)
	if len(stopped) != 1 {
		t.Fatalf("call.screenshare_stopped events = %d, want exactly 1 (the duplicate stop must not re-announce)", len(stopped))
	}
}

func TestScreenShareHTTP_SecondCanStartAfterFirstStops(t *testing.T) {
	f := newHTTPFixture(t)
	host, guest, _, _ := f.org4()
	code, body := f.as(host, f.org)("POST", "/api/v1/calls/direct", map[string]any{"peerId": guest})
	if code != 201 {
		t.Fatalf("1:1 = %d %s", code, body)
	}
	call := decode[callResp](t, body)

	if code, body := f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share", map[string]any{"source": "monitor"}); code != 201 {
		t.Fatalf("host starts sharing = %d %s", code, body)
	}
	if code, body := f.as(host, f.org)("POST", "/api/v1/calls/"+call.ID+"/share/stop", nil); code != 204 {
		t.Fatalf("host stops sharing = %d %s", code, body)
	}
	if code, body := f.as(guest, f.org)("POST", "/api/v1/calls/"+call.ID+"/share", map[string]any{"source": "window"}); code != 201 {
		t.Fatalf("guest starts after host stopped = %d %s, want 201", code, body)
	}

	if n := f.count(`SELECT count(*) FROM call_screenshares WHERE call_id = $1 AND stopped_at IS NULL`, call.ID); n != 1 {
		t.Fatalf("live shares = %d, want exactly 1 (the guest's)", n)
	}
}
