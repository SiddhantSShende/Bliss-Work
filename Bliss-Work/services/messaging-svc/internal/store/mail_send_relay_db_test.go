package store

// TestSendMail_RelaysToLocalRecipientsToo — against a real Postgres, RLS
// actually enforcing, exercising the bug this file exists to catch: a mail
// composed in BlissWork to a fellow org member reached that colleague's
// BlissWork inbox (mail_deliveries) but never their actual mailbox, because
// queueMailOutbound only ever queued a real SMTP/provider copy for addresses
// that had LEFT the org. See relayRecipients in mail_send.go and its unit
// tests in mail_test.go for the pure-function half of this; this file proves
// the wiring through SendMail end-to-end, including that the fix does not
// touch SendMailResult (the "Sent to N here, delivering to M more" copy in
// MailCompose.tsx reads those numbers and must keep meaning what it already
// says) and does not double-queue anyone.
//
// See calls_lifecycle_db_test.go's header for the harness reused here
// (opt-in via MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestSendMail_RelaysToLocalRecipientsToo(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	authorID := uuid.Must(uuid.NewV7()).String()
	colleagueID := uuid.Must(uuid.NewV7()).String()
	mailID := uuid.Must(uuid.NewV7()).String()

	const authorEmail = "author@acme.test"
	const colleagueEmail = "colleague@acme.test"
	const externalEmail = "partner@outside.test"

	if err := s.UpsertUser(ctx, authorID, orgID, "author", "Author", authorEmail); err != nil {
		t.Fatalf("seed author: %v", err)
	}
	if err := s.UpsertUser(ctx, colleagueID, orgID, "colleague", "Colleague", colleagueEmail); err != nil {
		t.Fatalf("seed colleague: %v", err)
	}

	// The draft this test sends — fixture, not the code under test, so it is
	// seeded directly rather than through SaveMailDraft.
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO mail_messages (id, org_id, status, author_user_id) VALUES ($1, $2, 'DRAFT', $3)`,
			mailID, orgID, authorID)
		return err
	}); err != nil {
		t.Fatalf("seed draft: %v", err)
	}

	res, err := s.SendMail(ctx, SendMailInput{
		OrgID:    orgID,
		UserID:   authorID,
		MailID:   mailID,
		To:       []string{colleagueEmail, externalEmail},
		Subject:  "Q3 numbers",
		BodyText: "See attached.",
	})
	if err != nil {
		t.Fatalf("SendMail: %v", err)
	}

	// The UI contract must not move: one colleague delivered in-app, one
	// address queued as external — exactly as before this change, so
	// MailCompose.tsx's sentSummary() keeps saying something true without
	// MailCompose.tsx itself changing.
	if res.DeliveredInApp != 1 {
		t.Errorf("DeliveredInApp = %d, want 1", res.DeliveredInApp)
	}
	if res.QueuedExternal != 1 {
		t.Errorf("QueuedExternal = %d, want 1 (must still mean \"left the org\" only)", res.QueuedExternal)
	}

	// The colleague's BlissWork inbox copy — already correct before this
	// change; asserted here so a regression in this area shows up alongside
	// the wire-copy assertion below rather than in a different test file.
	// mail_deliveries has forced RLS, so this has to run under an org-scoped
	// tx (withOrg) or the row is invisible regardless of whether it exists —
	// a raw pool query here would silently "prove" the bug even on a fix.
	var folder string
	if err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT folder FROM mail_deliveries WHERE mail_id = $1 AND owner_user_id = $2`,
			mailID, colleagueID).Scan(&folder)
	}); err != nil {
		t.Fatalf("colleague mail_deliveries row: %v", err)
	}
	if folder != MailFolderInbox {
		t.Errorf("colleague delivery folder = %q, want INBOX", folder)
	}

	// The actual fix: both the colleague's real address AND the external
	// address must now have a queued mail.outbound copy — not just the
	// external one.
	rows, err := s.pool.Query(ctx,
		`SELECT payload FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound'`,
		mailID)
	if err != nil {
		t.Fatalf("query outbox: %v", err)
	}
	defer rows.Close()

	var envelopes []string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan outbox row: %v", err)
		}
		var ev struct {
			Envelope string `json:"envelope"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("unmarshal outbox payload: %v", err)
		}
		envelopes = append(envelopes, ev.Envelope)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate outbox rows: %v", err)
	}

	// Exactly one copy per address — proves the fix relays to the colleague
	// too, AND that it does not double-queue anyone (the "avoid duplicate
	// emails" requirement).
	if len(envelopes) != 2 {
		t.Fatalf("queued mail.outbound envelopes = %v, want exactly 2 (one per recipient, colleague included)", envelopes)
	}
	seen := map[string]bool{}
	for _, e := range envelopes {
		seen[e] = true
	}
	if !seen[colleagueEmail] {
		t.Errorf("no mail.outbound queued for the colleague's own address %q — the bug this test exists to catch", colleagueEmail)
	}
	if !seen[externalEmail] {
		t.Errorf("no mail.outbound queued for the external address %q", externalEmail)
	}
}
