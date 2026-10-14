package store

// The Outlook mail-sync write-back surface, against a real Postgres with RLS
// actually enforcing: SetMailExternalRef's dedup backfill, the inbound-facing
// HideMailForOwner/SetMailReadForOwner (which must NOT re-emit the event they
// are reacting to), and MarkMailRead/SetInboxItemHidden's outbound
// mail.owner_state_changed emission (which must).
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and mail_send_db_test.go for sendAsUser/
// seedMailUser/mailDeliveryFor/unreadCountFor, reused here unchanged.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func externalMessageIDFor(t *testing.T, s *Store, orgID, mailID string) string {
	t.Helper()
	ctx := context.Background()
	var id *string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT external_message_id FROM mail_messages WHERE id = $1 AND org_id = $2`,
			mailID, orgID).Scan(&id)
	}); err != nil {
		t.Fatalf("read external_message_id: %v", err)
	}
	if id == nil {
		return ""
	}
	return *id
}

func hiddenForOwner(t *testing.T, s *Store, ownerID, mailID string) bool {
	t.Helper()
	ctx := context.Background()
	var hidden bool
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT hidden_for_owner FROM inbox_items WHERE owner_user_id = $1 AND item_kind = 'MAIL' AND ref_id = $2`,
			ownerID, mailID).Scan(&hidden)
	}); err != nil {
		t.Fatalf("read hidden_for_owner: %v", err)
	}
	return hidden
}

func TestSetMailExternalRef_BackfillsOnceThenIsANoOp(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"})
	if got := externalMessageIDFor(t, s, orgID, res.MailID); got != "" {
		t.Fatalf("external_message_id before backfill = %q, want empty", got)
	}

	if err := s.SetMailExternalRef(ctx, orgID, res.MailID, "<abc@graph>"); err != nil {
		t.Fatalf("SetMailExternalRef: %v", err)
	}
	if got := externalMessageIDFor(t, s, orgID, res.MailID); got != "<abc@graph>" {
		t.Fatalf("external_message_id after backfill = %q, want <abc@graph>", got)
	}

	// A second call (e.g. a retried send-path call) must not overwrite it.
	if err := s.SetMailExternalRef(ctx, orgID, res.MailID, "<different@graph>"); err != nil {
		t.Fatalf("SetMailExternalRef (second call): %v", err)
	}
	if got := externalMessageIDFor(t, s, orgID, res.MailID); got != "<abc@graph>" {
		t.Fatalf("external_message_id after second call = %q, want unchanged <abc@graph>", got)
	}
}

func TestDeliverInboundMail_DuplicateOfOwnSentMail_ReturnsExistingIDNotNoDeliverable(t *testing.T) {
	// The bug this guards against: an all-external-recipient mail BlissWork
	// already sent, later seen by mail_sync_worker walking the SAME author's
	// Sent-Items delta, must come back as "duplicate, here's the id" — not
	// ErrMailNoDeliverable, which the pre-fix code order would have returned
	// (resolveMailRecipients finds zero local recipients before the duplicate
	// check ever runs), losing the id mail_sync_links needs to link to.
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"outside@elsewhere.test"}, Subject: "s", BodyText: "b",
	})
	if res.DeliveredInApp != 0 {
		t.Fatalf("DeliveredInApp = %d, want 0 (all-external)", res.DeliveredInApp)
	}
	if err := s.SetMailExternalRef(ctx, orgID, res.MailID, "<self-sent@graph>"); err != nil {
		t.Fatalf("SetMailExternalRef: %v", err)
	}

	mailID, delivered, err := s.DeliverInboundMail(ctx, InboundMailInput{
		OrgID:             orgID,
		ExternalMessageID: "<self-sent@graph>",
		FromAddress:       "author@acme.test",
		Subject:           "s",
		BodyText:          "b",
		To:                []string{"outside@elsewhere.test"},
	})
	if err != ErrMailDuplicate {
		t.Fatalf("err = %v, want ErrMailDuplicate", err)
	}
	if mailID != res.MailID {
		t.Fatalf("mailID = %q, want the original %q", mailID, res.MailID)
	}
	if delivered != 0 {
		t.Fatalf("delivered = %d, want 0", delivered)
	}
}

