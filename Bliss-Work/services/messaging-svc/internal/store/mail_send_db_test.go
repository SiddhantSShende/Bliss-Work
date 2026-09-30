package store

// SendMail's internal-vs-external delivery split, against a real Postgres with
// RLS actually enforcing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// mail_test.go and mail_provider_test.go already cover the pure functions
// (address validation, the preview line, splitMailDelivery, splitExternalsByKind)
// with a fake pgx.Tx nowhere in sight. What none of that proves is whether
// SendMail's ONE transaction actually leaves the right ROWS behind: a
// mail_deliveries entry per entitled reader and no others, inbox_items unread
// counts that move for the recipient and not the sender, a Bcc line hidden from
// everyone but its own recipient and the author, and a second GetMail's ROLE in
// deciding who is entitled at all. Every one of those is a query plan and an RLS
// policy, not a Go expression — the bug class this guards against is a query
// that compiles, returns no error, and quietly touches the wrong rows.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL, and why it must not run as a superuser) and
// migrateOnce for how the schema gets here.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedMailUser is seedUser (screenshot_attempt_db_test.go) plus the email
// column mail resolution actually reads. A second helper rather than widening
// the existing one: every other caller of seedUser has no mail in play and no
// reason to carry an address.
func seedMailUser(t *testing.T, s *Store, orgID, userID, username, displayName, email string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name, email, active)
			 VALUES ($1, $2, $3, $4, $5, true)`,
			userID, orgID, username, displayName, email)
		return err
	}); err != nil {
		t.Fatalf("seed mail user: %v", err)
	}
}

// sendAsUser drafts and sends one mail as the given author, failing the test on
// any error. Every scenario below composes and sends, so this is the one place
// that shape is spelled out.
func sendAsUser(t *testing.T, s *Store, orgID, authorID string, in SendMailInput) *SendMailResult {
	t.Helper()
	ctx := context.Background()
	mailID, err := s.CreateMailDraft(ctx, orgID, authorID)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	in.OrgID, in.UserID, in.MailID = orgID, authorID, mailID
	res, err := s.SendMail(ctx, in)
	if err != nil {
		t.Fatalf("send mail: %v", err)
	}
	return res
}

// mailDeliveryRow is one mail_deliveries row, read back under bypass for
// assertions.
type mailDeliveryRow struct {
	folder string
	read   bool
}

func mailDeliveryFor(t *testing.T, s *Store, orgID, mailID, userID string) (mailDeliveryRow, bool) {
	t.Helper()
	ctx := context.Background()
	var row mailDeliveryRow
	var found bool
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var readAt *string
		err := tx.QueryRow(ctx, `
			SELECT folder, read_at::text FROM mail_deliveries
			WHERE mail_id = $1 AND owner_user_id = $2 AND org_id = $3`,
			mailID, userID, orgID).Scan(&row.folder, &readAt)
		if err == pgx.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		found = true
		row.read = readAt != nil
		return nil
	}); err != nil {
		t.Fatalf("read mail_deliveries: %v", err)
	}
	return row, found
}

func unreadCountFor(t *testing.T, s *Store, mailID, ownerID string) int64 {
	t.Helper()
	ctx := context.Background()
	var n int64
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT unread_count FROM inbox_items
			WHERE owner_user_id = $1 AND item_kind = 'MAIL' AND ref_id = $2`,
			ownerID, mailID).Scan(&n)
	}); err != nil {
		t.Fatalf("read inbox_items: %v", err)
	}
	return n
}

func countRows(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, query, args...).Scan(&n)
	}); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// ── Test 1 / Test 4 — internal recipients land in the right mailboxes ────────
