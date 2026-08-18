package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// GetMail returns one complete mail for a caller who is entitled to read it.
//
// Entitlement is the mail_deliveries row and nothing else: being in the org, or
// knowing the id, is not enough. That single check covers author, To, Cc and
// Bcc alike, and is the same rule the attachment download re-runs on every hit.
func (s *Store) GetMail(ctx context.Context, orgID, userID, mailID string) (*MailDTO, error) {
	var d MailDTO
	d.MailID = mailID
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var (
			sentAt                                      *time.Time
			readAt                                      *time.Time
			fromEnc, nameEnc, subjEnc, bodyEnc, htmlEnc []byte
			author                                      *string
		)
		qerr := tx.QueryRow(ctx, `
			SELECT d.folder, d.read_at, m.status, m.author_user_id::text, m.sent_at,
			       m.from_address_enc, m.from_name_enc, m.subject_enc,
			       m.body_text_enc, m.body_html_enc
			FROM mail_deliveries d
			JOIN mail_messages m ON m.id = d.mail_id AND m.org_id = d.org_id
			WHERE d.mail_id = $1 AND d.owner_user_id = $2 AND d.org_id = $3`,
			mailID, userID, orgID).Scan(
			&d.Folder, &readAt, &d.Status, &author, &sentAt,
			&fromEnc, &nameEnc, &subjEnc, &bodyEnc, &htmlEnc)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if qerr != nil {
			return qerr
		}
		d.FromUserID = author
		if sentAt != nil {
			d.SentAt = sentAt.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		if readAt != nil {
			r := readAt.UTC().Format("2006-01-02T15:04:05.000Z")
			d.ReadAt = &r
		}

		// Decrypt only AFTER the row's cursor is drained — Decrypt issues its own
		// query on the same tx, and pgx will not run one while another is open.
		dec := func(blob []byte) (string, error) {
			if blob == nil {
				return "", nil
			}
			return s.crypto.Decrypt(ctx, tx, orgID, blob)
		}
		var derr error
		if d.FromAddress, derr = dec(fromEnc); derr != nil {
			return derr
		}
		if d.FromName, derr = dec(nameEnc); derr != nil {
			return derr
		}
		if d.Subject, derr = dec(subjEnc); derr != nil {
			return derr
		}
		if d.BodyText, derr = dec(bodyEnc); derr != nil {
			return derr
		}
		if htmlEnc != nil {
			html, herr := dec(htmlEnc)
			if herr != nil {
				return herr
			}
			d.BodyHTML = &html
		}

		isAuthor := author != nil && *author == userID
		recips, rerr := s.loadMailRecipients(ctx, tx, orgID, mailID, userID, isAuthor)
		if rerr != nil {
			return rerr
		}
		d.Recipients = recips

		atts, aerr := s.loadMailAttachments(ctx, tx, orgID, mailID)
		if aerr != nil {
			return aerr
		}
		d.Attachments = atts
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// loadMailRecipients returns the header this particular reader is entitled to
// see.
//
// Bcc is the whole reason this takes a viewer: the author sees the list they
// typed, everyone else sees To and Cc — plus their OWN Bcc entry, because a
// person who was blind-copied is entitled to know that is how the mail reached
// them, and hiding it would make the mail look misaddressed.
func (s *Store) loadMailRecipients(
	ctx context.Context, tx pgx.Tx, orgID, mailID, viewerID string, isAuthor bool,
) ([]MailRecipientDTO, error) {
	type raw struct {
		kind    string
		encAddr []byte
		userID  *string
		name    *string
	}
	rows, err := tx.Query(ctx, `
		SELECT r.kind, r.address_enc, r.user_id::text,
		       COALESCE(up.display_name, up.username)
		FROM mail_recipients r
		LEFT JOIN user_projection up ON up.user_id = r.user_id
		WHERE r.mail_id = $1 AND r.org_id = $2
		  AND ($3 OR r.kind <> 'BCC' OR r.user_id::text = $4)
		ORDER BY CASE r.kind WHEN 'TO' THEN 0 WHEN 'CC' THEN 1 ELSE 2 END, r.position`,
		mailID, orgID, isAuthor, viewerID)
	if err != nil {
		return nil, err
	}
	var raws []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.kind, &r.encAddr, &r.userID, &r.name); err != nil {
			rows.Close()
			return nil, err
		}
		raws = append(raws, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]MailRecipientDTO, 0, len(raws))
	for _, r := range raws {
		addr, derr := s.crypto.Decrypt(ctx, tx, orgID, r.encAddr)
		if derr != nil {
			return nil, derr
		}
		out = append(out, MailRecipientDTO{
			Kind: r.kind, Address: addr, UserID: r.userID, DisplayName: r.name,
		})
	}
	return out, nil
}

// loadMailAttachments lists the files on a mail. Thumbnails are excluded: they
// are a rendering detail of their parent, not separate attachments.
func (s *Store) loadMailAttachments(
	ctx context.Context, tx pgx.Tx, orgID, mailID string,
) ([]MailAttachmentDTO, error) {
	type raw struct {
		a       MailAttachmentDTO
		nameEnc []byte
		namePln *string
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, filename, filename_enc, mime, size_bytes
		FROM attachments
		WHERE org_id = $1 AND scope = 'mail' AND scope_id = $2 AND role = 'file'
		ORDER BY created_at`,
		orgID, mailID)
	if err != nil {
		return nil, err
	}
	var raws []raw
	for rows.Next() {
		var r raw
		if err := rows.Scan(&r.a.ID, &r.namePln, &r.nameEnc, &r.a.Mime, &r.a.SizeBytes); err != nil {
			rows.Close()
			return nil, err
		}
		raws = append(raws, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]MailAttachmentDTO, 0, len(raws))
	for _, r := range raws {
		a := r.a
		if r.nameEnc != nil {
			name, derr := s.crypto.Decrypt(ctx, tx, orgID, r.nameEnc)
			if derr != nil {
				return nil, derr
			}
			a.Filename = name
		} else if r.namePln != nil {
			a.Filename = *r.namePln
		}
		out = append(out, a)
	}
	return out, nil
}

// MarkMailRead stamps read_at and clears the feed row's unread badge.
//
// Idempotent: read_at is only set the first time (COALESCE), so re-opening a
// mail does not keep moving the timestamp forward, and the unread reset is a
// no-op on a row that is already at zero.
func (s *Store) MarkMailRead(ctx context.Context, orgID, userID, mailID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE mail_deliveries
			SET read_at = COALESCE(read_at, now())
			WHERE mail_id = $1 AND owner_user_id = $2 AND org_id = $3`,
			mailID, userID, orgID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `
			UPDATE inbox_items
			SET unread_count = 0, updated_at = now()
			WHERE owner_user_id = $1 AND item_kind = 'MAIL' AND ref_id = $2`,
			userID, mailID)
		return err
	})
}

// requireMailReader is the attachments.scope='mail' membership rule. Same
// predicate as GetMail, which is the point: one definition of "may read this
// mail" serves the mail itself and every file on it.
func requireMailReader(ctx context.Context, tx pgx.Tx, orgID, mailID, userID string) error {
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
		    SELECT 1 FROM mail_deliveries
		    WHERE mail_id = $1 AND owner_user_id = $2 AND org_id = $3
		)`, mailID, userID, orgID).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	return nil
}
