package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// MaxMailDrafts bounds one Drafts listing. Drafts are one person's unsent mail,
// not a feed: a mailbox with more than this is a runaway composer, and paging a
// folder nobody scrolls would be plumbing for a case that does not occur.
const MaxMailDrafts = 200

// MailDraftDTO is one row of the Drafts folder.
//
// Deliberately NOT an InboxItemDTO. A draft has no counterparty, no unread
// state and no last event — it has addressees the author typed and a moment
// they last touched it — and pushing it through the feed's shape would mean
// inventing three fields to leave empty.
type MailDraftDTO struct {
	MailID string `json:"mailId"`
	// Preview is the same `subject — body` line the feed carries for a sent
	// mail, built by the same function, so the Drafts folder reads like every
	// other folder rather than like a different list that happens to sit beside
	// them.
	Preview string `json:"preview"`
	// To is the addressees typed so far, in order, for the row's "to …" line.
	// Empty is an ordinary state: a draft is frequently written before it is
	// addressed.
	To              []string `json:"to"`
	AttachmentCount int      `json:"attachmentCount"`
	UpdatedAt       string   `json:"updatedAt"`
}

// SaveMailDraftInput is the composer's autosave.
//
// The addresses are whatever is in the fields right now — this is a draft, so
// a half-typed address is expected and is stored as typed rather than rejected.
// Validation and directory resolution stay where they have always been: at
// send, in resolveMailRecipients.
type SaveMailDraftInput struct {
	OrgID    string
	UserID   string
	MailID   string
	To       []string
	Cc       []string
	Bcc      []string
	Subject  string
	BodyText string
	// AttachmentTTL renews the expiry on files already uploaded to this draft.
	// A draft's blobs are expiring-by-default so an abandoned compose cannot
	// leak them onto the volume (SendMail is what makes them permanent), but a
	// draft that is still being edited a week later must not lose its files to
	// that sweep. Every save pushes the deadline out again, so the TTL becomes
	// "gone this long after the author last touched it".
	AttachmentTTL time.Duration
}

