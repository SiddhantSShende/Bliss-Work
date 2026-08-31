package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Mail row states. See migrations/0023_mail.sql for what each one means.
const (
	MailStatusDraft    = "DRAFT"
	MailStatusSent     = "SENT"
	MailStatusReceived = "RECEIVED"
)

// Which of a person's two mailboxes a delivery lands in.
const (
	MailFolderInbox = "INBOX"
	MailFolderSent  = "SENT"
)

// Recipient header a delivery came through.
const (
	MailKindTo  = "TO"
	MailKindCc  = "CC"
	MailKindBcc = "BCC"
)

// Limits. These bound what one send can cost: the row itself, the outbox
// payload it becomes, and the Kafka message that carries it — the same three
// things MaxMessageBodyBytes bounds for a chat message.
const (
	MaxMailSubjectRunes = 200
	MaxMailBodyRunes    = 100_000
	MaxMailRecipients   = 50
	MaxMailAddressLen   = 254 // RFC 5321 §4.5.3.1.3
)

// Errors specific to composing mail. Each maps to a distinct 4xx so the
// composer can point at the field that is actually wrong rather than saying
// "could not send".
var (
	ErrMailNoRecipients   = errors.New("a mail needs at least one recipient")
	ErrMailTooManyAddrs   = fmt.Errorf("at most %d recipients per mail", MaxMailRecipients)
	ErrMailSubjectTooLong = fmt.Errorf("subject must be at most %d characters", MaxMailSubjectRunes)
	ErrMailBodyTooLong    = fmt.Errorf("body must be at most %d characters", MaxMailBodyRunes)
	ErrMailAlreadySent    = errors.New("this mail has already been sent")
	ErrMailInvalidAddress = errors.New("invalid email address")
	ErrMailNoDeliverable  = errors.New("none of these addresses could be delivered to")
)

// InvalidAddressError names the address that failed validation so the composer
// can highlight the offending chip instead of the whole field.
type InvalidAddressError struct{ Address string }

func (e *InvalidAddressError) Error() string {
	return fmt.Sprintf("invalid email address: %s", e.Address)
}
func (e *InvalidAddressError) Unwrap() error { return ErrMailInvalidAddress }

// Deliberately permissive, and deliberately the SAME shape as email-worker's
// is_valid_email (services/email-worker/app/mailer.py). Full RFC 5322 is not
// worth the complexity: this exists to reject the garbage that would otherwise
// be handed to SMTP and bounce, and the two ends must agree on what passes or
// a mail accepted here fails silently at the relay.
var mailAddressRE = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// NormalizeMailAddress trims and lower-cases an address for storage, comparison
// and directory lookup. Returns "" for anything that isn't deliverable.
//
// Lower-casing the local part is technically lossy — RFC 5321 says only the
// domain is case-insensitive — but no mail system in practical use treats
// "Jane@" and "jane@" as different people, and matching the org directory
// depends on both sides agreeing.
func NormalizeMailAddress(raw string) string {
	a := strings.ToLower(strings.TrimSpace(raw))
	if a == "" || len(a) > MaxMailAddressLen || !mailAddressRE.MatchString(a) {
		return ""
	}
	return a
}

// MailRecipientDTO is one addressee as shown in a mail header.
type MailRecipientDTO struct {
	Kind    string `json:"kind"` // TO | CC | BCC
	Address string `json:"address"`
	// UserID is set when the address resolved to a member of this org at send
	// time — the client uses it to render a real name and avatar instead of a
	// bare address.
	UserID      *string `json:"userId"`
	DisplayName *string `json:"displayName"`
}

// MailAttachmentDTO is one file on a mail. Mirrors the chat attachment shape so
// the renderer can reuse the same download plumbing.
type MailAttachmentDTO struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	Mime      string `json:"mime"`
	SizeBytes int64  `json:"sizeBytes"`
}

// MailDTO is one complete email, as returned by GET /mail/{id}.
type MailDTO struct {
	MailID string `json:"mailId"`
	Status string `json:"status"`
	// Folder is the CALLER's view of this mail: SENT if they wrote it, INBOX if
	// it was delivered to them. The same row is both, seen from two sides.
	Folder      string  `json:"folder"`
	FromAddress string  `json:"fromAddress"`
	FromName    string  `json:"fromName"`
	FromUserID  *string `json:"fromUserId"`
	Subject     string  `json:"subject"`
	BodyText    string  `json:"bodyText"`
	// BodyHTML is only ever populated for inbound mail that arrived as
	// multipart/alternative. Untrusted markup — the renderer must not inject it.
	BodyHTML    *string             `json:"bodyHtml"`
	Recipients  []MailRecipientDTO  `json:"recipients"`
	Attachments []MailAttachmentDTO `json:"attachments"`
	SentAt      string              `json:"sentAt"`
	ReadAt      *string             `json:"readAt"`
}

// CreateMailDraft opens a draft and returns its id.
//
// Called when the composer OPENS, not when Send is pressed, because an
// attachment upload has to be authorized against a destination that already
// exists (attachments.scope='mail', scope_id=this id — see 0023_mail.sql). The
// author's mail_deliveries row is what that authorization reads.
//
// A draft is invisible: no inbox_items row is written until it is sent, so an
// abandoned one costs a row and nothing else. DiscardMailDraft removes it when
// the composer is closed without sending.
func (s *Store) CreateMailDraft(ctx context.Context, orgID, userID string) (string, error) {
	mailID := uuid.Must(uuid.NewV7()).String()
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mail_messages (id, org_id, status, author_user_id)
			VALUES ($1, $2, 'DRAFT', $3)`,
			mailID, orgID, userID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO mail_deliveries (mail_id, owner_user_id, org_id, folder)
			VALUES ($1, $2, $3, 'SENT')
			ON CONFLICT (mail_id, owner_user_id) DO NOTHING`,
			mailID, userID, orgID)
		return err
	})
	if err != nil {
		return "", err
	}
	return mailID, nil
}

