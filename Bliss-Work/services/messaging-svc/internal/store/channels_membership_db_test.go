package store

// TestListOpenChannels: the Browse tab's directory query, against a real
// Postgres.
//
// This has to be a DB test, not a Go unit test, because the bug it exists to
// catch was invisible in Go: ListOpenChannels's SELECT list had drifted out
// of sync with scanRawChannelRows's Scan call — nine columns selected
// against ten destinations, missing last_message_sender. That compiles and
// vets clean; pgx only rejects the mismatch once it actually Scans a row, and
// with zero candidate channels the scan loop never runs, so the bug was
// invisible against an empty table too. Only a query that returns at least
// one real row exposes it — which is exactly this test's shape. See
// calls_lifecycle_db_test.go's header for the harness reused here (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.
//
// The fixture also covers the two exclusions ListOpenChannels promises, so a
// regression there fails loudly rather than as a silently-too-permissive
// directory: a channel the caller already joined, and a locked channel,
// must both stay out of the result.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestListOpenChannels(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	memberID := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()

	openID := uuid.Must(uuid.NewV7()).String()   // unlocked, caller not a member — should be listed
	joinedID := uuid.Must(uuid.NewV7()).String() // unlocked, caller already a member — must not be listed
	lockedID := uuid.Must(uuid.NewV7()).String() // locked, caller not a member — must not be listed

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for _, c := range []struct {
			id       string
			isLocked bool
		}{{openID, false}, {joinedID, false}, {lockedID, true}} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channels (id, org_id, name, created_by, is_locked) VALUES ($1,$2,$3,$4,$5)`,
				c.id, orgID, "chan-"+c.id[:8], memberID, c.isLocked); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			openID, orgID, memberID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			joinedID, orgID, callerID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, openID, memberID,
			"hello from the open channel", uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1,$2,$3,$4)`,
			memberID, orgID, "nadia", "Nadia Member"); err != nil {
			return err
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := s.ListOpenChannels(ctx, orgID, callerID, 50, 0)
	if err != nil {
		// This is the failure mode the bug produced: a pgx scan error
		// ("number of field descriptions must equal number of destinations")
		// the moment a candidate row actually needs scanning.
		t.Fatalf("ListOpenChannels: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d open channels, want 1 (the joined and locked channels must be excluded): %+v", len(got), got)
	}

	c := got[0]
	if c.ID != openID {
		t.Errorf("got channel %s, want %s", c.ID, openID)
	}
	if c.LastMessageSender != "Nadia Member" {
		t.Errorf("LastMessageSender = %q, want %q", c.LastMessageSender, "Nadia Member")
	}
	if c.IAmMember {
		t.Error("IAmMember = true for a channel the caller has not joined")
	}
	if c.IsLocked {
		t.Error("IsLocked = true for a channel seeded as unlocked")
	}
}
