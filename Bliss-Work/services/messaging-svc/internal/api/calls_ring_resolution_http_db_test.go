package api

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/task-board/messaging-svc/internal/events"
)

func TestRingExpiryEmitsNoAnswerAndMissedEventsToTheCorrectUsers(t *testing.T) {
	f := newHTTPFixture(t)
	host, invitee := f.host, f.ada
	as := f.as(host, f.org)

	code, body := as("POST", "/api/v1/calls/direct", map[string]any{"peerId": invitee})
	if code != 201 {
		t.Fatalf("direct call = %d %s", code, body)
	}
	call := decode[callResp](t, body)
	if err := f.srv.store.ClaimCallSession(context.Background(), f.org, host, call.ID, false); err != nil {
		t.Fatalf("host joins call: %v", err)
	}
	f.exec(`
		UPDATE call_participants
		SET ring_expires_at = now() - interval '1 second'
		WHERE call_id = $1 AND user_id = $2`, call.ID, invitee)

	f.srv.sweepExpiredRings(context.Background())

	ctx := context.Background()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bypass_rls', 'on', true)`); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(ctx, `SELECT payload FROM outbox WHERE payload->>'callId' = $1`, call.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	resolutions := make(map[string]map[string]any)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		switch payload["type"] {
		case events.TypeCallNoAnswer, events.TypeCallMissed:
			resolutions[payload["type"].(string)] = payload
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	for _, check := range []struct {
		eventType string
		recipient string
		actor     string
		actorName string
	}{
		{events.TypeCallNoAnswer, host, invitee, "u1-" + invitee[:6]},
		{events.TypeCallMissed, invitee, host, "u0-" + host[:6]},
	} {
		payload, ok := resolutions[check.eventType]
		if !ok {
			t.Errorf("missing %s event", check.eventType)
			continue
		}
		if payload["actorId"] != check.actor {
			t.Errorf("%s actorId = %v, want %s", check.eventType, payload["actorId"], check.actor)
		}
		if payload["actorName"] != check.actorName {
			t.Errorf("%s actorName = %v, want %s", check.eventType, payload["actorName"], check.actorName)
		}
		members, ok := payload["members"].([]any)
		if !ok || len(members) != 1 || members[0] != check.recipient {
			t.Errorf("%s members = %v, want only %s", check.eventType, payload["members"], check.recipient)
		}
	}
}
