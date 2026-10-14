package store

// DeliverTaskAssignmentMail, against a real Postgres with RLS actually
// enforcing. See calls_lifecycle_db_test.go's header for the harness
// (opt-in via MESSAGING_TEST_DATABASE_URL) and mail_send_db_test.go for the
// mail_deliveries/inbox_items assertion helpers reused here.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func assignMail(t *testing.T, s *Store, in TaskAssignmentMailInput) {
	t.Helper()
	if err := s.DeliverTaskAssignmentMail(context.Background(), in); err != nil {
		t.Fatalf("DeliverTaskAssignmentMail: %v", err)
	}
}

// Scenario 1 (assignment while online or offline makes no difference to this
// function — it does not consult presence at all): the assigner gets a SENT
// row, the assignee gets an unread INBOX row, and both reference the same
// mail.
func TestDeliverTaskAssignmentMail_CreatesSentAndInboxCopies(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, sender, "ada", "Ada A", "ada@acme.test")
	seedMailUser(t, s, orgID, assignee, "bo", "Bo B", "bo@acme.test")

	in := TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: assignee, SenderID: sender, SenderUsername: "ada",
		Title: "Write the report", Description: "Due Friday",
		OccurredAt: time.Now().UTC(),
	}
	assignMail(t, s, in)

	mailID := countRows(t, s, `SELECT count(*) FROM mail_messages WHERE org_id = $1 AND external_message_id = $2`,
		orgID, in.EventID)
	if mailID != 1 {
		t.Fatalf("mail_messages rows for eventId = %d, want 1", mailID)
	}
	var realMailID string
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			`SELECT id::text FROM mail_messages WHERE org_id = $1 AND external_message_id = $2`,
			orgID, in.EventID).Scan(&realMailID)
	}); err != nil {
		t.Fatalf("read mail id: %v", err)
	}

	senderRow, ok := mailDeliveryFor(t, s, orgID, realMailID, sender)
	if !ok || senderRow.folder != MailFolderSent {
		t.Fatalf("sender delivery = %+v, ok=%v, want folder=SENT", senderRow, ok)
	}
	assigneeRow, ok := mailDeliveryFor(t, s, orgID, realMailID, assignee)
	if !ok || assigneeRow.folder != MailFolderInbox {
		t.Fatalf("assignee delivery = %+v, ok=%v, want folder=INBOX", assigneeRow, ok)
	}
	if assigneeRow.read {
		t.Errorf("assignee delivery already read_at, want unread on arrival")
	}
	if n := unreadCountFor(t, s, realMailID, assignee); n != 1 {
		t.Errorf("assignee unread_count = %d, want 1", n)
	}
	if n := unreadCountFor(t, s, realMailID, sender); n != 0 {
		t.Errorf("sender unread_count = %d, want 0 (their own Sent copy)", n)
	}

	delivered := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.delivered'`,
		realMailID)
	if delivered != 1 {
		t.Errorf("mail.delivered events = %d, want 1", delivered)
	}
}

// Scenario 5: Kafka redelivering the same task.assigned event (same eventId)
// must not create a second mail or a second pair of mailbox rows.
func TestDeliverTaskAssignmentMail_SameEventIdTwice_IsIdempotent(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, sender, "ada", "Ada A", "ada@acme.test")
	seedMailUser(t, s, orgID, assignee, "bo", "Bo B", "bo@acme.test")

	in := TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: assignee, SenderID: sender, SenderUsername: "ada",
		Title: "Write the report", OccurredAt: time.Now().UTC(),
	}
	assignMail(t, s, in)
	assignMail(t, s, in) // redelivery: identical eventId

	n := countRows(t, s, `SELECT count(*) FROM mail_messages WHERE org_id = $1 AND external_message_id = $2`,
		orgID, in.EventID)
	if n != 1 {
		t.Fatalf("mail_messages rows after redelivery = %d, want exactly 1", n)
	}
	deliveries := countRows(t, s, `SELECT count(*) FROM mail_deliveries WHERE org_id = $1`, orgID)
	if deliveries != 2 {
		t.Fatalf("mail_deliveries rows after redelivery = %d, want exactly 2 (one SENT, one INBOX)", deliveries)
	}
}