// DiscardMailDraft deletes an unsent draft.
//
// Only the author, and only while the mail is still a DRAFT — once sent, a mail
// is other people's copy too and deleting it is not one person's call.
//
// Its attachment rows are deliberately LEFT ALONE. They are still
// expiring-by-default (SendMail is what clears expires_at), and the reaper
// finds a blob to unlink by looking for a lapsed ROW — so deleting the rows
// here would delete the only record of the files and strand their bytes on the
// volume permanently. Leaving them lets the ordinary sweep collect both. They
// are unreadable in the meantime: the mail_deliveries row that authorized them
// cascades away with the draft, so requireMailReader denies every caller.
func (s *Store) DiscardMailDraft(ctx context.Context, orgID, userID, mailID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireOwnDraft(ctx, tx, orgID, userID, mailID); err != nil {
			return err
		}
		// The status predicate here is belt-and-suspenders on top of the FOR
		// UPDATE lock requireOwnDraft just took: that lock is what actually
		// stops a concurrent SendMail from being deleted out from under its own
		// recipients (mail_recipients / mail_deliveries cascade off this row),
		// but a bare DELETE with no predicate of its own would silently do the
		// wrong thing the moment anything ever calls this without going through
		// requireOwnDraft first.
		tag, err := tx.Exec(ctx,
			`DELETE FROM mail_messages WHERE id = $1 AND org_id = $2 AND status = 'DRAFT'`,
			mailID, orgID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrMailAlreadySent
		}
		return nil
	})
}

// requireOwnDraft is the rule shared by every operation that writes to a draft:
// it must exist, it must be the caller's, and it must still be unsent.
//
// One definition because the three failures are meaningfully different and each
// caller must report the same one — a draft somebody else owns is ErrForbidden,
// not ErrNotFound, and a draft that has already left is neither.
//
// FOR UPDATE: every caller of this function goes on to write based on the
// status it returns (delete the row, overwrite the body, drop an attachment).
// A plain SELECT here would let one of those writes run concurrently with
// SendMail's own status flip — both transactions see DRAFT, SendMail commits
// first, and the other proceeds to mutate (or delete) a mail that has already
// gone out to other people. The lock is what makes "read DRAFT, then act on
// it" a single atomic step for the lifetime of the caller's transaction.
func requireOwnDraft(ctx context.Context, tx pgx.Tx, orgID, userID, mailID string) error {
	var author *string
	var status string
	err := tx.QueryRow(ctx, `
		SELECT author_user_id::text, status FROM mail_messages
		WHERE id = $1 AND org_id = $2
		FOR UPDATE`, mailID, orgID).Scan(&author, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if author == nil || *author != userID {
		return ErrForbidden
	}
	if status != MailStatusDraft {
		return ErrMailAlreadySent
	}
	return nil
}

// resolvedAddress is one validated recipient plus the local account it belongs
// to, if any. userID == nil means the address is outside this org and its copy
// has to go out over SMTP.
type resolvedAddress struct {
	kind    string
	pos     int
	address string
	userID  *string
}

// resolveMailRecipients validates every address and looks each one up in the
// org directory, preserving the order the sender typed.
//
// Resolution happens ONCE, here, at send time. Doing it at read time instead
// would mean a colleague who later leaves the org retroactively turns a
// delivered mail into an undelivered one.
func resolveMailRecipients(
	ctx context.Context, tx pgx.Tx, orgID string, to, cc, bcc []string,
) ([]resolvedAddress, error) {
	groups := []struct {
		kind string
		list []string
	}{{MailKindTo, to}, {MailKindCc, cc}, {MailKindBcc, bcc}}

	out := make([]resolvedAddress, 0, MaxMailRecipients)
	// One address may legitimately appear in two headers (To and Cc); the
	// header keeps both, but the person is only delivered to once — dedup
	// happens at the delivery step, not here.
	total := 0
	for _, g := range groups {
		for i, raw := range g.list {
			addr := NormalizeMailAddress(raw)
			if addr == "" {
				return nil, &InvalidAddressError{Address: strings.TrimSpace(raw)}
			}
			total++
			if total > MaxMailRecipients {
				return nil, ErrMailTooManyAddrs
			}
			out = append(out, resolvedAddress{kind: g.kind, pos: i, address: addr})
		}
	}
	if len(out) == 0 {
		return nil, ErrMailNoRecipients
	}

	// One round trip for the whole list rather than one per address: a 50-way
	// send would otherwise be 50 queries inside the send transaction.
	addrs := make([]string, len(out))
	for i, r := range out {
		addrs[i] = r.address
	}
	rows, err := tx.Query(ctx, `
		SELECT lower(email), user_id::text
		FROM user_projection
		WHERE org_id = $1 AND email IS NOT NULL AND active AND lower(email) = ANY($2::text[])`,
		orgID, addrs)
	if err != nil {
		return nil, err
	}
	local := make(map[string]string, len(out))
	for rows.Next() {
		var email, userID string
		if err := rows.Scan(&email, &userID); err != nil {
			rows.Close()
			return nil, err
		}
		local[email] = userID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if id, ok := local[out[i].address]; ok {
			uid := id
			out[i].userID = &uid
		}
	}
	return out, nil
}
