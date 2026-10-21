package consumer

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/notification-svc/internal/events"
)

// billingEvent projects one billing.events.v1 message.
//
// ── Recipient resolution: a known gap, not an invented workaround ──────────
// The plan asks this consumer to notify "the org's admins" for each billing
// kind. There is no primitive anywhere in this platform that this service
// (or billing-svc, which has no role data of its own — see
// billing-svc/app/membership_commitment.py, which only maps a role to a
// price, never persists a roster) can call to get "the admins of org X":
//   - notification-svc's own DB holds only notifications/outbox/consumed_events
//     (internal/db/migrations/001_init.sql) — no org-membership table.
//   - auth-svc has the role data (app/routes/members_service.py's
//     _active_admin_ids), but exposes no internal HTTP endpoint for another
//     service to call, and no auth.events event publishes an admin roster.
//   - Every other producer in this platform (task-svc, messaging-svc) avoids
//     this exact problem by resolving recipients itself and embedding them in
//     the event (TaskEvent.AssigneeID, ChannelMessageCreated.Members, ...) —
//     notification-svc never resolves an org-wide audience on its own. Doing
//     that here for the first time would mean either a new cross-service
//     admin-lookup call (not an existing mechanism to "reuse") or a guessed
//     admin list, both of which this is deliberately NOT doing.
//
// So: membership.grace_started and membership.suspended ARE delivered,
// to the one recipient the event already names unambiguously — the affected
// member (OrgID/UserID on the event) — which is useful on its own (the
// member finds out their own access is at risk) even though it is not "the
// org's admins". membership.low_balance has no such fallback (it is an
// org-wide balance, not a membership), so it is accepted and acknowledged
// (no error, no redelivery loop) but intentionally not turned into a
// notification until an org-admins primitive exists. This is flagged, not
// silently dropped: see the log line below.
func (c *Consumer) billingEvent(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.BillingEvent
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable billing event", "error", err)
		return errMalformed
	}

	switch ev.Kind {
	case events.BillingKindGraceStarted, events.BillingKindSuspended:
		return c.billingMembershipNotice(ctx, tx, value, ev)
	case events.BillingKindLowBalance:
		// See the doc comment above: deliberately a no-op pending an
		// org-admins resolution primitive, not a guessed recipient.
		c.log.Warn("membership.low_balance received but not delivered: no org-admins primitive exists yet",
			"orgId", ev.OrgID, "balance", ev.Balance, "thresholdCredits", ev.ThresholdCredits)
		return nil
	default:
		return nil // unrecognized kind, or not a billing event at all — ignore
	}
}

func (c *Consumer) billingMembershipNotice(ctx context.Context, tx pgx.Tx, value []byte, ev events.BillingEvent) error {
	if ev.OrgID == "" || ev.UserID == "" {
		c.log.Warn("billing membership event missing orgId/userId, dead-lettering", "kind", ev.Kind)
		return errMalformed
	}

	var kind, text string
	switch ev.Kind {
	case events.BillingKindGraceStarted:
		kind = events.KindMembershipGraceStarted
		text = "Your membership billing is past due. Top up your organization's credits before the grace period ends to avoid suspension."
	case events.BillingKindSuspended:
		kind = events.KindMembershipSuspended
		text = "Your membership has been suspended for non-payment. Top up your organization's credits to restore access."
	}

	// No eventId on this payload (see events.BillingEvent's doc comment), so
	// dedup hashes the raw message bytes instead — a deterministic id for
	// "this exact message", which is exactly what at-least-once Kafka
	// redelivery needs idempotency against. billing-svc's own idempotency
	// (membership_renewal_runs / the cycle_status transition check in
	// app/renewal.py) is what prevents a SECOND, distinct message for the
	// same grace/suspension episode — this dedup is purely about redelivery
	// of the identical message, not business-level de-duplication.
	dedupID := uuid.NewSHA1(uuid.NameSpaceURL, value).String()

	return c.create(ctx, tx, notification{
		sourceEventID: dedupID,
		sourceType:    ev.Kind,
		orgID:         ev.OrgID,
		recipientID:   ev.UserID,
		kind:          kind,
		text:          text,
	})
}
