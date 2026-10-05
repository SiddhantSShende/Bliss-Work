package api

// The client-reported "reconnected" telemetry event, through the real router
// — see meeting_series_http_db_test.go's header for how to run this
// (MESSAGING_API_TEST_DATABASE_URL, same non-superuser requirement) and for
// why this package's own httpFixture is reused rather than a new harness.
//
// What this locks in: CallReconnectTotal now carries a bounded `reason`
// label (metrics.ReconnectReason*) instead of just `call_type`, because the
// client's scheduled token-refresh reconnect (useCallRoom.ts's
// scheduleRefresh) does a real Room.disconnect()+connect() that LiveKit does
// NOT surface as a "Reconnected" room event — that event is specific to the
// SDK's own auto-recovery from a transient disruption. Without a distinct
// reason, the single most frequent reconnect a long call sees was invisible
// on this counter. A request with no `reason` at all must still record
// exactly what it always did ("media"), so an older client is unaffected.

import (
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/task-board/messaging-svc/internal/metrics"
)

// newCall seeds a minimal LIVE call+roster, mirroring internal/store's
// seedLiveCall shape closely enough for callTelemetry's own needs (it only
// reads the call's kind and confirms the caller is on the roster).
func (f *httpFixture) newCall(org, host, guest string) string {
	f.t.Helper()
	callID := uuid.NewString()
	f.exec(`
		INSERT INTO calls (id, org_id, kind, title, created_by, started_at, status)
		VALUES ($1, $2, 'MEETING', 'telemetry test', $3, now() - interval '1 hour', 'LIVE')`,
		callID, org, host)
	for _, p := range []struct{ user, role string }{{host, "HOST"}, {guest, "PARTICIPANT"}} {
		f.exec(`
			INSERT INTO call_participants (call_id, user_id, org_id, role, joined_at)
			VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
			callID, p.user, org, p.role)
	}
	return callID
}

func TestCallTelemetryReconnectedDefaultsToMediaReason(t *testing.T) {
	f := newHTTPFixture(t)
	callID := f.newCall(f.org, f.host, f.ada)
	before := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonMedia))

	code, body := f.as(f.ada, f.org)("POST", "/api/v1/calls/"+callID+"/telemetry", map[string]any{"event": "reconnected"})

	if code != 204 {
		t.Fatalf("status = %d, want 204 (body: %s)", code, body)
	}
	if got := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonMedia)); got != before+1 {
		t.Errorf("messaging_call_reconnect_total{reason=media} = %v, want %v (a reason-less request must default to media)", got, before+1)
	}
}

func TestCallTelemetryReconnectedTokenRefreshReason(t *testing.T) {
	f := newHTTPFixture(t)
	callID := f.newCall(f.org, f.host, f.ada)
	beforeRefresh := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonTokenRefresh))
	beforeMedia := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonMedia))

	code, body := f.as(f.ada, f.org)("POST", "/api/v1/calls/"+callID+"/telemetry",
		map[string]any{"event": "reconnected", "reason": "token_refresh"})

	if code != 204 {
		t.Fatalf("status = %d, want 204 (body: %s)", code, body)
	}
	if got := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonTokenRefresh)); got != beforeRefresh+1 {
		t.Errorf("messaging_call_reconnect_total{reason=token_refresh} = %v, want %v", got, beforeRefresh+1)
	}
	if got := testutil.ToFloat64(metrics.CallReconnectTotal.WithLabelValues(metrics.CallTypeGroup, metrics.ReconnectReasonMedia)); got != beforeMedia {
		t.Errorf("messaging_call_reconnect_total{reason=media} = %v, want %v unchanged (a token_refresh report must not also count as media)", got, beforeMedia)
	}
}

func TestCallTelemetryReconnectedRejectsUnknownReason(t *testing.T) {
	f := newHTTPFixture(t)
	callID := f.newCall(f.org, f.host, f.ada)

	code, body := f.as(f.ada, f.org)("POST", "/api/v1/calls/"+callID+"/telemetry",
		map[string]any{"event": "reconnected", "reason": "bogus"})

	if code != 400 {
		t.Fatalf("status = %d, want 400 for an unbounded reason (body: %s)", code, body)
	}
}

// A caller not on the call's roster must not be able to write telemetry for
// it — same authorization bar as every other call route (GetCall's RLS scope).
func TestCallTelemetryReconnectedRequiresRosterMembership(t *testing.T) {
	f := newHTTPFixture(t)
	callID := f.newCall(f.org, f.host, f.ada)

	code, _ := f.as(f.stranger, f.other)("POST", "/api/v1/calls/"+callID+"/telemetry", map[string]any{"event": "reconnected"})

	if code == 204 {
		t.Fatalf("status = %d, a non-roster caller from another org must not be able to record telemetry for this call", code)
	}
}