// Scenario 4 (multiple assignees of the same task, one event each): a second,
// genuinely different assignment — a fresh eventId, a different assignee —
// must get its OWN mail, not be folded into the first.
func TestDeliverTaskAssignmentMail_DifferentAssigneesGetDifferentMails(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	bo := uuid.Must(uuid.NewV7()).String()
	cy := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, sender, "ada", "Ada A", "ada@acme.test")
	seedMailUser(t, s, orgID, bo, "bo", "Bo B", "bo@acme.test")
	seedMailUser(t, s, orgID, cy, "cy", "Cy C", "cy@acme.test")

	assignMail(t, s, TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: bo, SenderID: sender, SenderUsername: "ada",
		Title: "Shared task", OccurredAt: time.Now().UTC(),
	})
	assignMail(t, s, TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: cy, SenderID: sender, SenderUsername: "ada",
		Title: "Shared task", OccurredAt: time.Now().UTC(),
	})

	if n := countRows(t, s, `SELECT count(*) FROM mail_messages WHERE org_id = $1`, orgID); n != 2 {
		t.Fatalf("mail_messages rows = %d, want 2 (one per assignee)", n)
	}
	for _, a := range []string{bo, cy} {
		if n := countRows(t, s,
			`SELECT count(*) FROM mail_deliveries WHERE org_id = $1 AND owner_user_id = $2 AND folder = 'INBOX'`,
			orgID, a); n != 1 {
			t.Errorf("assignee %s INBOX rows = %d, want 1", a, n)
		}
	}
	// The sender gets two separate SENT rows, one per mail — not deduped
	// across different mails.
	if n := countRows(t, s,
		`SELECT count(*) FROM mail_deliveries WHERE org_id = $1 AND owner_user_id = $2 AND folder = 'SENT'`,
		orgID, sender); n != 2 {
		t.Errorf("sender SENT rows = %d, want 2", n)
	}
}

// Self-assignment must not create a mail at all — mirrors RelayConsumer's own
// self-send guard in email-worker.
func TestDeliverTaskAssignmentMail_SelfAssignment_CreatesNoMail(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	person := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, person, "ada", "Ada A", "ada@acme.test")

	assignMail(t, s, TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: person, SenderID: person, SenderUsername: "ada",
		Title: "Claimed task", OccurredAt: time.Now().UTC(),
	})

	if n := countRows(t, s, `SELECT count(*) FROM mail_messages WHERE org_id = $1`, orgID); n != 0 {
		t.Fatalf("mail_messages rows for a self-assignment = %d, want 0", n)
	}
}

// Channel-targeted assignment: the subject/body must name the channel, not
// imply a direct, personal assignment.
func TestDeliverTaskAssignmentMail_ChannelAssignment_MentionsTheChannel(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	sender := uuid.Must(uuid.NewV7()).String()
	assignee := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, sender, "ada", "Ada A", "ada@acme.test")
	seedMailUser(t, s, orgID, assignee, "bo", "Bo B", "bo@acme.test")

	assignMail(t, s, TaskAssignmentMailInput{
		OrgID: orgID, EventID: uuid.Must(uuid.NewV7()).String(),
		AssigneeID: assignee, SenderID: sender, SenderUsername: "ada",
		Title: "Triage", ChannelName: "support", OccurredAt: time.Now().UTC(),
	})

	var subject, body string
	if err := s.withBypass(context.Background(), func(tx pgx.Tx) error {
		var subjEnc, bodyEnc []byte
		if err := tx.QueryRow(context.Background(),
			`SELECT subject_enc, body_text_enc FROM mail_messages WHERE org_id = $1`, orgID).
			Scan(&subjEnc, &bodyEnc); err != nil {
			return err
		}
		var derr error
		subject, derr = s.crypto.Decrypt(context.Background(), tx, orgID, subjEnc)
		if derr != nil {
			return derr
		}
		body, derr = s.crypto.Decrypt(context.Background(), tx, orgID, bodyEnc)
		return derr
	}); err != nil {
		t.Fatalf("read+decrypt mail: %v", err)
	}
	if want := "BlissWork: New task assigned to support — Triage"; subject != want {
		t.Errorf("subject = %q, want %q", subject, want)
	}
	if want := "ada assigned a task to #support:\n\nTriage"; body != want {
		t.Errorf("body = %q, want %q", body, want)
	}
}