//
// A single send to two colleagues: both must get an unread INBOX row, the
// author must get exactly one SENT row (not one per recipient), and — this is
// the part a unit test around splitMailDelivery cannot see — each colleague
// also gets a mail.outbound wire copy (relayRecipients deliberately includes
// local org members too, see mail_send.go), but neither copy may carry a
// providerTo/providerCc/providerBcc address: that would hand a local
// member's mail to the external provider send too, on top of the in-app
// delivery they already got above.
func TestSendMail_InternalRecipients_DeliverToInboxAndSent(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	c := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")
	seedMailUser(t, s, orgID, c, "cee", "Cee C", "cee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"bee@acme.test", "cee@acme.test"}, Subject: "Q3 numbers", BodyText: "See attached",
	})

	if res.DeliveredInApp != 2 || res.QueuedExternal != 0 {
		t.Fatalf("result = %+v, want DeliveredInApp=2 QueuedExternal=0", res)
	}

	// Both colleagues: an unread INBOX row.
	for _, recipient := range []string{b, c} {
		row, ok := mailDeliveryFor(t, s, orgID, res.MailID, recipient)
		if !ok || row.folder != MailFolderInbox {
			t.Fatalf("recipient %s: mail_deliveries = %+v, ok=%v, want folder=INBOX", recipient, row, ok)
		}
		if row.read {
			t.Errorf("recipient %s: delivery already read_at, want unread on arrival", recipient)
		}
		if n := unreadCountFor(t, s, res.MailID, recipient); n != 1 {
			t.Errorf("recipient %s: unread_count = %d, want 1", recipient, n)
		}
	}

	// The author: exactly one SENT row, not two.
	sentRows := countRows(t, s,
		`SELECT count(*) FROM mail_deliveries WHERE mail_id = $1 AND owner_user_id = $2 AND folder = 'SENT'`,
		res.MailID, a)
	if sentRows != 1 {
		t.Errorf("author SENT rows = %d, want exactly 1", sentRows)
	}

	// One mail.outbound wire copy per colleague, even though both are local —
	// that is relayRecipients' job. But none of them may carry a provider
	// recipient: a local member must never reach the external provider send.
	outbound := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound'`,
		res.MailID)
	if outbound != 2 {
		t.Errorf("mail.outbound events = %d, want 2 — one wire copy per local colleague", outbound)
	}
	providerAddressed := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound'
		   AND (payload ? 'providerTo' OR payload ? 'providerCc' OR payload ? 'providerBcc')`,
		res.MailID)
	if providerAddressed != 0 {
		t.Errorf("mail.outbound events addressed to the provider = %d, want 0 — bee and cee are local, they must not reach the external provider send", providerAddressed)
	}
	delivered := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.delivered'`,
		res.MailID)
	if delivered != 1 {
		t.Errorf("mail.delivered events = %d, want exactly 1", delivered)
	}
}

// ── Test 2 — an address outside the org gets no Blisswork mailbox record ─────
func TestSendMail_ExternalOnly_CreatesNoInternalRecord(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"outside@partner.test"}, Subject: "Hi", BodyText: "hello",
	})

	if res.DeliveredInApp != 0 || res.QueuedExternal != 1 {
		t.Fatalf("result = %+v, want DeliveredInApp=0 QueuedExternal=1", res)
	}
	// Nothing but the author's own SENT row exists for this mail.
	total := countRows(t, s, `SELECT count(*) FROM mail_deliveries WHERE mail_id = $1`, res.MailID)
	if total != 1 {
		t.Errorf("mail_deliveries rows = %d, want exactly 1 (the author's SENT copy)", total)
	}
	outbound := countRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound'
		   AND payload->>'envelope' = 'outside@partner.test'`,
		res.MailID)
	if outbound != 1 {
		t.Errorf("mail.outbound events for the external address = %d, want 1", outbound)
	}
}

// ── Test 3 — mixed To/Cc/Bcc: internal recipients resolve, the Bcc'd outsider
// gets only the provider send and never a mailbox row ─────────────────────────
func TestSendMail_MixedRecipients_SeparatesInternalFromExternal(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	mayank := uuid.Must(uuid.NewV7()).String()
	rahul := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, mayank, "mayank", "Mayank", "mayank@acme.test")
	seedMailUser(t, s, orgID, rahul, "rahul", "Rahul", "rahul@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To:       []string{"mayank@acme.test"},
		Cc:       []string{"rahul@acme.test"},
		Bcc:      []string{"someone@gmail.test"},
		Subject:  "Sync",
		BodyText: "notes",
	})

	if res.DeliveredInApp != 2 || res.QueuedExternal != 1 {
		t.Fatalf("result = %+v, want DeliveredInApp=2 QueuedExternal=1", res)
	}
	for _, recipient := range []string{mayank, rahul} {
		if _, ok := mailDeliveryFor(t, s, orgID, res.MailID, recipient); !ok {
			t.Errorf("recipient %s: no mail_deliveries row", recipient)
		}
	}
	// The Bcc'd Gmail address never becomes a Blisswork mailbox record: only
	// the author (SENT) and the two colleagues (INBOX) may hold one.
	total := countRows(t, s, `SELECT count(*) FROM mail_deliveries WHERE mail_id = $1`, res.MailID)
	if total != 3 {
		t.Errorf("mail_deliveries rows = %d, want exactly 3 (author + 2 colleagues)", total)
	}
	// The provider send carries the Bcc'd address as a Bcc, never as To/Cc —
	// otherwise the "blind" copy would out itself to its own recipient.
	var bcc, to, cc []byte
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT payload->'providerBcc', payload->'providerTo', payload->'providerCc'
			FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound'`,
			res.MailID).Scan(&bcc, &to, &cc)
	}); err != nil {
		t.Fatalf("read outbound payload: %v", err)
	}
	if string(bcc) != `["someone@gmail.test"]` {
		t.Errorf("providerBcc = %s, want [\"someone@gmail.test\"]", bcc)
	}
	// providerTo/providerCc are `omitempty`: an empty slice is dropped from the
	// JSON entirely, so `payload->'providerTo'` on a key that was never
	// written comes back SQL NULL — an empty []byte, not the literal "null".
	if s := string(to); s != "" && s != "null" && s != "[]" {
		t.Errorf("providerTo = %s, want empty/absent — Mayank is local and must not reach the provider send", to)
	}
	if s := string(cc); s != "" && s != "null" && s != "[]" {
		t.Errorf("providerCc = %s, want empty/absent — Rahul is local and must not reach the provider send", cc)
	}
}

