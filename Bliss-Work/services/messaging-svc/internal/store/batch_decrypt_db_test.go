package store

// TestListChannelsAndConversationsDecryptAcrossADEKRotation and
// TestListOpenChannelsDecryptAcrossADEKRotation: regression coverage for
// Phase 11's optimization of ListChannels/ListConversations, and Phase 12's
// identical fix for ListOpenChannels — the query/scan/DEK-warm-up now run
// inside one tx, and the actual decrypt runs AFTER that tx commits and
// releases its pooled connection (see PeekVersion/WarmVersions/DecryptCached
// in internal/crypto/crypto.go, and the comments on ListChannels/
// ListConversations/ListOpenChannels themselves).
//
// Splitting decrypt out from the transaction is only safe if it still decrypts
// EVERY row correctly, including rows whose ciphertext was written under a
// DEK version that has since been rotated away — WarmVersions has to warm
// every version a result set actually references, not just the current one,
// or DecryptCached fails closed on the older rows. This seeds one channel and
// one conversation, encrypted under the pre-rotation DEK, rotates, then seeds
// a second pair encrypted under the new DEK, and asserts a single
// ListChannels/ListConversations call decrypts all four previews correctly.
//
// Must be a DB test, not a Go unit test: RotateOrgDEK writes org_keys, and
// ListChannels/ListConversations's own DEK warm-up reads it back under RLS
// (org_keys is RLS-protected — see calls_lifecycle_db_test.go's header for
// why a superuser connection would not prove anything here). See that file's
// header for how to run this (opt-in via MESSAGING_TEST_DATABASE_URL).

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestListChannelsAndConversationsDecryptAcrossADEKRotation(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()
	prePeerID := uuid.Must(uuid.NewV7()).String()
	postPeerID := uuid.Must(uuid.NewV7()).String()

	preChannel := uuid.Must(uuid.NewV7()).String()
	postChannel := uuid.Must(uuid.NewV7()).String()
	preConvID := uuid.Must(uuid.NewV7()).String()
	postConvID := uuid.Must(uuid.NewV7()).String()

	seedChannel := func(tx pgx.Tx, channelID, text string) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "chan-"+channelID[:8], callerID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, callerID); err != nil {
			return err
		}
		enc, err := s.crypto.Encrypt(ctx, tx, orgID, text)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body_enc, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, channelID, callerID, enc, uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE channels SET last_msg_at = now() WHERE id = $1`, channelID)
		return err
	}

	seedConversation := func(tx pgx.Tx, convID, peerID, text string) error {
		low, high := orderedPair(callerID, peerID)
		if _, err := tx.Exec(ctx,
			`INSERT INTO conversations (id, org_id, user_low, user_high) VALUES ($1,$2,$3,$4)`,
			convID, orgID, low, high); err != nil {
			return err
		}
		for _, uid := range []string{callerID, peerID} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO conversation_members (conversation_id, org_id, user_id) VALUES ($1,$2,$3)`,
				convID, orgID, uid); err != nil {
				return err
			}
		}
		enc, err := s.crypto.Encrypt(ctx, tx, orgID, text)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO messages (id, org_id, conversation_id, seq, sender_id, body_enc, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, convID, callerID, enc, uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE conversations SET last_msg_at = now() WHERE id = $1`, convID)
		return err
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if err := seedChannel(tx, preChannel, "before rotation (channel)"); err != nil {
			return err
		}
		return seedConversation(tx, preConvID, prePeerID, "before rotation (conversation)")
	}); err != nil {
		t.Fatalf("seed pre-rotation rows: %v", err)
	}

	oldV, newV, err := s.RotateOrgDEK(ctx, orgID)
	if err != nil {
		t.Fatalf("RotateOrgDEK: %v", err)
	}
	if newV != oldV+1 {
		t.Fatalf("RotateOrgDEK: old=%d new=%d, want new = old + 1", oldV, newV)
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if err := seedChannel(tx, postChannel, "after rotation (channel)"); err != nil {
			return err
		}
		return seedConversation(tx, postConvID, postPeerID, "after rotation (conversation)")
	}); err != nil {
		t.Fatalf("seed post-rotation rows: %v", err)
	}

	chans, err := s.ListChannels(ctx, orgID, callerID)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(chans) != 2 {
		t.Fatalf("got %d channels, want 2: %+v", len(chans), chans)
	}
	byID := map[string]string{}
	for _, c := range chans {
		if c.LastMessage == nil {
			t.Fatalf("channel %s LastMessage is nil, want a decrypted preview", c.ID)
		}
		byID[c.ID] = *c.LastMessage
	}
	if got := byID[preChannel]; got != "before rotation (channel)" {
		t.Errorf("pre-rotation channel LastMessage = %q, want %q", got, "before rotation (channel)")
	}
	if got := byID[postChannel]; got != "after rotation (channel)" {
		t.Errorf("post-rotation channel LastMessage = %q, want %q", got, "after rotation (channel)")
	}

	convs, err := s.ListConversations(ctx, orgID, callerID)
	if err != nil {
		t.Fatalf("ListConversations: %v", err)
	}
	if len(convs) != 2 {
		t.Fatalf("got %d conversations, want 2: %+v", len(convs), convs)
	}
	byConvID := map[string]string{}
	for _, c := range convs {
		if c.LastMessage == nil {
			t.Fatalf("conversation %s LastMessage is nil, want a decrypted preview", c.ID)
		}
		byConvID[c.ID] = *c.LastMessage
	}
	if got := byConvID[preConvID]; got != "before rotation (conversation)" {
		t.Errorf("pre-rotation conversation LastMessage = %q, want %q", got, "before rotation (conversation)")
	}
	if got := byConvID[postConvID]; got != "after rotation (conversation)" {
		t.Errorf("post-rotation conversation LastMessage = %q, want %q", got, "after rotation (conversation)")
	}
}

// TestListOpenChannelsDecryptAcrossADEKRotation is
// TestListChannelsAndConversationsDecryptAcrossADEKRotation's counterpart for
// ListOpenChannels (Phase 12). The browser here is deliberately NOT a member
// of either seeded channel — that is the whole point of the "open" listing —
// so the seeding helper differs from seedChannel above by never inserting a
// channel_members row for the caller.
func TestListOpenChannelsDecryptAcrossADEKRotation(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	creatorID := uuid.Must(uuid.NewV7()).String()
	browserID := uuid.Must(uuid.NewV7()).String() // never joins either channel

	preChannel := uuid.Must(uuid.NewV7()).String()
	postChannel := uuid.Must(uuid.NewV7()).String()

	seedOpenChannel := func(tx pgx.Tx, channelID, text string) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by, is_locked) VALUES ($1,$2,$3,$4,false)`,
			channelID, orgID, "open-"+channelID[:8], creatorID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, creatorID); err != nil {
			return err
		}
		enc, err := s.crypto.Encrypt(ctx, tx, orgID, text)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body_enc, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, channelID, creatorID, enc, uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE channels SET last_msg_at = now() WHERE id = $1`, channelID)
		return err
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return seedOpenChannel(tx, preChannel, "before rotation (open channel)")
	}); err != nil {
		t.Fatalf("seed pre-rotation row: %v", err)
	}

	oldV, newV, err := s.RotateOrgDEK(ctx, orgID)
	if err != nil {
		t.Fatalf("RotateOrgDEK: %v", err)
	}
	if newV != oldV+1 {
		t.Fatalf("RotateOrgDEK: old=%d new=%d, want new = old + 1", oldV, newV)
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return seedOpenChannel(tx, postChannel, "after rotation (open channel)")
	}); err != nil {
		t.Fatalf("seed post-rotation row: %v", err)
	}

	open, err := s.ListOpenChannels(ctx, orgID, browserID, 50, 0)
	if err != nil {
		t.Fatalf("ListOpenChannels: %v", err)
	}
	if len(open) != 2 {
		t.Fatalf("got %d open channels, want 2: %+v", len(open), open)
	}
	byID := map[string]string{}
	for _, c := range open {
		if c.LastMessage == nil {
			t.Fatalf("channel %s LastMessage is nil, want a decrypted preview", c.ID)
		}
		if c.IAmMember {
			t.Fatalf("channel %s reports IAmMember=true for a caller who never joined it", c.ID)
		}
		byID[c.ID] = *c.LastMessage
	}
	if got := byID[preChannel]; got != "before rotation (open channel)" {
		t.Errorf("pre-rotation open channel LastMessage = %q, want %q", got, "before rotation (open channel)")
	}
	if got := byID[postChannel]; got != "after rotation (open channel)" {
		t.Errorf("post-rotation open channel LastMessage = %q, want %q", got, "after rotation (open channel)")
	}
}
