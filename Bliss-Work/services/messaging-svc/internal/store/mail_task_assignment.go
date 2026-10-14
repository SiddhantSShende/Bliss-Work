package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// TaskAssignmentMailInput is what the task projector consumer passes on every
// task.assigned event, to also file a durable record into both participants'
// Mail history.
type TaskAssignmentMailInput struct {
	OrgID          string
	EventID        string
	AssigneeID     string
	SenderID       string
	SenderUsername string
	Title          string
	Description    string
	ChannelName    string
	OccurredAt     time.Time
}

// DeliverTaskAssignmentMail files a system-generated "you were assigned a
// task" mail into the assigner's Sent folder and the assignee's Inbox, so the
// Mail UI has a durable record of every task assignment. Unlike the real SMTP
// email email-worker's RelayConsumer may or may not send (it is deliberately
// offline-gated), this record is written for every assignment regardless of
// presence — the two are independent notification channels for the same
// event.
//
// Self-assignment (assigneeID == senderID) is skipped: mirrors
// RelayConsumer's own self-send guard, and a "you assigned yourself a task"
// Sent+Inbox pair for the same person serves no one.
//
// Idempotent the same way DeliverInboundMail is: external_message_id, here
// the task.assigned eventId, is unique per org (uq_mail_messages_external_id),
// so a Kafka-redelivered event can never create a second mail. A genuinely
// new assignment (a fresh task, or task-svc's reassign flow re-opening one)
// carries a fresh eventId and so always gets its own mail.
func (s *Store) DeliverTaskAssignmentMail(ctx context.Context, in TaskAssignmentMailInput) error {
	if in.AssigneeID == "" || in.SenderID == "" || in.AssigneeID == in.SenderID {
		return nil
	}
	sentAt := in.OccurredAt
	if sentAt.IsZero() {
		sentAt = time.Now().UTC()
	}
	subject := taskAssignmentMailSubject(in.SenderUsername, in.ChannelName, in.Title)
	body := taskAssignmentMailBody(in.SenderUsername, in.ChannelName, in.Title, in.Description)
	mailID := uuid.Must(uuid.NewV7()).String()

	return s.withBypass(ctx, func(tx pgx.Tx) error {
		// Duplicate check FIRST, before resolving identities at all — see
		// DeliverInboundMail's comment on why: a redelivered event is a
		// duplicate regardless of what its sender/assignee resolve to.
		existing, err := s.existingMailIDByExternalRef(ctx, tx, in.OrgID, in.EventID)
		if err != nil {
			return err
		}
		if existing != "" {
			return nil
		}

		sender, assigneeAddr, err := loadTaskAssignmentIdentities(ctx, tx, in.OrgID, in.SenderID, in.AssigneeID)
		if err != nil {
			return err
		}
		if assigneeAddr == "" {
			// The assignee has no projected email yet (a race with
			// AuthConsumer's own user.created projection, not expected to
			// last). Returning a plain error (not a pgconn error) routes
			// this through the consumer's normal retry-with-backoff path
			// rather than being misclassified as a permanent failure.
			return fmt.Errorf("task assignment mail: assignee %s has no projected email in org %s", in.AssigneeID, in.OrgID)
		}

		if err := s.insertTaskAssignmentMail(ctx, tx, in, mailID, sender, subject, body, sentAt); err != nil {
			if errors.Is(err, ErrMailDuplicate) {
				// Lost the race against a concurrent delivery of the same
				// eventId — the other writer's commit is the real mail.
				return nil
			}
			return err
		}
		if err := s.writeMailRecipients(ctx, tx, in.OrgID, mailID, []resolvedAddress{
			{kind: MailKindTo, pos: 0, address: assigneeAddr, userID: &in.AssigneeID},
		}); err != nil {
			return err
		}

		// The sender's own SENT mail_deliveries row. For the composer flow
		// this is written by CreateMailDraft at draft-open time, before
		// deliverMailInApp/upsertMailInboxItem ever runs; there is no draft
		// here, so it has to be written explicitly.
		if _, err := tx.Exec(ctx, `
			INSERT INTO mail_deliveries (mail_id, owner_user_id, org_id, folder)
			VALUES ($1, $2, $3, 'SENT')
			ON CONFLICT (mail_id, owner_user_id) DO NOTHING`,
			mailID, in.SenderID, in.OrgID); err != nil {
			return err
		}

		preview := mailPreview(subject, body)
		sentBadge := MailStatusSent
		if err := s.upsertMailInboxItem(ctx, tx, mailInboxItem{
			orgID: in.OrgID, ownerUserID: in.SenderID, mailID: mailID,
			peerUserID: &in.AssigneeID, preview: preview, statusBadge: &sentBadge,
			lastEventAt: sentAt, incUnread: 0,
		}); err != nil {
			return err
		}
		if err := s.deliverMailToOwners(ctx, tx, in.OrgID, mailID, []string{in.AssigneeID},
			&in.SenderID, preview, nil, sentAt, 1); err != nil {
			return err
		}

		return insertOutbox(ctx, tx, mailID, events.MailDelivered{
			Type:       events.TypeMailDelivered,
			EventID:    uuid.Must(uuid.NewV7()).String(),
			OrgID:      in.OrgID,
			OccurredAt: nowISO(),
			MailID:     mailID,
			SenderID:   in.SenderID,
			Members:    []string{in.SenderID, in.AssigneeID},
		})
	})
}

