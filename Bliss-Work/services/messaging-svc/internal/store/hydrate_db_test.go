package store

// HydrateMessages against a real Postgres — the reconstruction path for
// ws-gateway's compact outbox reference (see
// docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md sections H/S). Needs a database
// because the whole point is proving the actual SQL (the ANY($1) batch
// reads, the threads join for origin/recipientId, the warm-then-decrypt
// split) is correct against real encrypted rows — a mock would only prove
// the Go code calls a mock correctly.
//
// Opt-in, same harness as calls_lifecycle_db_test.go — see its header for
// how to stand up MESSAGING_TEST_DATABASE_URL.

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestHydrateMessages_ReconstructsSentMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.NewString()
	senderID := uuid.NewString()
	recipientID := uuid.NewString()

	res, err := s.SendMessage(ctx, orgID, senderID, recipientID, "hello from the hydrate test",
		uuid.NewString(), SendOptions{Origin: ThreadOriginChat})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	got, err := s.HydrateMessages(ctx, []string{res.MessageID})
	if err != nil {
		t.Fatalf("HydrateMessages: %v", err)
	}
	m, ok := got[res.MessageID]
	if !ok {
		t.Fatalf("HydrateMessages returned no entry for %s (result: %+v)", res.MessageID, got)
	}

	if m.Body != "hello from the hydrate test" {
		t.Errorf("Body = %q, want the original plaintext (decrypt round-trip failed)", m.Body)
	}
	if m.SenderID != senderID {
		t.Errorf("SenderID = %q, want %q", m.SenderID, senderID)
	}
	if m.RecipientID != recipientID {
		t.Errorf("RecipientID = %q, want %q (reconstructed via the threads join)", m.RecipientID, recipientID)
	}
	if m.ConversationID != res.ConversationID {
		t.Errorf("ConversationID = %q, want %q", m.ConversationID, res.ConversationID)
	}
	if m.ThreadID != res.ThreadID {
		t.Errorf("ThreadID = %q, want %q", m.ThreadID, res.ThreadID)
	}
	if m.Seq != res.Seq {
		t.Errorf("Seq = %d, want %d", m.Seq, res.Seq)
	}
	if !m.IsThreadRoot {
		t.Error("IsThreadRoot = false, want true for a fresh top-level send")
	}
	if m.Origin != ThreadOriginChat {
		t.Errorf("Origin = %q, want %q (reconstructed via the threads join)", m.Origin, ThreadOriginChat)
	}
	if m.OccurredAt == "" {
		t.Error("OccurredAt is empty, want the message's created_at")
	}
}

func TestHydrateMessages_UnknownIDIsAbsentNotError(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	got, err := s.HydrateMessages(ctx, []string{uuid.NewString()})
	if err != nil {
		t.Fatalf("HydrateMessages: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected an empty result for an unknown id, got %+v", got)
	}
}

func TestHydrateMessages_MailOriginReconstructed(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.NewString()
	senderID := uuid.NewString()
	recipientID := uuid.NewString()

	res, err := s.SendMessage(ctx, orgID, senderID, recipientID, "mail-origin body",
		uuid.NewString(), SendOptions{Origin: ThreadOriginMail})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	got, err := s.HydrateMessages(ctx, []string{res.MessageID})
	if err != nil {
		t.Fatalf("HydrateMessages: %v", err)
	}
	m, ok := got[res.MessageID]
	if !ok {
		t.Fatalf("HydrateMessages returned no entry for %s", res.MessageID)
	}
	if m.Origin != ThreadOriginMail {
		t.Errorf("Origin = %q, want %q — a client's Inbox-vs-chat filter depends on this surviving reconstruction", m.Origin, ThreadOriginMail)
	}
}

// A batch spanning multiple orgs must warm each org's own DEK, not just the
// first one seen — this is the scenario HydrateMessages' per-org grouping
// exists for for (a user's replay outbox can span every org they belong to).
func TestHydrateMessages_MultiOrgBatch(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	res1, err := s.SendMessage(ctx, uuid.NewString(), uuid.NewString(), uuid.NewString(),
		"org one body", uuid.NewString(), SendOptions{Origin: ThreadOriginChat})
	if err != nil {
		t.Fatalf("SendMessage (org 1): %v", err)
	}
	res2, err := s.SendMessage(ctx, uuid.NewString(), uuid.NewString(), uuid.NewString(),
		"org two body", uuid.NewString(), SendOptions{Origin: ThreadOriginChat})
	if err != nil {
		t.Fatalf("SendMessage (org 2): %v", err)
	}

	got, err := s.HydrateMessages(ctx, []string{res1.MessageID, res2.MessageID})
	if err != nil {
		t.Fatalf("HydrateMessages: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 reconstructed messages, got %d: %+v", len(got), got)
	}
	if got[res1.MessageID].Body != "org one body" {
		t.Errorf("org 1 body = %q", got[res1.MessageID].Body)
	}
	if got[res2.MessageID].Body != "org two body" {
		t.Errorf("org 2 body = %q", got[res2.MessageID].Body)
	}
}
