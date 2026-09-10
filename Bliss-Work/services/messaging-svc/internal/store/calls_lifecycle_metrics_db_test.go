package store

// Call-level metric emission (P0-B, Level 3) — against a real Postgres, for
// the same reason calls_lifecycle_db_test.go is: the thing under test is
// which branch of a state transition fires, and that state lives in rows, not
// in Go. See that file's header for how to run this (same
// MESSAGING_TEST_DATABASE_URL harness, same non-superuser requirement).
//
// What is NOT covered here: metrics.CallAttemptTotal / CallFailedTotal (those
// are recorded in the api package's callToken handler, not in store — see
// metrics/calls.go's package doc comment for the full map of what is recorded
// where and why) and CallReconnectTotal / CallSetupDurationSeconds (client-
// reported via callTelemetry, also api package). Those are exercised by
// internal/api's own tests.

import (
	"context"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/task-board/messaging-svc/internal/metrics"
)

// A fresh SFU connection — session_id NULL, left_at NULL — is exactly the
// "ordinary first join" case: one increment, and a duplicate delivery of the
// SAME webhook (LiveKit's delivery is at-least-once) must not double it.
func TestCallLifecycleMetricsFreshJoinCountsOnceEvenOnDuplicateDelivery(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)
	before := testutil.ToFloat64(metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeGroup))

	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("first MarkJoinedFromSFU: %v", err)
	}
	if got := testutil.ToFloat64(metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeGroup)); got != before+1 {
		t.Errorf("messaging_call_connected_total{call_type=group} = %v, want %v (one fresh join)", got, before+1)
	}

	// A duplicate delivery of the SAME session_id — the row was already
	// connected (session_id set, left_at still NULL) — must not double-count.
	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("duplicate MarkJoinedFromSFU: %v", err)
	}
	if got := testutil.ToFloat64(metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeGroup)); got != before+1 {
		t.Errorf("a duplicate webhook delivery double-counted: messaging_call_connected_total{call_type=group} = %v, want %v", got, before+1)
	}
}

// The subtle case this design exists to get right: leaving and rejoining the
// SAME call must count as a SECOND connection, even though session_id was
// already non-NULL from the first join — because left_at was set in between,
// this is not the same live session continuing.
func TestCallLifecycleMetricsRejoinAfterLeaveCountsAsANewConnection(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)

	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if _, _, _, err := s.LeaveCall(ctx, c.orgID, c.guest, c.id); err != nil {
		t.Fatalf("LeaveCall: %v", err)
	}
	if err := s.MarkJoined(ctx, c.orgID, c.guest, c.id); err != nil {
		t.Fatalf("MarkJoined (the rejoin's own token request): %v", err)
	}
	before := testutil.ToFloat64(metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeGroup))

	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-2"); err != nil {
		t.Fatalf("rejoin's SFU webhook: %v", err)
	}
	if got := testutil.ToFloat64(metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeGroup)); got != before+1 {
		t.Errorf("a genuine rejoin after leaving was not counted: messaging_call_connected_total{call_type=group} = %v, want %v", got, before+1)
	}
}

// An explicit leave beats the webhook to left_at, so the webhook's own
// departure — a normal hangup — must NOT be counted as a drop.
func TestCallLifecycleMetricsAnExplicitLeaveIsNotCountedAsADrop(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)
	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("join: %v", err)
	}
	before := testutil.ToFloat64(metrics.CallDroppedTotal.WithLabelValues(metrics.CallTypeGroup))

	if _, _, _, err := s.LeaveCall(ctx, c.orgID, c.guest, c.id); err != nil {
		t.Fatalf("LeaveCall: %v", err)
	}
	// The SFU's own webhook for that same disconnect, arriving after — left_at
	// is already set, so this must be a no-op for the metric.
	if _, _, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("MarkLeftFromSFU following the explicit leave: %v", err)
	}
	if got := testutil.ToFloat64(metrics.CallDroppedTotal.WithLabelValues(metrics.CallTypeGroup)); got != before {
		t.Errorf("an explicit Leave was counted as a drop: messaging_call_dropped_total{call_type=group} = %v, want %v (unchanged)", got, before)
	}
}

// A departure the SFU is the FIRST to report — no LeaveCall/EndCall beat it
// to left_at — is exactly what messaging_call_dropped_total exists to count.
func TestCallLifecycleMetricsAnUnannouncedDepartureIsCountedAsADrop(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	c := seedLiveCall(t, s, nil)
	if err := s.MarkJoinedFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("join: %v", err)
	}
	before := testutil.ToFloat64(metrics.CallDroppedTotal.WithLabelValues(metrics.CallTypeGroup))

	if _, _, err := s.MarkLeftFromSFU(ctx, c.id, c.guest, "sid-1"); err != nil {
		t.Fatalf("MarkLeftFromSFU: %v", err)
	}
	if got := testutil.ToFloat64(metrics.CallDroppedTotal.WithLabelValues(metrics.CallTypeGroup)); got != before+1 {
		t.Errorf("an unannounced departure was not counted: messaging_call_dropped_total{call_type=group} = %v, want %v", got, before+1)
	}
}
