package store

// MessageKindScreenshotAttempt, against a real Postgres with RLS enforcing.
//
// This has to be a DB test: the fix being verified replaces `body` INSIDE
// appendMessage/SendChannelMessage, after encryption and idempotency have
// already been wired up around it, so the only way to see whether a client's
// text actually reaches storage is to send it and read back what got
// encrypted. A Go-only test around screenshotAttemptBody (see
// screenshot_attempt_test.go) covers the fallback logic but cannot see
// whether SendMessage/SendChannelMessage actually CALL it instead of using
// the caller-supplied body.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) reused here.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func seedUser(t *testing.T, s *Store, orgID, userID, username, displayName string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1,$2,$3,$4)`,
			userID, orgID, username, displayName)
		return err
	}); err != nil {
		t.Fatalf("seed user: %v", err)
	}
}

// decryptedBody reads body_enc back and decrypts it inside ONE bypass
// transaction — both the table (RLS-protected by org) and org_keys (which
// Decrypt reads the DEK from) need app.bypass_rls set, same as every
// production caller already runs inside a tx for exactly this reason.
func decryptedBody(t *testing.T, s *Store, orgID string, table, idCol, id string) string {
	t.Helper()
	ctx := context.Background()
	var body string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var bodyEnc []byte
		if err := tx.QueryRow(ctx,
			"SELECT body_enc FROM "+table+" WHERE "+idCol+" = $1", id).Scan(&bodyEnc); err != nil {
			return err
		}
		decrypted, err := s.crypto.Decrypt(ctx, tx, orgID, bodyEnc)
		if err != nil {
			return err
		}
		body = decrypted
		return nil
	}); err != nil {
		t.Fatalf("read+decrypt %s.body_enc: %v", table, err)
	}
	return body
}

// TestSendMessageScreenshotAttemptBodyIsServerAuthored is the regression test
// for the impersonation bug: a malicious sender could previously post
// kind=screenshot_attempt with ANY body — e.g. falsely naming a different
// colleague — and have it rendered as an authoritative security notice.
// senderID could never be forged, but nothing in the UI shows senderID next
// to the pill, only the body text, so a forgeable body was just as bad as a
// forgeable sender. The fix authors the body server-side from the sender's
// own projected name; this proves a forged body is discarded, not stored.
func TestSendMessageScreenshotAttemptBodyIsServerAuthored(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	recipientID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "j.okafor", "Jane Okafor")
	seedUser(t, s, orgID, recipientID, "b.smith", "Bob Smith")

	forged := "Bob Smith tried to take a screenshot of this page. Also Bob owes me money."
	res, err := s.SendMessage(ctx, orgID, senderID, recipientID, forged, uuid.Must(uuid.NewV7()).String(),
		SendOptions{Kind: MessageKindScreenshotAttempt})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	got := decryptedBody(t, s, orgID, "messages", "id", res.MessageID)
	want := "Jane Okafor tried to take a screenshot"
	if got != want {
		t.Errorf("stored body = %q, want %q (forged client body must never be stored)", got, want)
	}
}

// TestSendChannelMessageScreenshotAttemptBodyIsServerAuthored mirrors the DM
// test above for the channel send path, which has its own independent
// encrypt+INSERT (channels.go's SendChannelMessage, not appendMessage).
func TestSendChannelMessageScreenshotAttemptBodyIsServerAuthored(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "priya", "Priya Nair")

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "general", senderID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, senderID)
		return err
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}

	forged := "Someone else tried to take a screenshot — not me, I promise."
	res, err := s.SendChannelMessage(ctx, orgID, channelID, senderID, forged, uuid.Must(uuid.NewV7()).String(),
		MessageKindScreenshotAttempt, "")
	if err != nil {
		t.Fatalf("SendChannelMessage: %v", err)
	}

	got := decryptedBody(t, s, orgID, "channel_messages", "id", res.MessageID)
	want := "Priya Nair tried to take a screenshot"
	if got != want {
		t.Errorf("stored body = %q, want %q (forged client body must never be stored)", got, want)
	}
}

// TestSendMessageOrdinaryTextIsUnaffected guards against the fix being too
// broad: an ordinary text message's body must pass through unchanged, exactly
// as before this existed.
func TestSendMessageOrdinaryTextIsUnaffected(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	recipientID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "j.okafor", "Jane Okafor")
	seedUser(t, s, orgID, recipientID, "b.smith", "Bob Smith")

	res, err := s.SendMessage(ctx, orgID, senderID, recipientID, "hey, got a minute?",
		uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	got := decryptedBody(t, s, orgID, "messages", "id", res.MessageID)
	if got != "hey, got a minute?" {
		t.Errorf("ordinary message body was rewritten: got %q", got)
	}
}