// ── Test 5 — a reply is an ordinary send in the other direction ──────────────
//
// Mail has no thread_id (see 0023_mail.sql's design note: MAIL is a THIRD
// inbox_items kind alongside THREAD, not a row inside the existing thread
// system). What "the same conversation" means here is what a subject-line mail
// client has always meant: the reply carries "Re: <subject>" and reaches the
// same two people. This test is what proves THAT much actually happens
// end-to-end, not that a stronger thread-id link exists — it does not.
func TestSendMail_Reply_ReachesTheOriginalSenderSymmetrically(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "alice", "Alice", "alice@acme.test")
	seedMailUser(t, s, orgID, b, "bob", "Bob", "bob@acme.test")

	first := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"bob@acme.test"}, Subject: "Can you check this?", BodyText: "…",
	})
	if _, ok := mailDeliveryFor(t, s, orgID, first.MailID, b); !ok {
		t.Fatalf("Bob has no delivery for the original mail")
	}

	reply := sendAsUser(t, s, orgID, b, SendMailInput{
		To: []string{"alice@acme.test"}, Subject: "Re: Can you check this?", BodyText: "Yes, I'll check it.",
	})
	if _, ok := mailDeliveryFor(t, s, orgID, reply.MailID, a); !ok {
		t.Fatalf("Alice has no delivery for Bob's reply")
	}
	// The two mails are DIFFERENT rows (no forced merge), but both are marked
	// SENT for their own author.
	if first.MailID == reply.MailID {
		t.Fatalf("reply reused the original mail id")
	}
	if row, _ := mailDeliveryFor(t, s, orgID, reply.MailID, b); row.folder != MailFolderSent {
		t.Errorf("Bob's own copy of his reply = %+v, want folder=SENT", row)
	}
}

// ── Test 6 — the recipient's read state is theirs alone ──────────────────────
func TestMarkMailRead_DoesNotTouchTheSendersOwnCopy(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"})

	beforeA, _ := mailDeliveryFor(t, s, orgID, res.MailID, a)
	if beforeA.read {
		t.Fatalf("author's SENT copy already marked read before anyone opened it")
	}

	ctx := context.Background()
	if err := s.MarkMailRead(ctx, orgID, b, res.MailID); err != nil {
		t.Fatalf("MarkMailRead: %v", err)
	}

	rowB, _ := mailDeliveryFor(t, s, orgID, res.MailID, b)
	if !rowB.read {
		t.Errorf("Bee's delivery still unread after MarkMailRead")
	}
	if n := unreadCountFor(t, s, res.MailID, b); n != 0 {
		t.Errorf("Bee's unread_count = %d, want 0 after reading", n)
	}

	afterA, _ := mailDeliveryFor(t, s, orgID, res.MailID, a)
	if afterA.read {
		t.Errorf("Bee reading her copy marked the AUTHOR's own SENT row read — read state leaked across owners")
	}
}

