package store

// ReapExpiredAttachments, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch was invisible without a real database: per
// Postgres's data-modifying WITH semantics, every sub-statement of one WITH
// query sees the SAME pre-DELETE snapshot, so the query's final NOT EXISTS
// check — written to scan `attachments` directly — always found each doomed
// row's own about-to-be-deleted self and always reported zero reclaimable
// blobs, no matter what was actually in the table. `go vet`/`go build` cannot
// see that; only running the query against Postgres can.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedAttachment inserts a minimal, schema-valid attachments row directly —
// the reaper is a cross-org bypass sweep keyed only on id/org_id/sha256/
// expires_at, so it has no reason to care about a real scope/membership
// fixture the way CreateAttachment's callers do.
func seedAttachment(t *testing.T, s *Store, orgID, sha256 string, expiresAt *time.Time) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7()).String()
	uploaderID := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, sha256, mime, size_bytes, storage_path, expires_at)
			VALUES ($1, $2, $3, 'channel', $4, 'file', $5, 'application/octet-stream', 1024, $6, $7)`,
			id, orgID, uploaderID, uuid.Must(uuid.NewV7()).String(), sha256, orgID+"/"+id, expiresAt)
		return err
	}); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	return id
}

func attachmentExists(t *testing.T, s *Store, id string) bool {
	t.Helper()
	ctx := context.Background()
	var exists bool
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments WHERE id = $1)`, id).Scan(&exists)
	}); err != nil {
		t.Fatalf("check attachment existence: %v", err)
	}
	return exists
}

// ── The bug: a uniquely-owned expired blob must be reported reclaimable ──────
func TestReapExpiredAttachments_UniqueExpiredBlob_IsReportedReclaimable(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	past := time.Now().Add(-time.Hour)
	sha := "a11111111111111111111111111111111111111111111111111111111111111a"

	id := seedAttachment(t, s, orgID, sha, &past)

	expired, err := s.ReapExpiredAttachments(context.Background(), 500)
	if err != nil {
		t.Fatalf("ReapExpiredAttachments: %v", err)
	}
	if len(expired) != 1 || expired[0].OrgID != orgID || expired[0].SHA256 != sha {
		t.Fatalf("ReapExpiredAttachments = %+v, want exactly one entry for org=%s sha=%s", expired, orgID, sha)
	}
	if attachmentExists(t, s, id) {
		t.Errorf("attachment row %s still exists after being reaped", id)
	}
}

// ── The still-referenced case: a shared sha256 with a live sibling must NOT be
// reported reclaimable, even though its own (expired) row is still deleted ───
func TestReapExpiredAttachments_StillReferencedContent_IsNotReclaimed(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	past := time.Now().Add(-time.Hour)
	sha := "b22222222222222222222222222222222222222222222222222222222222222b"

	expiredID := seedAttachment(t, s, orgID, sha, &past)
	liveID := seedAttachment(t, s, orgID, sha, nil) // never expires: a committed attachment

	expired, err := s.ReapExpiredAttachments(context.Background(), 500)
	if err != nil {
		t.Fatalf("ReapExpiredAttachments: %v", err)
	}
	for _, b := range expired {
		if b.OrgID == orgID && b.SHA256 == sha {
			t.Fatalf("blob org=%s sha=%s reported reclaimable while a live sibling still references it", orgID, sha)
		}
	}
	if attachmentExists(t, s, expiredID) {
		t.Errorf("expired row %s should still have been deleted (only the BLOB must survive, via its sibling)", expiredID)
	}
	if !attachmentExists(t, s, liveID) {
		t.Errorf("live sibling row %s must not have been touched", liveID)
	}
}

// ── A row that has not expired is left alone entirely ────────────────────────
func TestReapExpiredAttachments_UnexpiredRow_IsUntouched(t *testing.T) {
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	sha := "c33333333333333333333333333333333333333333333333333333333333333c"

	id := seedAttachment(t, s, orgID, sha, nil)

	expired, err := s.ReapExpiredAttachments(context.Background(), 500)
	if err != nil {
		t.Fatalf("ReapExpiredAttachments: %v", err)
	}
	for _, b := range expired {
		if b.OrgID == orgID && b.SHA256 == sha {
			t.Fatalf("never-expiring blob org=%s sha=%s was reported reclaimable", orgID, sha)
		}
	}
	if !attachmentExists(t, s, id) {
		t.Errorf("unexpired attachment row %s was deleted", id)
	}
}
