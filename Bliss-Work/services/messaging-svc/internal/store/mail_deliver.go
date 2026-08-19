package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// deliverMailInApp writes the mailbox rows and the feed projections for every
// person who reads this mail inside BlissWork — the local recipients and the
// author, whose own copy is what makes it appear in their Sent view.
func (s *Store) deliverMailInApp(
	ctx context.Context, tx pgx.Tx, in SendMailInput, locals []string, preview string, sentAt time.Time,
) error {
	// The author's feed row is attributed to the first colleague they wrote to,
	// which is what makes a sent mail show up under that person in the People
	// sidebar. A mail addressed only outside the org has no local counterparty
	// and keeps a NULL peer — it still appears in "All", it just has nobody to
	// file itself under.
	var authorPeer *string
	if len(locals) > 0 {
		authorPeer = &locals[0]
	}
	sentBadge := MailStatusSent
	if err := s.upsertMailInboxItem(ctx, tx, mailInboxItem{
		orgID: in.OrgID, ownerUserID: in.UserID, mailID: in.MailID,
		peerUserID: authorPeer, preview: preview, statusBadge: &sentBadge,
		lastEventAt: sentAt, incUnread: 0,
	}); err != nil {
		return err
	}

	for _, uid := range locals {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mail_deliveries (mail_id, owner_user_id, org_id, folder)
			VALUES ($1, $2, $3, 'INBOX')
			ON CONFLICT (mail_id, owner_user_id) DO NOTHING`,
			in.MailID, uid, in.OrgID); err != nil {
			return err
		}
		sender := in.UserID
		if err := s.upsertMailInboxItem(ctx, tx, mailInboxItem{
			orgID: in.OrgID, ownerUserID: uid, mailID: in.MailID,
			peerUserID: &sender, preview: preview, statusBadge: nil,
			lastEventAt: sentAt, incUnread: 1,
		}); err != nil {
			return err
		}
	}

	if len(locals) == 0 {
		return nil
	}
	// One event for everybody who now has a copy. Routed by `members`, so the
	// author's other devices see the Sent row appear at the same moment the
	// recipients see the new mail.
	return insertOutbox(ctx, tx, in.MailID, events.MailDelivered{
		Type:       events.TypeMailDelivered,
		EventID:    uuid.Must(uuid.NewV7()).String(),
		OrgID:      in.OrgID,
		OccurredAt: nowISO(),
		MailID:     in.MailID,
		SenderID:   in.UserID,
		Members:    append([]string{in.UserID}, locals...),
	})
}

// mailInboxItem is one MAIL row of the unified feed, before encryption.
type mailInboxItem struct {
	orgID       string
	ownerUserID string
	mailID      string
	peerUserID  *string
	preview     string
	statusBadge *string
	lastEventAt time.Time
	incUnread   int
}

// upsertMailInboxItem writes the (owner, MAIL, mailId) projection row.
//
// Deliberately the same shape as upsertThreadInboxItem, including
// GREATEST(last_event_at) so an out-of-order write can never rewind a row, and
// the encrypted preview with the plaintext column left NULL. The ON CONFLICT
// path exists for the redelivery case (an inbound webhook retried after a
// partial failure), not because a send is expected to run twice.
func (s *Store) upsertMailInboxItem(ctx context.Context, tx pgx.Tx, it mailInboxItem) error {
	previewEnc, err := s.crypto.Encrypt(ctx, tx, it.orgID, it.preview)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO inbox_items
		  (org_id, owner_user_id, item_kind, ref_id, peer_user_id, preview, preview_enc,
		   last_event_at, unread_count, status_badge,
		   hidden_for_owner, deleted_for_owner, updated_at)
		VALUES ($1, $2, 'MAIL', $3, $4, NULL, $5, $6, $7, $8, false, false, now())
		ON CONFLICT (owner_user_id, item_kind, ref_id)
		DO UPDATE SET
		    last_event_at    = GREATEST(inbox_items.last_event_at, EXCLUDED.last_event_at),
		    preview          = NULL,
		    preview_enc      = EXCLUDED.preview_enc,
		    unread_count     = inbox_items.unread_count + $7,
		    status_badge     = COALESCE(EXCLUDED.status_badge, inbox_items.status_badge),
		    updated_at       = now()`,
		it.orgID, it.ownerUserID, it.mailID, it.peerUserID, previewEnc,
		it.lastEventAt, it.incUnread, it.statusBadge)
	return err
}

