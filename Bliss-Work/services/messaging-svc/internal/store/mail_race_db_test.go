package store

// Regression coverage for the mail-draft race conditions: requireOwnDraft and
// loadSendableDraft used to read mail_messages.status with a plain SELECT, so
// two transactions could both observe DRAFT before either committed. Whichever
// won determined the outcome; the loser then acted on a stale read — deleting
// an already-sent mail out from under its own recipients, or fanning out a
// second delivery for the same send.
//
// ── Why sequential calls cannot catch this ───────────────────────────────────
// A test that calls SendMail, waits for it to commit, then calls it again only
// ever exercises the second call's status read seeing SENT — true regardless
// of locking. The bug only ever showed up when both transactions' status reads
// happened to overlap, which a two-goroutine test without any synchronization
// would only hit by luck (or miss entirely, and still report green). These
// tests instead hold one transaction's FOR UPDATE lock open on purpose,
// confirm — via pg_stat_activity, not a sleep — that the second call is
// genuinely blocked on it, and only then let the first one proceed. That is
// the actual window the bug lived in.
//
// See calls_lifecycle_db_test.go's header for the harness this reuses.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// waitForBlockedQuery polls until some backend on this connection's server is
// waiting on a lock while running a query matching `like` (a plain SQL LIKE
// pattern), then closes `proceed` to release the goroutine holding that lock —
// on success or on timeout. Closing it unconditionally is what keeps a future
// regression here (the lock never gets contended) a fast, clear test failure
// instead of a hang: the goroutine still parked on `<-proceed` is what makes
// lifecycleStore's pool.Close() cleanup block forever otherwise.
func waitForBlockedQuery(t *testing.T, s *Store, like string, proceed chan struct{}) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := s.withBypass(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM pg_stat_activity
					WHERE wait_event_type = 'Lock' AND query LIKE $1
				)`, like).Scan(&blocked)
		}); err != nil {
			close(proceed)
			t.Fatalf("poll pg_stat_activity: %v", err)
		}
		if blocked {
			close(proceed)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(proceed)
	t.Fatalf("no backend ever blocked waiting on a query matching %q — the row lock this test depends on was never contended", like)
}

// mailDeliveryRow/mailDeliveryFor: defined once, in mail_send_db_test.go —
// this file and that one are the same package, and a second identical helper
// here previously collided with it at compile time (both declared the same
// name). Removed here rather than there since this file's version was a
// strict subset (folder only, no read) and only used for .folder.

// unreadCountFor is defined once, in mail_send_db_test.go (same package) —
// removed here for the same reason mailDeliveryRow/mailDeliveryFor were: a
// second, byte-for-byte identical definition collided with it at compile
// time.

func countMailRows(t *testing.T, s *Store, query string, args ...any) int {
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

// ── The CRITICAL finding: a discard racing a send must not delete a sent mail ─
func TestDiscardMailDraft_ConcurrentWithSend_CannotDeleteASentMail(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	if err := s.UpsertUser(ctx, a, orgID, "author", "Author A", "author@acme.test"); err != nil {
		t.Fatalf("seed author: %v", err)
	}
	if err := s.UpsertUser(ctx, b, orgID, "bee", "Bee B", "bee@acme.test"); err != nil {
		t.Fatalf("seed bee: %v", err)
	}

	mailID, err := s.CreateMailDraft(ctx, orgID, a)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	// Goroutine 1 stands in for SendMail: acquire requireOwnDraft's FOR UPDATE
	// lock, then hold the transaction open until told to proceed, at which
	// point it flips the row to SENT and commits — exactly what a real send's
	// transaction does before this test's assertions run.
	lockHeld := make(chan struct{})
	proceed := make(chan struct{})
	sendDone := make(chan error, 1)
	go func() {
		sendDone <- s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
			if err := requireOwnDraft(ctx, tx, orgID, a, mailID); err != nil {
				return err
			}
			close(lockHeld)
			<-proceed
			_, err := tx.Exec(ctx,
				`UPDATE mail_messages SET status = 'SENT', sent_at = now() WHERE id = $1 AND org_id = $2`,
				mailID, orgID)
			return err
		})
	}()
	<-lockHeld

	// Goroutine 2: the real DiscardMailDraft, racing the still-open send.
	discardDone := make(chan error, 1)
	go func() { discardDone <- s.DiscardMailDraft(ctx, orgID, a, mailID) }()

	waitForBlockedQuery(t, s, "%FROM mail_messages%FOR UPDATE%", proceed)

	if err := <-sendDone; err != nil {
		t.Fatalf("simulated send: %v", err)
	}
	if err := <-discardDone; err != ErrMailAlreadySent {
		t.Fatalf("DiscardMailDraft racing a send = %v, want ErrMailAlreadySent", err)
	}

	var status string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status FROM mail_messages WHERE id = $1`, mailID).Scan(&status)
	}); err != nil {
		t.Fatalf("read mail_messages: %v", err)
	}
	if status != MailStatusSent {
		t.Errorf("mail_messages.status = %q, want SENT — a concurrent discard must not have deleted the row", status)
	}
}

