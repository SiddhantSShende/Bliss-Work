package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// RecordMailAttachmentDownload writes a mail.attachment.downloaded outbox event
// for userID having started a download of attachmentID on mailID.
//
// The admin-facing activity timeline is the ONLY consumer (telemetry-svc maps
// it to an activity row). It deliberately posts nothing into the mail, tells
// nobody, and has no in-app notice: a "your attachment was downloaded" signal
// to the sender is a read-receipt-style disclosure that was explicitly ruled
// out. It is "download initiated" — the bytes are served by GET /media, which
// this does not touch and which a client could fetch whether or not it ever
// calls this.
//
// Validation, in this order:
//
//  1. userID must be able to read the mail (requireMailReader, the same rule
//     GetMail and every GET /media hit use) → ErrForbidden otherwise. Done
//     FIRST, so a non-reader gets the same answer whether or not the
//     attachment/mail pair is real — the pair is no oracle for outsiders.
//  2. The attachment must be a role='file' row of scope 'mail' whose scope_id is
//     mailID → ErrNotFound for anything else (another mail's file, a chat
//     file, a thumbnail, an unknown id), indistinguishably, exactly as
//     attachmentForActivity answers a scope mismatch.
//
// The actor is a parameter the HTTP layer takes from the verified JWT; nothing
// in the request body can name another user.
//
// Every call writes its own event with its own eventId. There is deliberately
// no server-side collapsing: two downloads minutes apart are two real
// downloads, and the client is what guards an accidental double-click.
func (s *Store) RecordMailAttachmentDownload(ctx context.Context, orgID, userID, mailID, attachmentID string) error {
	if _, err := uuid.Parse(mailID); err != nil {
		return ErrNotFound
	}
	if _, err := uuid.Parse(attachmentID); err != nil {
		return ErrNotFound
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireMailReader(ctx, tx, orgID, mailID, userID); err != nil {
			return err
		}

		var (
			mime    string
			size    int64
			namePln *string
			nameEnc []byte
		)
		err := tx.QueryRow(ctx, `
			SELECT mime, size_bytes, filename, filename_enc
			FROM attachments
			WHERE id = $1 AND org_id = $2
			  AND scope = 'mail' AND scope_id = $3 AND role = 'file'`,
			attachmentID, orgID, mailID).Scan(&mime, &size, &namePln, &nameEnc)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		// filename_enc is the source of truth; the plaintext column is the
		// fallback for un-backfilled rows (same rule as loadMailAttachments).
		var filename string
		if nameEnc != nil {
			if filename, err = s.crypto.Decrypt(ctx, tx, orgID, nameEnc); err != nil {
				return err
			}
		} else if namePln != nil {
			filename = *namePln
		}

		return insertOutbox(ctx, tx, mailID, events.MailAttachmentDownloaded{
			Type:         events.TypeMailAttachmentDownloaded,
			EventID:      uuid.Must(uuid.NewV7()).String(),
			OrgID:        orgID,
			OccurredAt:   nowISO(),
			ActorID:      userID,
			MailID:       mailID,
			AttachmentID: attachmentID,
			Filename:     filename,
			Mime:         mime,
			SizeBytes:    size,
		})
	})
}
