package consumer

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/notification-svc/internal/events"
)

// billingEvent projects one billing.events.v1 message.
//
// ── Recipient resolution ────────────────────────────────────────────────────
// All three kinds now resolve "the org's admins" via auth-svc's internal
// GET /internal/v1/orgs/{orgId}/admins (services/auth-svc/app/routes/
// internal.py), which reuses members_service._active_admin_ids — the same
// query that already enforces the no-last-admin invariant elsewhere in that
// service. See internal/orgadmins/client.go for the HTTP call and
// lookupAdmins below for how its failure is handled.
//
//   - membership.low_balance is org-wide, not member-specific: it goes to
//     every admin and only admins.
//   - membership.grace_started / membership.suspended go to the affected
//     member (useful on its own — the member finds out their own access is
//     at risk) AND to every admin, de-duplicated so a member who is also an
//     admin gets exactly one notification.
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
		return c.billingLowBalance(ctx, tx, value, ev)
	default:
		return nil // unrecognized kind, or not a billing event at all — ignore
	}
}

// lookupAdmins resolves ev's org's current admins through c.orgAdmins.
//
// nil c.orgAdmins (AUTH_INTERNAL_TOKEN unset) is treated as "no admins" —
// the same optional-dependency posture auth-svc's own billing_client.py uses
// when ITS peer isn't configured. Once configured, though, any error from the
// call — network failure, timeout, non-2xx status — is returned verbatim,
// NOT swallowed and NOT wrapped as errMalformed: the caller (billing.go) must
// propagate it so projectOnce's default branch abandons the batch uncommitted
// and Kafka redelivers the message. This is a transient-infrastructure
// failure, not a malformed payload, so it must never reach the poison/DLQ
// path.
func (c *Consumer) lookupAdmins(ctx context.Context, orgID string) ([]string, error) {
	if c.orgAdmins == nil {
		return nil, nil
	}
	ids, err := c.orgAdmins.AdminUserIDs(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("org admins lookup for %s: %w", orgID, err)
	}
	return ids, nil
}

// perRecipientDedupID derives a stable, per-(message,recipient) dedup id from
// the raw message bytes. billing-svc's outbox payload carries no eventId (see
// events.BillingEvent's doc comment), so dedup hashes the message itself —
// and because ONE message can now fan out to several recipients (the member
// plus N admins), each recipient needs its own claim on consumed_events, or
// the second row created for the same message would look like (and be
// skipped as) a duplicate of the first. Redelivery of the IDENTICAL message
// to the SAME recipient reproduces the SAME id, which is exactly the
// redelivery dedup this is for.
func perRecipientDedupID(value []byte, recipientID string) string {
	key := make([]byte, 0, len(value)+1+len(recipientID))
	key = append(key, value...)
	key = append(key, ':')
	key = append(key, recipientID...)
	return uuid.NewSHA1(uuid.NameSpaceURL, key).String()
}

func (c *Consumer) billingMembershipNotice(ctx context.Context, tx pgx.Tx, value []byte, ev events.BillingEvent) error {
	if ev.OrgID == "" || ev.UserID == "" {
		c.log.Warn("billing membership event missing orgId/userId, dead-lettering", "kind", ev.Kind)
		return errMalformed
	}

	var kind, memberText, adminText string
	switch ev.Kind {
	case events.BillingKindGraceStarted:
		kind = events.KindMembershipGraceStarted
		memberText = "Your membership billing is past due. Top up your organization's credits before the grace period ends to avoid suspension."
		adminText = "A membership in your organization is past due. Top up your organization's credits before the grace period ends to avoid suspension."
	case events.BillingKindSuspended:
		kind = events.KindMembershipSuspended
		memberText = "Your membership has been suspended for non-payment. Top up your organization's credits to restore access."
		adminText = "A membership in your organization has been suspended for non-payment. Top up your organization's credits to restore access."
	}

	adminIDs, err := c.lookupAdmins(ctx, ev.OrgID)
	if err != nil {
		return err
	}

	// A set, not a slice: the affected member may ALSO be an org admin, and
	// that must produce exactly one notification, not two.
	recipients := make(map[string]bool, len(adminIDs)+1)
	recipients[ev.UserID] = true
	for _, id := range adminIDs {
		recipients[id] = true
	}

	for recipientID := range recipients {
		text := adminText
		if recipientID == ev.UserID {
			// The affected member's own copy is phrased about THEM, even if
			// they also happen to be an admin — more specific beats generic.
			text = memberText
		}
		dedupID := perRecipientDedupID(value, recipientID)
		if err := c.create(ctx, tx, notification{
			sourceEventID: dedupID,
			sourceType:    ev.Kind,
			orgID:         ev.OrgID,
			recipientID:   recipientID,
			kind:          kind,
			text:          text,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (c *Consumer) billingLowBalance(ctx context.Context, tx pgx.Tx, value []byte, ev events.BillingEvent) error {
	if ev.OrgID == "" {
		c.log.Warn("billing low_balance event missing orgId, dead-lettering")
		return errMalformed
	}

	adminIDs, err := c.lookupAdmins(ctx, ev.OrgID)
	if err != nil {
		return err
	}
	if len(adminIDs) == 0 {
		// A real, valid state (an org can have admins removed down to a
		// roster this consumer hasn't caught up on, or — defensively — the
		// lookup races a brand-new org): nothing to notify, not an error.
		c.log.Info("membership.low_balance: org has no admins to notify",
			"orgId", ev.OrgID, "balance", ev.Balance, "thresholdCredits", ev.ThresholdCredits)
		return nil
	}

	text := fmt.Sprintf(
		"Your organization's credit balance is low (%d credits, threshold %d). Top up to avoid a billing grace period.",
		ev.Balance, ev.ThresholdCredits,
	)

	for _, recipientID := range adminIDs {
		dedupID := perRecipientDedupID(value, recipientID)
		if err := c.create(ctx, tx, notification{
			sourceEventID: dedupID,
			sourceType:    ev.Kind,
			orgID:         ev.OrgID,
			recipientID:   recipientID,
			kind:          events.KindMembershipLowBalance,
			text:          text,
		}); err != nil {
			return err
		}
	}
	return nil
}
