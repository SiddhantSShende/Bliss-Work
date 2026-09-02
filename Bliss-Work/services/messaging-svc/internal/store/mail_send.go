package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// SendMailInput is one composed mail, straight off the composer.
type SendMailInput struct {
	OrgID    string
	UserID   string
	MailID   string
	To       []string
	Cc       []string
	Bcc      []string
	Subject  string
	BodyText string
}

// SendMailResult is what the composer needs to navigate to the sent mail.
type SendMailResult struct {
	MailID string `json:"mailId"`
	SentAt string `json:"sentAt"`
	// DeliveredInApp / QueuedExternal let the UI say what actually happened —
	// "sent to 2 people, 1 queued for delivery" is the honest answer when a
	// mail is addressed both inside and outside the org.
	DeliveredInApp int `json:"deliveredInApp"`
	QueuedExternal int `json:"queuedExternal"`
}

// mailPreviewRunes bounds the inbox_items preview. The row shows one line.
const mailPreviewRunes = 140

// mailPreview builds the single line the feed row shows: the subject, then as
// much of the body as fits. Matches what every mail client puts in a list row,
// and means a mail with no subject still reads as something rather than blank.
func mailPreview(subject, body string) string {
	subject = strings.TrimSpace(subject)
	body = strings.Join(strings.Fields(body), " ")
	preview := subject
	if preview == "" {
		preview = "(no subject)"
	}
	if body != "" {
		preview += " — " + body
	}
	return truncateRunes(preview, mailPreviewRunes)
}

func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i] + "…"
		}
		n++
	}
	return s
}

// SendMail turns a DRAFT into a SENT mail and delivers it.
//
// Everything below happens in ONE transaction: the recipient rows, the mailbox
// rows, the feed projections and both kinds of outbox event. A mail that was
// half-delivered — visible to two of its three recipients, or written to the
// database but never queued for SMTP — is not a state worth being able to
// reach, and the outbox pattern means the Kafka publish is covered by the same
// commit as the rows it describes.
func (s *Store) SendMail(ctx context.Context, in SendMailInput) (*SendMailResult, error) {
	if utf8.RuneCountInString(in.Subject) > MaxMailSubjectRunes {
		return nil, ErrMailSubjectTooLong
	}
	if utf8.RuneCountInString(in.BodyText) > MaxMailBodyRunes {
		return nil, ErrMailBodyTooLong
	}

	sentAt := time.Now().UTC()
	res := &SendMailResult{MailID: in.MailID, SentAt: sentAt.Format("2006-01-02T15:04:05.000Z")}

	err := s.withOrg(ctx, in.OrgID, func(tx pgx.Tx) error {
		author, err := loadSendableDraft(ctx, tx, in.OrgID, in.UserID, in.MailID)
		if err != nil {
			return err
		}

		recipients, err := resolveMailRecipients(ctx, tx, in.OrgID, in.To, in.Cc, in.Bcc)
		if err != nil {
			return err
		}

		if err := s.writeSentMail(ctx, tx, in, author, sentAt); err != nil {
			return err
		}
		if err := s.writeMailRecipients(ctx, tx, in.OrgID, in.MailID, recipients); err != nil {
			return err
		}

		// Attachments become permanent now that the mail they belong to exists
		// for other people. Until this point they were expiring-by-default so an
		// abandoned draft cannot leak blobs onto the volume forever.
		if _, err := tx.Exec(ctx,
			`UPDATE attachments SET expires_at = NULL
			  WHERE org_id = $1 AND scope = 'mail' AND scope_id = $2`,
			in.OrgID, in.MailID); err != nil {
			return err
		}

		preview := mailPreview(in.Subject, in.BodyText)
		locals, externals := splitMailDelivery(recipients, in.UserID)
		res.DeliveredInApp = len(locals)
		res.QueuedExternal = len(externals)

		if err := s.deliverMailInApp(ctx, tx, in, locals, preview, sentAt); err != nil {
			return err
		}
		// Every recipient but the author gets a real copy on the wire too, not
		// just `externals` — a colleague's in-app delivery just above puts the
		// mail in their BlissWork inbox, it does not put it in their actual
		// mailbox, and BlissWork mail is required to reach that too. Kept as its
		// own list rather than widening `externals` itself: `externals` still has
		// to mean exactly "left the org" everywhere else it's used —
		// SendMailResult.QueuedExternal and the composer's "delivering to N more"
		// copy both say that today, correctly, since a colleague already has
		// their copy the instant deliverMailInApp above returns and is not "N
		// more" pending anything.
		relayTo := relayRecipients(recipients, author.address)
		return s.queueMailOutbound(ctx, tx, in, author, recipients, relayTo, externals, sentAt)
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// mailAuthor is the From: identity stamped onto a sent mail, read from the org
// directory at send time so the delivered copy keeps the address it was
// actually sent from even if the account changes later.
type mailAuthor struct {
	address string
	name    string
}

// loadSendableDraft checks the draft exists, belongs to the caller, and has not
// already been sent, then returns the From identity to stamp on it.
//
// FOR UPDATE OF m: locks the same row requireOwnDraft locks (mail.go), for the
// same reason — without it, this and a concurrent DiscardMailDraft /
// SaveMailDraft / RemoveDraftAttachment can each see DRAFT before either
// commits. "OF m" rather than a bare FOR UPDATE because user_projection is on
// the nullable side of the LEFT JOIN; Postgres refuses to lock across an outer
// join, and the author's identity row is not what needs locking here anyway.
func loadSendableDraft(ctx context.Context, tx pgx.Tx, orgID, userID, mailID string) (mailAuthor, error) {
	var a mailAuthor
	var author *string
	var status string
	err := tx.QueryRow(ctx, `
		SELECT m.author_user_id::text, m.status,
		       COALESCE(up.email, ''), COALESCE(up.display_name, up.username, '')
		FROM mail_messages m
		LEFT JOIN user_projection up ON up.user_id = m.author_user_id
		WHERE m.id = $1 AND m.org_id = $2
		FOR UPDATE OF m`,
		mailID, orgID).Scan(&author, &status, &a.address, &a.name)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	if err != nil {
		return a, err
	}
	if author == nil || *author != userID {
		return a, ErrForbidden
	}
	// Re-sending is not an error the user can act on and not a state we want to
	// reach twice — a second send would fan out a second set of deliveries for
	// the same row. Idempotent at the API layer via the Idempotency-Key
	// middleware; this is the backstop for a genuine double-send.
	if status != MailStatusDraft {
		return a, ErrMailAlreadySent
	}
	return a, nil
}

// writeSentMail flips the draft to SENT and stores the encrypted content.
func (s *Store) writeSentMail(
	ctx context.Context, tx pgx.Tx, in SendMailInput, author mailAuthor, sentAt time.Time,
) error {
	subjectEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, in.Subject)
	if err != nil {
		return err
	}
	bodyEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, in.BodyText)
	if err != nil {
		return err
	}
	fromEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, author.address)
	if err != nil {
		return err
	}
	nameEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, author.name)
	if err != nil {
		return err
	}
	// The status='DRAFT' predicate is belt-and-suspenders on top of
	// loadSendableDraft's FOR UPDATE lock (which is what actually prevents two
	// concurrent sends of the same draft) — but checking RowsAffected is what
	// makes that predicate mean something. A 0-row match here must fail the
	// send, not be treated as success: every write below this point (recipient
	// rows, in-app delivery, the outbound Kafka batch) assumes it just flipped
	// the mail to SENT for the first time.
	tag, err := tx.Exec(ctx, `
		UPDATE mail_messages
		SET status = 'SENT', subject_enc = $3, body_text_enc = $4,
		    from_address_enc = $5, from_name_enc = $6, sent_at = $7, updated_at = now()
		WHERE id = $1 AND org_id = $2 AND status = 'DRAFT'`,
		in.MailID, in.OrgID, subjectEnc, bodyEnc, fromEnc, nameEnc, sentAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrMailAlreadySent
	}
	return nil
}