// ── The second CRITICAL finding: two concurrent sends of the same draft must
// deliver exactly once, not twice ────────────────────────────────────────────
func TestSendMail_ConcurrentDoubleSend_DeliversExactlyOnce(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	b := uuid.Must(uuid.NewV7()).String()
	if err := s.UpsertUser(ctx, a, orgID, "author", "Author A", "author@acme.test"); err != nil {
		t.Fatalf("seed author: %v", err)
	}
	if err := s.UpsertUser(ctx, b, orgID, "bee", "Bee B", "bee@acme.test"); err != nil {
		t.Fatalf("seed bee: %v", err)
	}

	mailID, err := s.CreateMailDraft(ctx, orgID, a)
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	in := SendMailInput{OrgID: orgID, UserID: a, MailID: mailID, To: []string{"bee@acme.test"}, Subject: "s", BodyText: "b"}

	// Goroutine 1 holds loadSendableDraft's lock open — standing in for the
	// first of two racing SendMail calls — until goroutine 2 is confirmed
	// blocked behind it. Mirrors SendMail's own transaction body exactly (see
	// mail_send.go), including the branch's own relayRecipients-based outbound
	// queueing, so this stand-in stays correct if that logic changes again.
	lockHeld := make(chan struct{})
	proceed := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
			author, err := loadSendableDraft(ctx, tx, orgID, a, mailID)
			if err != nil {
				return err
			}
			close(lockHeld)
			<-proceed
			recipients, err := resolveMailRecipients(ctx, tx, orgID, in.To, in.Cc, in.Bcc)
			if err != nil {
				return err
			}
			if err := s.writeSentMail(ctx, tx, in, author, time.Now().UTC()); err != nil {
				return err
			}
			if err := s.writeMailRecipients(ctx, tx, orgID, mailID, recipients); err != nil {
				return err
			}
			locals, externals := splitMailDelivery(recipients, a)
			if err := s.deliverMailInApp(ctx, tx, in, locals, mailPreview(in.Subject, in.BodyText), time.Now().UTC()); err != nil {
				return err
			}
			relayTo := relayRecipients(recipients, author.address)
			return s.queueMailOutbound(ctx, tx, in, author, recipients, relayTo, externals, time.Now().UTC())
		})
	}()
	<-lockHeld

	// Goroutine 2: the real SendMail, racing the still-open first send.
	secondDone := make(chan error, 1)
	go func() { _, secondErr := s.SendMail(ctx, in); secondDone <- secondErr }()

	waitForBlockedQuery(t, s, "%FROM mail_messages m%FOR UPDATE OF m%", proceed)

	firstErr, secondErr := <-firstDone, <-secondDone
	if firstErr != nil {
		t.Fatalf("first (held) send: %v", firstErr)
	}
	if secondErr != ErrMailAlreadySent {
		t.Fatalf("second (blocked) SendMail = %v, want ErrMailAlreadySent", secondErr)
	}

	if row, ok := mailDeliveryFor(t, s, orgID, mailID, b); !ok || row.folder != MailFolderInbox {
		t.Errorf("Bee's mail_deliveries row = %+v, ok=%v, want folder=INBOX", row, ok)
	}
	if n := countMailRows(t, s, `SELECT count(*) FROM mail_deliveries WHERE mail_id = $1 AND owner_user_id = $2`, mailID, b); n != 1 {
		t.Errorf("Bee's delivery rows = %d, want exactly 1", n)
	}
	if n := unreadCountFor(t, s, mailID, b); n != 1 {
		t.Errorf("Bee's unread_count = %d, want 1 — a second concurrent send must not double-increment it", n)
	}
	if n := countMailRows(t, s, `SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.delivered'`, mailID); n != 1 {
		t.Errorf("mail.delivered events = %d, want exactly 1 — a second concurrent send must not queue a duplicate", n)
	}
	// This branch relays to local recipients too (relayRecipients), so Bee also
	// gets exactly one mail.outbound copy — not zero, and not two from a
	// double-send.
	if n := countMailRows(t, s, `SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = 'mail.outbound' AND payload->>'envelope' = 'bee@acme.test'`, mailID); n != 1 {
		t.Errorf("mail.outbound events to Bee = %d, want exactly 1", n)
	}
}
