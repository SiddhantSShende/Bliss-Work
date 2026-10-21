package consumer

// Tests for the billing.events.v1 consumer (billing.go). DB tests are opt-in
// on NOTIFICATION_TEST_DATABASE_URL, same convention as poison_test.go.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/notification-svc/internal/events"
)

// stubAdminsLookup is a fake orgadmins.Lookup for testing billing.go's
// recipient resolution without a real auth-svc.
type stubAdminsLookup struct {
	ids   []string
	err   error
	calls int
}

func (s *stubAdminsLookup) AdminUserIDs(ctx context.Context, orgID string) ([]string, error) {
	s.calls++
	return s.ids, s.err
}

func billingMsg(t *testing.T, ev events.BillingEvent) kafka.Message {
	t.Helper()
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return kafka.Message{Topic: events.TopicBilling, Value: b}
}

// TestBillingEvent_GraceAndSuspended_NotifyTheAffectedMember: with no admins
// configured (c.orgAdmins == nil, the same as before this org-admins
// primitive existed), grace/suspension notices still go to the one recipient
// the event already names unambiguously — the affected membership's own
// user.
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

// TestBillingEvent_LowBalance_NoAdmins_IsAcknowledgedNotDelivered: an org
// with zero current admins (e.g. all demoted/removed) must not error or
// poison the message — there is simply nobody to notify.
func TestBillingEvent_LowBalance_NoAdmins_IsAcknowledgedNotDelivered(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool) // c.orgAdmins == nil ⇒ lookupAdmins returns (nil, nil)

	orgID := uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindLowBalance, OrgID: orgID, Balance: 5, ThresholdCredits: 20,
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{m})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v; zero admins must be acknowledged, not poisoned or abandoned", len(poison), err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE org_id = $1`, orgID).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Fatalf("notifications for low_balance with zero admins = %d, want 0", n)
	}
}

// TestBillingEvent_LowBalance_NotifiesAllAdmins: membership.low_balance is
// org-wide, not member-specific, so it must reach every admin the lookup
// returns, each as their own notification row.
func TestBillingEvent_LowBalance_NotifiesAllAdmins(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	admin1, admin2 := uuid.NewString(), uuid.NewString()
	c := quietConsumer(pool)
	c.orgAdmins = &stubAdminsLookup{ids: []string{admin1, admin2}}

	orgID := uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindLowBalance, OrgID: orgID, Balance: 3, ThresholdCredits: 50,
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{m})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v", len(poison), err)
	}

	for _, admin := range []string{admin1, admin2} {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2 AND kind = $3`,
			orgID, admin, events.KindMembershipLowBalance).Scan(&n); err != nil {
			t.Fatalf("query admin %s: %v", admin, err)
		}
		if n != 1 {
			t.Errorf("low_balance notifications for admin %s = %d, want 1", admin, n)
		}
	}
}

// TestBillingEvent_Suspended_NotifiesMemberAndAdmins_DedupedWhenSame checks
// both the fan-out (member + admins each get a row) and the dedup invariant:
// a member who is ALSO an org admin must receive exactly ONE notification for
// the event, not two.
func TestBillingEvent_Suspended_NotifiesMemberAndAdmins_DedupedWhenSame(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	memberID, otherAdmin := uuid.NewString(), uuid.NewString()
	c := quietConsumer(pool)
	// memberID is deliberately ALSO in the admin roster.
	c.orgAdmins = &stubAdminsLookup{ids: []string{memberID, otherAdmin}}

	orgID := uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindSuspended, OrgID: orgID, UserID: memberID, PeriodStart: "2026-05-01T00:00:00Z",
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{m})
	if err != nil || len(poison) != 0 {
		t.Fatalf("projectBatch = poison %d, err %v", len(poison), err)
	}

	var total int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		t.Fatalf("query total: %v", err)
	}
	if total != 2 {
		t.Fatalf("total notifications = %d, want 2 (member==admin deduped to one, otherAdmin gets one)", total)
	}

	var memberCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgID, memberID).Scan(&memberCount); err != nil {
		t.Fatalf("query member: %v", err)
	}
	if memberCount != 1 {
		t.Errorf("notifications for member-who-is-also-admin = %d, want exactly 1 (deduped)", memberCount)
	}

	var otherCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgID, otherAdmin).Scan(&otherCount); err != nil {
		t.Fatalf("query other admin: %v", err)
	}
	if otherCount != 1 {
		t.Errorf("notifications for the other admin = %d, want 1", otherCount)
	}
}

// TestBillingEvent_AdminLookupFailure_PropagatesForRetry: a transient failure
// reaching auth-svc (network error / 5xx, modeled here as the stub returning
// an error) must NOT be swallowed or acknowledged. It must come back as a
// plain (non-errMalformed) error from projectBatch, so runBatch abandons the
// batch uncommitted and the Kafka offset is never advanced — the message is
// redelivered on the next poll, not dead-lettered.
func TestBillingEvent_AdminLookupFailure_PropagatesForRetry(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	c := quietConsumer(pool)
	lookupErr := errors.New("auth-svc unreachable: connection refused")
	c.orgAdmins = &stubAdminsLookup{err: lookupErr}

	orgID, userID := uuid.NewString(), uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindSuspended, OrgID: orgID, UserID: userID, PeriodStart: "2026-06-01T00:00:00Z",
	})

	poison, err := c.projectBatch(ctx, []kafka.Message{m})
	if err == nil {
		t.Fatal("projectBatch err = nil, want a propagated transient error")
	}
	if errors.Is(err, errMalformed) {
		t.Fatalf("err = %v wrapped errMalformed; a lookup failure is transient, must not take the poison/dead-letter path", err)
	}
	if len(poison) != 0 {
		t.Fatalf("poison = %d messages, want 0 — this must retry, not dead-letter", len(poison))
	}

	// Nothing committed: the transaction this ran in was rolled back.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE org_id = $1`, orgID).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Fatalf("notifications after a failed lookup = %d, want 0 (nothing should have committed)", n)
	}
}

// TestBillingEvent_DuplicateDelivery_AfterAdminLookupSucceeds_NoDoubleNotify:
// once a message is FULLY processed (lookup succeeded, rows created), a
// redelivery of the identical message must still be caught by
// consumed_events — no double notifications for member or admins.
func TestBillingEvent_DuplicateDelivery_AfterAdminLookupSucceeds_NoDoubleNotify(t *testing.T) {
	pool := poisonTestPool(t)
	ctx := context.Background()
	memberID, adminID := uuid.NewString(), uuid.NewString()
	c := quietConsumer(pool)
	c.orgAdmins = &stubAdminsLookup{ids: []string{adminID}}

	orgID := uuid.NewString()
	m := billingMsg(t, events.BillingEvent{
		Kind: events.BillingKindGraceStarted, OrgID: orgID, UserID: memberID, PeriodStart: "2026-07-01T00:00:00Z",
	})

	if _, err := c.projectBatch(ctx, []kafka.Message{m}); err != nil {
		t.Fatalf("first delivery: %v", err)
	}
	if _, err := c.projectBatch(ctx, []kafka.Message{m}); err != nil {
		t.Fatalf("redelivery: %v", err)
	}

	for _, recipient := range []string{memberID, adminID} {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM notifications WHERE org_id = $1 AND recipient_id = $2`, orgID, recipient).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", recipient, err)
		}
		if n != 1 {
			t.Errorf("notifications for %s after duplicate delivery = %d, want 1", recipient, n)
		}
	}
}