// queueMailOutbound emits one MailOutbound event per address outside the org.
//
// The events carry attachment METADATA, never bytes — see
// events.MailOutboundAttachment, and internalMailAttachment for the endpoint
// email-worker then fetches each file from.
//
// One event per envelope recipient, never one event with a recipient list. The
// To and Cc arrays it carries are the DISPLAY header — the same for every copy —
// while `Envelope` is the single address this copy is actually delivered to.
// That split is what keeps a Bcc'd address out of every header, including the
// one sent to the Bcc'd person themselves.
func (s *Store) queueMailOutbound(
	ctx context.Context, tx pgx.Tx, in SendMailInput, author mailAuthor,
	recipients []resolvedAddress, externals []string, sentAt time.Time,
) error {
	if len(externals) == 0 {
		return nil
	}
	// Read once, not once per copy: every external recipient gets the same file
	// list, and this is a decrypt-per-filename query.
	files, err := s.loadMailAttachments(ctx, tx, in.OrgID, in.MailID)
	if err != nil {
		return err
	}
	attachments := make([]events.MailOutboundAttachment, 0, len(files))
	for _, f := range files {
		attachments = append(attachments, events.MailOutboundAttachment{
			ID: f.ID, Filename: f.Filename, Mime: f.Mime, SizeBytes: f.SizeBytes,
		})
	}
	var to, cc []string
	for _, r := range recipients {
		switch r.kind {
		case MailKindTo:
			to = append(to, r.address)
		case MailKindCc:
			cc = append(cc, r.address)
		}
	}
	providerTo, providerCc, providerBcc := splitExternalsByKind(recipients, externals)
	occurred := sentAt.Format("2006-01-02T15:04:05.000Z")
	payloads := make([]any, 0, len(externals))
	for i, addr := range externals {
		ev := events.MailOutbound{
			Type:        events.TypeMailOutbound,
			EventID:     uuid.Must(uuid.NewV7()).String(),
			OrgID:       in.OrgID,
			OccurredAt:  occurred,
			MailID:      in.MailID,
			Envelope:    addr,
			AuthorID:    in.UserID,
			FromAddress: author.address,
			FromName:    author.name,
			To:          to,
			Cc:          cc,
			Subject:     in.Subject,
			BodyText:    in.BodyText,
			Attachments: attachments,
		}
		// The FIRST copy owns the provider send, and it is first on the topic
		// too — every copy of a mail shares the mailId as its Kafka key, so they
		// land on one partition in this order and the consumer reads the
		// transport decision only after the copy that makes it.
		if i == 0 {
			ev.ProviderCopy = true
			ev.ProviderTo, ev.ProviderCc, ev.ProviderBcc = providerTo, providerCc, providerBcc
		}
		payloads = append(payloads, ev)
	}
	// Same kafka key as the in-app event so every copy of one mail keeps its
	// relative order on the topic.
	return insertOutboxBatch(ctx, tx, in.MailID, payloads)
}

// splitExternalsByKind regroups the addresses leaving the org back into the
// header they were typed in, which is what the provider send needs: it has no
// envelope of its own, so To, Cc and Bcc have to be handed to it as three
// lists rather than as one address at a time.
//
// `externals` is the authority on WHICH addresses leave (it already dropped
// every member and every duplicate); `recipients` is the authority on the KIND
// each one was typed as. Walking recipients preserves the order the sender
// typed, and the seen-set keeps an address that appears in two headers from
// being delivered to twice.
func splitExternalsByKind(recipients []resolvedAddress, externals []string) (to, cc, bcc []string) {
	isExternal := make(map[string]bool, len(externals))
	for _, a := range externals {
		isExternal[a] = true
	}
	seen := make(map[string]bool, len(externals))
	for _, r := range recipients {
		if !isExternal[r.address] || seen[r.address] {
			continue
		}
		seen[r.address] = true
		switch r.kind {
		case MailKindTo:
			to = append(to, r.address)
		case MailKindCc:
			cc = append(cc, r.address)
		default:
			bcc = append(bcc, r.address)
		}
	}
	return to, cc, bcc
}