func TestHideMailForOwner_HidesOnlyThatOwner_AndDoesNotReEmitTheEvent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	c := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")
	seedMailUser(t, s, orgID, c, "cee", "Cee C", "cee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"bee@acme.test", "cee@acme.test"}, Subject: "s", BodyText: "b",
	})

	if err := s.HideMailForOwner(ctx, orgID, b, res.MailID); err != nil {
		t.Fatalf("HideMailForOwner: %v", err)
	}
	if !hiddenForOwner(t, s, b, res.MailID) {
		t.Error("b's row: hidden_for_owner = false, want true")
	}
	if hiddenForOwner(t, s, c, res.MailID) {
		t.Error("c's row: hidden_for_owner = true, want untouched (false)")
	}

	// The INBOUND direction must not echo back OUT — only SetInboxItemHidden
	// (the user-facing path) emits mail.owner_state_changed.
	n := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		res.MailID, "mail.owner_state_changed")
	if n != 0 {
		t.Errorf("mail.owner_state_changed events after HideMailForOwner = %d, want 0", n)
	}

	// A mail/owner pair with no inbox row (e.g. already purged, or the wrong
	// owner) is ErrNotFound, not a silent success that looks identical.
	if err := s.HideMailForOwner(ctx, orgID, a, uuid.Must(uuid.NewV7()).String()); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound for an unknown mail", err)
	}
}

func TestSetMailReadForOwner_TogglesReadAtAndUnreadCount_WithNoEcho(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"})

	if err := s.SetMailReadForOwner(ctx, orgID, b, res.MailID, true); err != nil {
		t.Fatalf("SetMailReadForOwner(true): %v", err)
	}
	if row, ok := mailDeliveryFor(t, s, orgID, res.MailID, b); !ok || !row.read {
		t.Fatalf("delivery = %+v, ok=%v, want read=true", row, ok)
	}
	if n := unreadCountFor(t, s, res.MailID, b); n != 0 {
		t.Errorf("unread_count = %d, want 0", n)
	}

	if err := s.SetMailReadForOwner(ctx, orgID, b, res.MailID, false); err != nil {
		t.Fatalf("SetMailReadForOwner(false): %v", err)
	}
	if row, ok := mailDeliveryFor(t, s, orgID, res.MailID, b); !ok || row.read {
		t.Fatalf("delivery = %+v, ok=%v, want read=false", row, ok)
	}
	if n := unreadCountFor(t, s, res.MailID, b); n != 1 {
		t.Errorf("unread_count = %d, want 1", n)
	}

	n := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		res.MailID, "mail.owner_state_changed")
	if n != 0 {
		t.Errorf("mail.owner_state_changed events after SetMailReadForOwner = %d, want 0", n)
	}
}

func TestMarkMailRead_EmitsOwnerStateChangedForWriteBack(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"})

	if err := s.MarkMailRead(ctx, orgID, b, res.MailID); err != nil {
		t.Fatalf("MarkMailRead: %v", err)
	}

	isRead, ok := outboxJSONBool(t, s, res.MailID, "mail.owner_state_changed", "isRead")
	if !ok {
		t.Fatal("no mail.owner_state_changed event found")
	}
	if !isRead {
		t.Error("isRead = false, want true")
	}
}

func TestSetInboxItemHidden_MailDelete_EmitsOwnerStateChanged_RestoreDoesNot(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"})

	if err := s.SetInboxItemHidden(ctx, orgID, b, "MAIL", res.MailID, true); err != nil {
		t.Fatalf("SetInboxItemHidden(true): %v", err)
	}
	hidden, ok := outboxJSONBool(t, s, res.MailID, "mail.owner_state_changed", "hidden")
	if !ok || !hidden {
		t.Fatalf("hidden event: ok=%v value=%v, want true", ok, hidden)
	}

	if err := s.SetInboxItemHidden(ctx, orgID, b, "MAIL", res.MailID, false); err != nil {
		t.Fatalf("SetInboxItemHidden(false): %v", err)
	}
	// Still exactly one event — restore does not add a second.
	n := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		res.MailID, "mail.owner_state_changed")
	if n != 1 {
		t.Errorf("mail.owner_state_changed events after delete+restore = %d, want 1 (restore must not emit)", n)
	}
}

// outboxJSONBool reads one boolean field off the most recent matching outbox
// event's JSON payload.
func outboxJSONBool(t *testing.T, s *Store, kafkaKey, eventType, field string) (value bool, ok bool) {
	t.Helper()
	ctx := context.Background()
	var raw *bool
	found := false
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx,
			`SELECT (payload->>$3)::bool FROM outbox
			 WHERE kafka_key = $1 AND payload->>'type' = $2
			 ORDER BY created_at DESC LIMIT 1`,
			kafkaKey, eventType, field).Scan(&raw)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		return nil
	}); err != nil {
		t.Fatalf("read outbox payload: %v", err)
	}
	if !found || raw == nil {
		return false, found
	}
	return *raw, true
}