// ── Test 7 — server-side authorization: only mail_deliveries decides who reads
// what, and a Bcc line is visible only to its own recipient and the author ────
func TestGetMail_OnlyEntitledReadersCanOpenIt(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	toUser := uuid.Must(uuid.NewV7()).String()
	bccUser := uuid.Must(uuid.NewV7()).String()
	outsider := uuid.Must(uuid.NewV7()).String() // a real org member, but never addressed
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, toUser, "to-user", "To User", "to@acme.test")
	seedMailUser(t, s, orgID, bccUser, "bcc-user", "Bcc User", "bcc@acme.test")
	seedMailUser(t, s, orgID, outsider, "outsider", "Outsider", "outsider@acme.test")

	res := sendAsUser(t, s, orgID, a, SendMailInput{
		To: []string{"to@acme.test"}, Bcc: []string{"bcc@acme.test"}, Subject: "s", BodyText: "b",
	})
	ctx := context.Background()

	// The author sees the whole header, including the Bcc line they typed.
	authorView, err := s.GetMail(ctx, orgID, a, res.MailID)
	if err != nil {
		t.Fatalf("author GetMail: %v", err)
	}
	if n := len(authorView.Recipients); n != 2 {
		t.Errorf("author sees %d recipients, want 2 (To + Bcc)", n)
	}

	// The To recipient can open it, but must NOT see who was Bcc'd.
	toView, err := s.GetMail(ctx, orgID, toUser, res.MailID)
	if err != nil {
		t.Fatalf("To recipient GetMail: %v", err)
	}
	for _, r := range toView.Recipients {
		if r.Kind == MailKindBcc {
			t.Errorf("To recipient's view leaks a Bcc entry: %+v", r)
		}
	}

	// The Bcc'd recipient CAN open it, and sees their own Bcc entry — that is
	// what tells them how the mail reached them.
	bccView, err := s.GetMail(ctx, orgID, bccUser, res.MailID)
	if err != nil {
		t.Fatalf("Bcc recipient GetMail: %v", err)
	}
	sawOwnBcc := false
	for _, r := range bccView.Recipients {
		if r.Kind == MailKindBcc {
			sawOwnBcc = true
		}
	}
	if !sawOwnBcc {
		t.Errorf("Bcc recipient's own view hides their own Bcc entry")
	}

	// An org member who was never addressed at all — not even Bcc'd — must be
	// refused, exactly as if the mail did not exist to them. This is the
	// literal "change the id in the URL" probe: nothing here reads org
	// membership, only mail_deliveries.
	if _, err := s.GetMail(ctx, orgID, outsider, res.MailID); err != ErrNotFound {
		t.Errorf("outsider GetMail error = %v, want ErrNotFound", err)
	}
}

// ── Test 8 — a retried Send cannot fan a mail out twice ───────────────────────
//
// The Idempotency-Key middleware is the FIRST line of defense at the API layer
// (see middleware/idempotency.go); this is the backstop one level down, for the
// case the middleware cannot see — two goroutines (or two pods) racing the same
// already-sent draft id straight into the store. loadSendableDraft's status
// check is what has to hold: whichever call wins the UPDATE ... WHERE
// status='DRAFT' race, the loser must fail closed rather than deliver again.
func TestSendMail_ResendingAnAlreadySentDraft_Fails(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	seedMailUser(t, s, orgID, a, "author", "Author A", "author@acme.test")
	seedMailUser(t, s, orgID, b, "bee", "Bee B", "bee@acme.test")

	ctx := context.Background()
	mailID, err := s.CreateMailDraft(ctx, orgID, a)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	in := SendMailInput{OrgID: orgID, UserID: a, MailID: mailID, To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"}
	if _, err := s.SendMail(ctx, in); err != nil {
		t.Fatalf("first send: %v", err)
	}

	// A second call against the SAME mail id — the retried request.
	if _, err := s.SendMail(ctx, in); err != ErrMailAlreadySent {
		t.Fatalf("second send error = %v, want ErrMailAlreadySent", err)
	}

	// Exactly one delivery, one unread count of 1, one SENT copy — the retry
	// left nothing behind.
	if n := countRows(t, s, `SELECT count(*) FROM mail_deliveries WHERE mail_id = $1 AND owner_user_id = $2`,
		mailID, b); n != 1 {
		t.Errorf("Bee's delivery rows = %d, want exactly 1", n)
	}
	if n := unreadCountFor(t, s, mailID, b); n != 1 {
		t.Errorf("Bee's unread_count = %d, want 1 (not incremented twice)", n)
	}
	if n := countRows(t, s, `SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.delivered'`,
		mailID); n != 1 {
		t.Errorf("mail.delivered events = %d, want exactly 1", n)
	}
}