// SaveMailDraft writes the composer's current contents onto an unsent draft.
//
// Author-only and draft-only, via requireOwnDraft: a mail that has been sent is
// other people's copy and is not editable by anybody, which is also what stops
// this becoming a way to rewrite delivered mail.
func (s *Store) SaveMailDraft(ctx context.Context, in SaveMailDraftInput) error {
	if utf8.RuneCountInString(in.Subject) > MaxMailSubjectRunes {
		return ErrMailSubjectTooLong
	}
	if utf8.RuneCountInString(in.BodyText) > MaxMailBodyRunes {
		return ErrMailBodyTooLong
	}
	typed := draftAddresses(in.To, in.Cc, in.Bcc)
	if len(typed) > MaxMailRecipients {
		return ErrMailTooManyAddrs
	}

	return s.withOrg(ctx, in.OrgID, func(tx pgx.Tx) error {
		if err := requireOwnDraft(ctx, tx, in.OrgID, in.UserID, in.MailID); err != nil {
			return err
		}

		subjectEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, in.Subject)
		if err != nil {
			return err
		}
		bodyEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, in.BodyText)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE mail_messages
			SET subject_enc = $3, body_text_enc = $4, updated_at = now()
			WHERE id = $1 AND org_id = $2 AND status = 'DRAFT'`,
			in.MailID, in.OrgID, subjectEnc, bodyEnc); err != nil {
			return err
		}

		// Replaced wholesale rather than upserted by (kind, position): removing
		// the second of two addressees has to remove a ROW, and an upsert keyed
		// on position would leave the old one behind at position 1.
		if _, err := tx.Exec(ctx,
			`DELETE FROM mail_recipients WHERE mail_id = $1 AND org_id = $2`,
			in.MailID, in.OrgID); err != nil {
			return err
		}
		if len(typed) > 0 {
			kinds := make([]string, len(typed))
			positions := make([]int32, len(typed))
			addrEncs := make([][]byte, len(typed))
			for i, r := range typed {
				addrEnc, eerr := s.crypto.Encrypt(ctx, tx, in.OrgID, r.address)
				if eerr != nil {
					return eerr
				}
				kinds[i] = r.kind
				positions[i] = int32(r.pos)
				addrEncs[i] = addrEnc
			}
			// One round trip for the whole autosave, not one per typed address —
			// this fires on every composer autosave tick. user_id stays NULL:
			// resolving an address against the directory is a send-time decision
			// (see resolveMailRecipients), and a draft that pre-resolved it would
			// go stale the moment somebody joins or leaves.
			if _, err := tx.Exec(ctx, `
				INSERT INTO mail_recipients (mail_id, org_id, kind, position, address_enc, user_id)
				SELECT $1, $2, u.kind, u.position, u.address_enc, NULL
				  FROM unnest($3::text[], $4::int[], $5::bytea[]) AS u(kind, position, address_enc)`,
				in.MailID, in.OrgID, kinds, positions, addrEncs); err != nil {
				return err
			}
		}

		if in.AttachmentTTL <= 0 {
			return nil
		}
		_, err = tx.Exec(ctx, `
			UPDATE attachments
			SET expires_at = now() + make_interval(secs => $3)
			WHERE org_id = $1 AND scope = 'mail' AND scope_id = $2
			  AND expires_at IS NOT NULL`,
			in.OrgID, in.MailID, in.AttachmentTTL.Seconds())
		return err
	})
}

// draftAddresses flattens the three fields into storable rows, dropping blanks
// and keeping the order the author typed.
//
// Positions are re-numbered per kind AFTER the blanks are dropped, so they stay
// dense — the primary key is (mail_id, kind, position) and a gap would only
// make the next save's ordering harder to reason about.
func draftAddresses(to, cc, bcc []string) []resolvedAddress {
	groups := []struct {
		kind string
		list []string
	}{{MailKindTo, to}, {MailKindCc, cc}, {MailKindBcc, bcc}}

	out := make([]resolvedAddress, 0, len(to)+len(cc)+len(bcc))
	for _, g := range groups {
		pos := 0
		for _, raw := range g.list {
			addr := strings.TrimSpace(raw)
			if addr == "" || len(addr) > MaxMailAddressLen {
				continue
			}
			out = append(out, resolvedAddress{kind: g.kind, pos: pos, address: addr})
			pos++
		}
	}
	return out
}

// ListMailDrafts returns the caller's unsent mail, most recently edited first.
//
// Empty drafts are excluded. Every composer open creates a row before anything
// is typed (attachments need a destination that already exists), so a compose
// abandoned by a closed tab — where the client never got to discard it — leaves
// one behind. A row with no subject, no body, no addressee and no file is not
// something the author wrote, and listing it would make the folder fill up with
// evidence of opening the composer.
func (s *Store) ListMailDrafts(ctx context.Context, orgID, userID string) ([]MailDraftDTO, error) {
	type rawDraft struct {
		d          MailDraftDTO
		updatedAt  time.Time
		subjectEnc []byte
		bodyEnc    []byte
	}

	out := make([]MailDraftDTO, 0, 16)
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT m.id::text, m.subject_enc, m.body_text_enc, m.updated_at,
			       (SELECT count(*) FROM attachments a
			         WHERE a.org_id = m.org_id AND a.scope = 'mail'
			           AND a.scope_id = m.id AND a.role = 'file') AS attachment_count,
			       EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id) AS has_recipients
			FROM mail_messages m
			WHERE m.author_user_id = $1 AND m.org_id = $2 AND m.status = 'DRAFT'
			ORDER BY m.updated_at DESC
			LIMIT $3`,
			userID, orgID, MaxMailDrafts)
		if err != nil {
			return err
		}
		var raws []rawDraft
		for rows.Next() {
			var r rawDraft
			var hasRecipients bool
			if err := rows.Scan(&r.d.MailID, &r.subjectEnc, &r.bodyEnc, &r.updatedAt,
				&r.d.AttachmentCount, &hasRecipients); err != nil {
				rows.Close()
				return err
			}
			if r.subjectEnc == nil && r.bodyEnc == nil && !hasRecipients && r.d.AttachmentCount == 0 {
				continue
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(raws) == 0 {
			return nil
		}

		// Decrypt only after the cursor is drained — Decrypt issues its own
		// query on the same tx, and pgx will not run one while another is open.
		ids := make([]string, len(raws))
		for i, r := range raws {
			ids[i] = r.d.MailID
			subject, derr := s.decryptOrEmpty(ctx, tx, orgID, r.subjectEnc)
			if derr != nil {
				return derr
			}
			body, derr := s.decryptOrEmpty(ctx, tx, orgID, r.bodyEnc)
			if derr != nil {
				return derr
			}
			raws[i].d.Preview = mailPreview(subject, body)
			raws[i].d.UpdatedAt = isoTime(r.updatedAt)
		}

		// One query for every draft's To line rather than one per draft: a
		// folder of 50 drafts would otherwise be 51 round trips.
		byMail, terr := s.loadDraftToLines(ctx, tx, orgID, ids)
		if terr != nil {
			return terr
		}
		for _, r := range raws {
			d := r.d
			d.To = byMail[d.MailID]
			if d.To == nil {
				d.To = []string{}
			}
			out = append(out, d)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// loadDraftToLines returns each draft's To addresses, in the order they were
// typed. Cc and Bcc are left out: the row shows who a draft is addressed to,
// and the composer is one click away for the rest.
func (s *Store) loadDraftToLines(
	ctx context.Context, tx pgx.Tx, orgID string, mailIDs []string,
) (map[string][]string, error) {
	type rawAddr struct {
		mailID string
		enc    []byte
	}
	rows, err := tx.Query(ctx, `
		SELECT mail_id::text, address_enc
		FROM mail_recipients
		WHERE org_id = $1 AND mail_id = ANY($2::uuid[]) AND kind = 'TO'
		ORDER BY mail_id, position`,
		orgID, mailIDs)
	if err != nil {
		return nil, err
	}
	var raws []rawAddr
	for rows.Next() {
		var r rawAddr
		if err := rows.Scan(&r.mailID, &r.enc); err != nil {
			rows.Close()
			return nil, err
		}
		raws = append(raws, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	byMail := make(map[string][]string, len(mailIDs))
	for _, r := range raws {
		addr, derr := s.decryptOrEmpty(ctx, tx, orgID, r.enc)
		if derr != nil {
			return nil, derr
		}
		byMail[r.mailID] = append(byMail[r.mailID], addr)
	}
	return byMail, nil
}

// decryptOrEmpty decrypts a nullable ciphertext column. A NULL is a field the
// author never filled in, which is "" — not an error.
func (s *Store) decryptOrEmpty(ctx context.Context, tx pgx.Tx, orgID string, blob []byte) (string, error) {
	if blob == nil {
		return "", nil
	}
	return s.crypto.Decrypt(ctx, tx, orgID, blob)
}

// RemoveDraftAttachment takes one file off an unsent draft and, if nothing in
// the org points at those bytes any more, calls unlink(sha) to delete them.
//
// Deleting the ROW is what makes the removal real: SendMail commits every
// attachment still scoped to the mail (`expires_at = NULL`), so a file merely
// marked as expiring would be resurrected — and sent — by the next Send. The
// row goes first and the blob after, for the reason ReapExpiredAttachments
// gives: the reverse order would let a concurrent dedupe hand out a path to a
// file about to be unlinked.
//
// unlink runs INSIDE the transaction, under the per-blob lock CreateAttachment
// also takes (NewAttachment.BlobPresent). Unlinking after the commit left a
// window in which a concurrent upload of the same bytes — which dedupes onto the
// existing blob and records a row for it — could land between this reference
// check and the unlink, leaving a row that points at a deleted file. unlink must
// not fail the removal: the row is already gone and a leaked file is only disk.
// A nil unlink only reports the hash, as before.
//
// Author-only and draft-only via requireOwnDraft, and the delete is additionally
// scoped to this mail — holding one attachment id must not reach files on
// somebody else's mail.
func (s *Store) RemoveDraftAttachment(
	ctx context.Context, orgID, userID, mailID, attachmentID string,
	unlink func(sha string),
) (unreferencedSHA string, err error) {
	err = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if derr := requireOwnDraft(ctx, tx, orgID, userID, mailID); derr != nil {
			return derr
		}
		var sha string
		// Thumbnails hang off the file by parent_attachment_id and have no life
		// of their own, so they go in the same statement.
		qerr := tx.QueryRow(ctx, `
			WITH gone AS (
			    DELETE FROM attachments
			    WHERE org_id = $1 AND scope = 'mail' AND scope_id = $2
			      AND (id = $3 OR parent_attachment_id = $3)
			    RETURNING sha256, role
			)
			SELECT sha256 FROM gone WHERE role = 'file'`,
			orgID, mailID, attachmentID).Scan(&sha)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if qerr != nil {
			return qerr
		}

		// Taken after the DELETE, before looking for other references: an upload
		// that holds the lock has either committed its row (seen below, so the
		// file stays) or not started (and will find the file gone).
		if lerr := lockAttachmentBlob(ctx, tx, orgID, sha); lerr != nil {
			return lerr
		}
		var stillReferenced bool
		if cerr := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM attachments WHERE org_id = $1 AND sha256 = $2)`,
			orgID, sha).Scan(&stillReferenced); cerr != nil {
			return cerr
		}
		if !stillReferenced {
			unreferencedSHA = sha
			if unlink != nil {
				unlink(sha)
			}
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return unreferencedSHA, nil
}