// writeMailRecipients stores the To/Cc/Bcc header, addresses encrypted.
//
// The draft's own recipient rows are cleared first. A draft carries whatever
// was autosaved into it (SaveMailDraft), and the composer can have removed an
// addressee since: an upsert keyed on (kind, position) would leave that row
// behind and mail somebody the sender took off the list.
func (s *Store) writeMailRecipients(
	ctx context.Context, tx pgx.Tx, orgID, mailID string, recipients []resolvedAddress,
) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM mail_recipients WHERE mail_id = $1 AND org_id = $2`,
		mailID, orgID); err != nil {
		return err
	}
	for _, r := range recipients {
		addrEnc, err := s.crypto.Encrypt(ctx, tx, orgID, r.address)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO mail_recipients (mail_id, org_id, kind, position, address_enc, user_id)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (mail_id, kind, position) DO UPDATE
			SET address_enc = EXCLUDED.address_enc, user_id = EXCLUDED.user_id`,
			mailID, orgID, r.kind, r.pos, addrEnc, r.userID); err != nil {
			return err
		}
	}
	return nil
}

// splitMailDelivery separates the recipients into the local user ids that get an
// in-app delivery and the addresses that have to leave over SMTP.
//
// The author is dropped from `locals` even when they addressed themselves: they
// already get a SENT-folder row, and a second INBOX row for the same mail would
// collide on the mail_deliveries primary key.
func splitMailDelivery(recipients []resolvedAddress, authorID string) (locals []string, externals []string) {
	seenUser := map[string]bool{authorID: true}
	seenAddr := map[string]bool{}
	for _, r := range recipients {
		if r.userID != nil {
			if !seenUser[*r.userID] {
				seenUser[*r.userID] = true
				locals = append(locals, *r.userID)
			}
			continue
		}
		if !seenAddr[r.address] {
			seenAddr[r.address] = true
			externals = append(externals, r.address)
		}
	}
	return locals, externals
}

// relayRecipients is every distinct recipient address — local org members
// included — that should receive a real copy of the mail over SMTP/provider
// send, minus the author's own address (self-send guard, same rule
// splitMailDelivery applies to the author's in-app copy).
//
// Deliberately not the same list as splitMailDelivery's `externals`: that one
// means "left the org" everywhere else it is used (SendMailResult and the
// composer's "delivering to N more" copy), and must keep meaning exactly
// that. This one means "gets a wire copy," which today is everybody.
func relayRecipients(recipients []resolvedAddress, authorAddress string) []string {
	seen := map[string]bool{strings.ToLower(authorAddress): true}
	out := make([]string, 0, len(recipients))
	for _, r := range recipients {
		if seen[r.address] {
			continue
		}
		seen[r.address] = true
		out = append(out, r.address)
	}
	return out
}
