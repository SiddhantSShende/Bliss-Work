package store

// ListInbox's keyset cursor precision, against a real Postgres.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// The bug this file exists to catch is a mismatch between a Go time.Format
// call and a real timestamptz column's actual precision: last_event_at is
// microsecond-precision in Postgres, and the cursor built from it used to be
// truncated to milliseconds. Whether that silently drops a row depends on the
// real WHERE clause comparing a real truncated string against real
// sub-millisecond-distinct rows — nothing a fake store or a unit test around
// the Go formatting call alone can observe.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedInboxItem inserts one THREAD inbox row with an EXACT, caller-chosen
// last_event_at — sub-millisecond precision, not `now()` — so the test can
// place two rows on either side of a millisecond boundary deterministically.
func seedInboxItem(t *testing.T, s *Store, orgID, ownerID, lastEventAt string) string {
	t.Helper()
	ctx := context.Background()
	refID := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO inbox_items (org_id, owner_user_id, item_kind, ref_id, preview, last_event_at)
			VALUES ($1, $2, 'THREAD', $3, 'test', $4::timestamptz)`,
			orgID, ownerID, refID, lastEventAt)
		return err
	}); err != nil {
		t.Fatalf("seed inbox item: %v", err)
	}
	return refID
}

// ── The bug: a row strictly between the truncated cursor and the boundary
// row's true timestamp must not be silently skipped ──────────────────────────
func TestListInbox_CursorSurvivesSubMillisecondNeighbors(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	ownerID := uuid.Must(uuid.NewV7()).String()

	// newest first: .9999 truncates to .999 (a real, not synthetic, precision
	// loss) while .9995 sits strictly between the truncated cursor and
	// newest's true value — exactly the row the old ms-truncated cursor
	// could neither return on page 1 (not the boundary row) nor page 2
	// (excluded by the truncated `< cursor` comparison).
	newestID := seedInboxItem(t, s, orgID, ownerID, "2024-01-01T00:00:00.999900+00")
	betweenID := seedInboxItem(t, s, orgID, ownerID, "2024-01-01T00:00:00.999500+00")
	oldestID := seedInboxItem(t, s, orgID, ownerID, "2024-01-01T00:00:00.500000+00")

	page1, err := s.ListInbox(ctx, orgID, ownerID, "", "", 1, nil, false)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1.Items) != 1 || page1.Items[0].RefID != newestID {
		t.Fatalf("page 1 = %+v, want exactly [newest]", page1.Items)
	}
	if page1.NextCursor == nil {
		t.Fatal("page 1 has no NextCursor; want one (2 more rows exist)")
	}

	page2, err := s.ListInbox(ctx, orgID, ownerID, "", *page1.NextCursor, 1, nil, false)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2.Items) != 1 || page2.Items[0].RefID != betweenID {
		t.Fatalf("page 2 = %+v, want exactly [between] (refId %s) — the sub-millisecond row was "+
			"silently skipped by a truncated cursor", page2.Items, betweenID)
	}

	page3, err := s.ListInbox(ctx, orgID, ownerID, "", *page2.NextCursor, 1, nil, false)
	if err != nil {
		t.Fatalf("page 3: %v", err)
	}
	if len(page3.Items) != 1 || page3.Items[0].RefID != oldestID {
		t.Fatalf("page 3 = %+v, want exactly [oldest]", page3.Items)
	}
	if page3.NextCursor != nil {
		t.Error("page 3 has a NextCursor; want nil (no rows left)")
	}
}
