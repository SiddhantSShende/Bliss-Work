package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// InboundMailInput is one message arriving from outside BlissWork.
//
// This is the ingestion seam for the MTA: whatever terminates SMTP for the
// deployment (a provider webhook, an LMTP shim, a fetch job) parses the message
// and POSTs this shape to /internal/mail/inbound. Deliberately a small,
// already-parsed contract rather than raw RFC 5322 — MIME parsing belongs in
// the component that already has to do it, and keeping it out of here means the
// messaging service never has to trust a byte stream from the internet.
type InboundMailInput struct {
	OrgID string
	// ExternalMessageID is the RFC 5322 Message-ID. Required, and the entire
	// basis of dedup: webhooks retry, and a mail delivered twice is worse than
	// one delivered late.
	ExternalMessageID string
	FromAddress       string
	FromName          string
	Subject           string
	BodyText          string
	BodyHTML          string
	// Recipients as they appeared on the envelope/headers. Addresses that do
	// not resolve to an active member of OrgID are dropped — this endpoint
	// delivers into BlissWork mailboxes, it does not relay onward.
	To     []string
	Cc     []string
	SentAt time.Time
}

// ErrMailDuplicate reports that this Message-ID has already been ingested for
// this org. Not a failure: the caller should treat it as success and stop
// retrying.
var ErrMailDuplicate = errors.New("mail already delivered")

// DeliverInboundMail stores an externally-received mail and files it into the
// Inbox of every addressee who is a member of the org.
//
// Runs under bypass RLS because it is a trusted service-to-service path whose
// org comes from the caller rather than from a user session — the same posture
// as the delivery-ack and channel-membership internal endpoints. The org is
// still written onto every row, so RLS applies normally to every read of them.
func (s *Store) DeliverInboundMail(ctx context.Context, in InboundMailInput) (string, int, error) {
	from := NormalizeMailAddress(in.FromAddress)
	if from == "" {
		return "", 0, &InvalidAddressError{Address: strings.TrimSpace(in.FromAddress)}
	}
	if strings.TrimSpace(in.ExternalMessageID) == "" {
		return "", 0, ErrMailInvalidAddress
	}
	if utf8.RuneCountInString(in.Subject) > MaxMailSubjectRunes {
		in.Subject = truncateRunes(in.Subject, MaxMailSubjectRunes)
	}
	if utf8.RuneCountInString(in.BodyText) > MaxMailBodyRunes {
		in.BodyText = truncateRunes(in.BodyText, MaxMailBodyRunes)
	}
	if in.SentAt.IsZero() {
		in.SentAt = time.Now().UTC()
	}

	mailID := uuid.Must(uuid.NewV7()).String()
	delivered := 0
	var duplicateID string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// Resolve the duplicate case FIRST, before resolving recipients at
		// all — a message this org already has (a redelivered webhook, or
		// mail_sync_worker walking a SECOND connected mailbox's copy of a
		// mail that already exists, including this org's own previously-SENT
		// mail backfilled with its external_message_id — see
		// providers/microsoft.py's module docstring) is a duplicate
		// regardless of who its recipients resolve to. Checking only AFTER an
		// empty-locals rejection would wrongly answer "nobody deliverable" for
		// an all-external-recipient mail this org already has, instead of
		// "yes, already have it" — and the caller needs the real mailID
		// either way to link its own connection to it (mail_sync_links).
		existing, eerr := s.existingMailIDByExternalRef(ctx, tx, in.OrgID, in.ExternalMessageID)
		if eerr != nil {
			return eerr
		}
		if existing != "" {
			duplicateID = existing
			return ErrMailDuplicate
		}

		recipients, rerr := resolveMailRecipients(ctx, tx, in.OrgID, in.To, in.Cc, nil)
		if rerr != nil {
			return rerr
		}
		locals, _ := splitMailDelivery(recipients, "")
		if len(locals) == 0 {
			// Nobody here to deliver to. Rejected rather than stored: an
			// undeliverable mail sitting in the database is a mail nobody will
			// ever see and nobody can explain.
			return ErrMailNoDeliverable
		}

		if ierr := s.insertInboundMail(ctx, tx, in, from, mailID); ierr != nil {
			if errors.Is(ierr, ErrMailDuplicate) {
				// Lost the race against a concurrent delivery of the same
				// Message-ID between the check above and this INSERT.
				existing, lerr := s.existingMailIDByExternalRef(ctx, tx, in.OrgID, in.ExternalMessageID)
				if lerr != nil {
					return lerr
				}
				duplicateID = existing
			}
			return ierr
		}
		if werr := s.writeMailRecipients(ctx, tx, in.OrgID, mailID, recipients); werr != nil {
			return werr
		}

		preview := mailPreview(in.Subject, in.BodyText)
		// peer_user_id stays NULL: the sender has no account here, so there is
		// no person in the directory for the People sidebar to file this under.
		// The row still appears in the "All" feed, which is where an external
		// mail belongs.
		if err := s.deliverMailToOwners(ctx, tx, in.OrgID, mailID, locals,
			nil, preview, nil, in.SentAt, 1); err != nil {
			return err
		}
		delivered = len(locals)

		return insertOutbox(ctx, tx, mailID, events.MailDelivered{
			Type:       events.TypeMailDelivered,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      in.OrgID,
			OccurredAt: nowISO(),
			MailID:     mailID,
			Members:    locals,
		})
	})
	if err != nil {
		if errors.Is(err, ErrMailDuplicate) {
			return duplicateID, 0, err
		}
		return "", 0, err
	}
	return mailID, delivered, nil
}

