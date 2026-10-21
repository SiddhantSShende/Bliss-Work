package consumer

// Tests for the billing.events.v1 consumer (billing.go). DB tests are opt-in
// on NOTIFICATION_TEST_DATABASE_URL, same convention as poison_test.go.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/notification-svc/internal/events"
)

func billingMsg(t *testing.T, ev events.BillingEvent) kafka.Message {
	t.Helper()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return kafka.Message{Topic: events.TopicBilling, Value: b}
}

// TestBillingEvent_GraceAndSuspended_NotifyTheAffectedMember exercises the
// deliberate recipient-resolution fallback (see billing.go's doc comment):
// with no org-admins primitive to reuse, grace/suspension notices go to the
// one recipient the event already names — the affected membership's own
// user — not a guessed "admin".
func TestBillingEvent_GraceAndSuspended_NotifyTheAffectedMember(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	orgID, userID := uuid.NewString(), uuid.NewString()
	grace := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindGraceStarted, OrgID: orgID, UserID: userID, PeriodStart: "2026-01-01T00:00:00Z",
	})
	suspended := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindSuspended, OrgID: orgID, UserID: userID, PeriodStart: "2026-02-01T00:00:00Z",
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{grace, suspended})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v; want both projected", len(poison), err)
	}

	for _, kind := range []string{events.KindMembershipGraceStarted, events.KindMembershipSuspended} {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
			orgID, userID, kind).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", kind, err)
		}
		if n != 1 {
			t.Errorf("%s notifications for the affected member = %d, want 1", kind, n)
		}
	}
}

// TestBillingEvent_DuplicateDelivery_IsNoOp: billing-svc's outbox carries no
// eventId, so this consumer dedups on the raw message bytes (see billing.go).
// The same message delivered twice (at-least-once Kafka redelivery) must
// produce exactly one notification, not two.
func TestBillingEvent_DuplicateDelivery_IsNoOp(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	orgID, userID := uuid.NewString(), uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindSuspended, OrgID: orgID, UserID: userID, PeriodStart: "2026-03-01T00:00:00Z",
	})

	if _, err := c.projectBatch(ctx, []kafka.Message{m}); err != nil {
		t.Fatalf("first delivery: %v", err)
	}
	// Redelivered — identical bytes, as a real at-least-once redelivery would be.
	if _, err := c.projectBatch(ctx, []kafka.Message{m}); err != nil {
		t.Fatalf("redelivery: %v", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
		orgID, userID, events.KindMembershipSuspended).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Fatalf("notifications after duplicate delivery = %d, want 1", n)
	}
}

// TestBillingEvent_OrgIsolation: org A's billing event must never produce a
// notification visible under org B, even when both orgs have a membership
// for the same user id (e.g. one person belongs to two orgs).
func TestBillingEvent_OrgIsolation(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	orgA, orgB, userID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindGraceStarted, OrgID: orgA, UserID: userID, PeriodStart: "2026-04-01T00:00:00Z",
	})

	if _, err := c.projectBatch(ctx, []kafka.Message{m}); err != nil {
		t.Fatalf("projectBatch: %v", err)
	}

	var inA, inB int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgA, userID).Scan(&inA); err != nil {
		t.Fatalf("query org A: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgB, userID).Scan(&inB); err != nil {
		t.Fatalf("query org B: %v", err)
	}
	if inA != 1 {
		t.Errorf("org A notifications = %d, want 1", inA)
	}
	if inB != 0 {
		t.Errorf("org B notifications = %d, want 0 (org isolation)", inB)
	}
}

// TestBillingEvent_LowBalance_AcknowledgedButNotDeliverable documents the
// flagged gap: without an org-admins primitive, membership.low_balance is
// accepted (no error, no redelivery loop, no poison) but produces no
// notification row — see billing.go's doc comment.
func TestBillingEvent_LowBalance_AcknowledgedButNotDeliverable(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)

	orgID := uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindLowBalance, OrgID: orgID, Balance: 5, ThresholdCredits: 20,
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{m})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v; low_balance must be acknowledged, not poisoned or abandoned", len(poison), err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE org_id = $1`, orgID).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Fatalf("notifications for low_balance = %d, want 0 (no admin-roster primitive to deliver to yet)", n)
	}
}