// loadTaskAssignmentIdentities resolves the sender's display identity (for
// the From header) and the assignee's email (the only thing mail_recipients
// actually requires) in one round trip.
func loadTaskAssignmentIdentities(
	ctx context.Context, tx pgx.Tx, orgID, senderID, assigneeID string,
) (sender mailAuthor, assigneeAddr string, err error) {
	rows, err := tx.Query(ctx, `
		SELECT user_id::text, COALESCE(email, ''), COALESCE(display_name, username, '')
		FROM user_projection
		WHERE org_id = $1 AND user_id = ANY($2::uuid[])`,
		orgID, []string{senderID, assigneeID})
	if err != nil {
		return sender, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var uid, email, name string
		if err := rows.Scan(&uid, &email, &name); err != nil {
			return sender, "", err
		}
		switch uid {
		case senderID:
			sender.address, sender.name = email, name
		case assigneeID:
			assigneeAddr = email
		}
	}
	if err := rows.Err(); err != nil {
		return sender, "", err
	}
	return sender, assigneeAddr, nil
}

// insertTaskAssignmentMail writes the mail row, failing cleanly (ErrMailDuplicate)
// on a redelivery of the same eventId. Mirrors insertInboundMail.
func (s *Store) insertTaskAssignmentMail(
	ctx context.Context, tx pgx.Tx, in TaskAssignmentMailInput, mailID string,
	sender mailAuthor, subject, body string, sentAt time.Time,
) error {
	enc := func(v string) ([]byte, error) { return s.crypto.Encrypt(ctx, tx, in.OrgID, v) }
	fromEnc, err := enc(sender.address)
	if err != nil {
		return err
	}
	nameEnc, err := enc(sender.name)
	if err != nil {
		return err
	}
	subjEnc, err := enc(subject)
	if err != nil {
		return err
	}
	bodyEnc, err := enc(body)
	if err != nil {
		return err
	}
	ct, err := tx.Exec(ctx, `
		INSERT INTO mail_messages
		  (id, org_id, status, author_user_id, from_address_enc, from_name_enc, subject_enc,
		   body_text_enc, external_message_id, sent_at)
		VALUES ($1, $2, 'SENT', $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (org_id, external_message_id) WHERE external_message_id IS NOT NULL
		DO NOTHING`,
		mailID, in.OrgID, in.SenderID, fromEnc, nameEnc, subjEnc, bodyEnc,
		in.EventID, sentAt)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrMailDuplicate
	}
	return nil
}

// taskAssignmentMailSubject/body match the wording of the real SMTP email
// email-worker's RelayConsumer sends (render_new_task_email in
// email-worker/app/templates.py) so the Mail-history record reads as the
// same notification, not a second, differently-worded one.
func taskAssignmentMailSubject(senderUsername, channelName, title string) string {
	title = truncateRunes(title, MaxMailSubjectRunes)
	who := senderUsername
	if who == "" {
		who = "A teammate"
	}
	if channelName != "" {
		return fmt.Sprintf("BlissWork: New task assigned to %s — %s", channelName, title)
	}
	return fmt.Sprintf("BlissWork: %s assigned you a task — %s", who, title)
}

func taskAssignmentMailBody(senderUsername, channelName, title, description string) string {
	who := senderUsername
	if who == "" {
		who = "A teammate"
	}
	body := who
	if channelName != "" {
		body += fmt.Sprintf(" assigned a task to #%s:\n\n", channelName)
	} else {
		body += " assigned you a task:\n\n"
	}
	body += title
	if description != "" {
		body += "\n\n" + description
	}
	return truncateRunes(body, MaxMailBodyRunes)
}