// existingMailIDByExternalRef resolves the mail this org already has for a
// given RFC 5322 Message-ID, or "" if none. Used to answer a duplicate
// delivery with the real mailID instead of an empty one — see
// DeliverInboundMail. Matches ANY status (SENT or RECEIVED): a locally-SENT
// mail backfilled with its external_message_id (routes/internal.go's
// external-ref endpoint, messaging-svc side) is exactly as much "already have
// it" as a previously-RECEIVED one.
func (s *Store) existingMailIDByExternalRef(ctx context.Context, tx pgx.Tx, orgID, externalMessageID string) (string, error) {
	externalMessageID = strings.TrimSpace(externalMessageID)
	if externalMessageID == "" {
		return "", nil
	}
	var id string
	err := tx.QueryRow(ctx, `
		SELECT id FROM mail_messages WHERE org_id = $1 AND external_message_id = $2`,
		orgID, externalMessageID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// insertInboundMail writes the mail row, failing cleanly on a redelivery.
func (s *Store) insertInboundMail(
	ctx context.Context, tx pgx.Tx, in InboundMailInput, from, mailID string,
) error {
	enc := func(v string) ([]byte, error) {
		return s.crypto.Encrypt(ctx, tx, in.OrgID, v)
	}
	fromEnc, err := enc(from)
	if err != nil {
		return err
	}
	nameEnc, err := enc(in.FromName)
	if err != nil {
		return err
	}
	subjEnc, err := enc(in.Subject)
	if err != nil {
		return err
	}
	bodyEnc, err := enc(in.BodyText)
	if err != nil {
		return err
	}
	var htmlEnc []byte
	if in.BodyHTML != "" {
		if htmlEnc, err = enc(in.BodyHTML); err != nil {
			return err
		}
	}
	ct, err := tx.Exec(ctx, `
		INSERT INTO mail_messages
		  (id, org_id, status, from_address_enc, from_name_enc, subject_enc,
		   body_text_enc, body_html_enc, external_message_id, sent_at)
		VALUES ($1, $2, 'RECEIVED', $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (org_id, external_message_id) WHERE external_message_id IS NOT NULL
		DO NOTHING`,
		mailID, in.OrgID, fromEnc, nameEnc, subjEnc, bodyEnc, htmlEnc,
		strings.TrimSpace(in.ExternalMessageID), in.SentAt)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrMailDuplicate
	}
	return nil
}
