package store

// BlockFromChannel's moderation guard and its upsert, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// Both bugs this file exists to catch are about real rows: whether
// channelRole actually reports RoleAdmin for the target and RoleOwner (or
// not) for the caller before the block is allowed to proceed, and whether the
// ON CONFLICT upsert genuinely leaves the new reason in the table rather than
// just not erroring. A fake store would have to encode the answer to both
// questions itself.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedChannelWithRoles creates one channel with an explicit owner and any
// number of additional (userID, role) members.
func seedChannelWithRoles(t *testing.T, s *Store, orgID, ownerID string, others map[string]string) (channelID string) {
	t.Helper()
	ctx := context.Background()
	channelID = uuid.Must(uuid.NewV7()).String()

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "moderation-test", ownerID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id, role) VALUES ($1,$2,$3,'owner')`,
			channelID, orgID, ownerID); err != nil {
			return err
		}
		for userID, role := range others {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id, role) VALUES ($1,$2,$3,$4)`,
				channelID, orgID, userID, role); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	return channelID
}

func blockReason(t *testing.T, s *Store, channelID, userID string) string {
	t.Helper()
	ctx := context.Background()
	var reason string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT reason FROM channel_blocks WHERE channel_id = $1 AND user_id = $2`,
			channelID, userID).Scan(&reason)
	}); err != nil {
		t.Fatalf("read channel_blocks: %v", err)
	}
	return reason
}

// ── The bug: an admin must not be able to block a fellow admin ───────────────
func TestBlockFromChannel_AdminCannotBlockFellowAdmin(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	adminA := uuid.Must(uuid.NewV7()).String()
	adminB := uuid.Must(uuid.NewV7()).String()
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{
		adminA: RoleAdmin, adminB: RoleAdmin,
	})

	err := s.BlockFromChannel(ctx, orgID, channelID, adminA, adminB, "no reason given", nil)
	if err != ErrForbidden {
		t.Fatalf("admin blocking a fellow admin = %v, want ErrForbidden — the exact "+
			"'removal war' KickChannelMember is documented to prevent, reachable via Block instead", err)
	}

	role, err := roleFor(t, s, channelID, adminB)
	if err != nil {
		t.Fatalf("read role: %v", err)
	}
	if role != RoleAdmin {
		t.Errorf("adminB's role = %q after a refused block, want unchanged %q", role, RoleAdmin)
	}
}

// ── Positive control: the owner CAN block an admin ────────────────────────────
func TestBlockFromChannel_OwnerCanBlockAdmin(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	admin := uuid.Must(uuid.NewV7()).String()
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{admin: RoleAdmin})

	if err := s.BlockFromChannel(ctx, orgID, channelID, owner, admin, "abusive", nil); err != nil {
		t.Fatalf("owner blocking an admin = %v, want success", err)
	}
	role, err := roleFor(t, s, channelID, admin)
	if err != nil {
		t.Fatalf("read role: %v", err)
	}
	if role != "" {
		t.Errorf("blocked admin's role = %q, want removed from the roster entirely", role)
	}
}

// ── Positive control: an org_admin CAN block a channel admin too ─────────────
func TestBlockFromChannel_OrgAdminCanBlockChannelAdmin(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	admin := uuid.Must(uuid.NewV7()).String()
	orgAdmin := uuid.Must(uuid.NewV7()).String() // not even a channel member
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{admin: RoleAdmin})

	if err := s.BlockFromChannel(ctx, orgID, channelID, orgAdmin, admin, "policy", []string{"org_admin"}); err != nil {
		t.Fatalf("org_admin blocking a channel admin = %v, want success", err)
	}
}

// ── The bug: re-blocking someone must update the stored reason, not just
// blocked_by ────────────────────────────────────────────────────────────────
func TestBlockFromChannel_ReblockUpdatesReason(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	other := uuid.Must(uuid.NewV7()).String()
	target := uuid.Must(uuid.NewV7()).String()
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{
		other: RoleAdmin, target: RoleMember,
	})

	if err := s.BlockFromChannel(ctx, orgID, channelID, owner, target, "first reason", nil); err != nil {
		t.Fatalf("first block: %v", err)
	}
	if got := blockReason(t, s, channelID, target); got != "first reason" {
		t.Fatalf("reason after first block = %q, want %q", got, "first reason")
	}

	// Re-block by a different moderator with an updated reason.
	if err := s.BlockFromChannel(ctx, orgID, channelID, other, target, "corrected reason", nil); err != nil {
		t.Fatalf("second block: %v", err)
	}
	if got := blockReason(t, s, channelID, target); got != "corrected reason" {
		t.Errorf("reason after re-block = %q, want %q — the ON CONFLICT upsert must update reason, not just blocked_by",
			got, "corrected reason")
	}
}

func roleFor(t *testing.T, s *Store, channelID, userID string) (string, error) {
	t.Helper()
	ctx := context.Background()
	var role string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var scanErr error
		role, scanErr = channelRole(ctx, tx, channelID, userID)
		return scanErr
	})
	return role, err
}
