package store

// TestListMyChannelsPage: the New Task dialog's channel picker, against a real
// Postgres (opt-in via MESSAGING_TEST_DATABASE_URL — see calls_lifecycle_db_test.go).
//
// It pins what a picker depends on: only the caller's own memberships, a stable
// order that lets offset paging walk the whole set exactly once, a substring
// search that treats % and _ literally, and no leakage of another org's channels.

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestListMyChannelsPage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	otherOrg := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()
	otherID := uuid.Must(uuid.NewV7()).String()

	names := map[string]string{} // id → name, for the caller's channels
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		add := func(org, name, member string, locked bool) (string, error) {
			id := uuid.Must(uuid.NewV7()).String()
			if _, err := tx.Exec(ctx,
				`INSERT INTO channels (id, org_id, name, created_by, is_locked) VALUES ($1,$2,$3,$4,$5)`,
				id, org, name, otherID, locked); err != nil {
				return "", err
			}
			if member != "" {
				if _, err := tx.Exec(ctx,
					`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
					id, org, member); err != nil {
					return "", err
				}
			}
			return id, nil
		}
		// 25 channels the caller belongs to (every fifth locked), named so the order is checkable.
		for i := 0; i < 25; i++ {
			name := fmt.Sprintf("team-%02d", i)
			id, err := add(orgID, name, callerID, i%5 == 0)
			if err != nil {
				return err
			}
			names[id] = name
		}
		for _, name := range []string{"100%_done", "Design Review"} {
			id, err := add(orgID, name, callerID, false)
			if err != nil {
				return err
			}
			names[id] = name
		}
		// A second member in one of them, so the count is not just the caller.
		for id, n := range names {
			if n == "team-03" {
				if _, err := tx.Exec(ctx,
					`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
					id, orgID, otherID); err != nil {
					return err
				}
			}
		}
		// Not the caller's: an open channel they are not in, and another org's channel.
		if _, err := add(orgID, "team-not-mine", otherID, false); err != nil {
			return err
		}
		if _, err := add(otherOrg, "team-other-org", callerID, false); err != nil {
			return err
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	total := len(names) // 27

	t.Run("pages walk every membership exactly once, in a stable order", func(t *testing.T) {
		var seen []string
		for offset := 0; ; offset += 10 {
			page, err := s.ListMyChannelsPage(ctx, orgID, callerID, "", 10, offset)
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range page {
				seen = append(seen, c.ID)
				if !c.IAmMember {
					t.Errorf("%s: IAmMember must be true", c.Name)
				}
			}
			if len(page) < 10 {
				break
			}
		}
		if len(seen) != total {
			t.Fatalf("walked %d channels, want %d", len(seen), total)
		}
		uniq := map[string]bool{}
		for _, id := range seen {
			if uniq[id] {
				t.Fatalf("channel %s appeared on two pages", id)
			}
			uniq[id] = true
			if _, ok := names[id]; !ok {
				t.Fatalf("channel %s is not one of the caller's", id)
			}
		}
	})

	t.Run("a short page marks the end", func(t *testing.T) {
		page, err := s.ListMyChannelsPage(ctx, orgID, callerID, "", 10, 20)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) != 7 {
			t.Fatalf("last page has %d rows, want 7", len(page))
		}
		past, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "", 10, 500)
		if len(past) != 0 {
			t.Fatalf("a page past the end has %d rows, want 0", len(past))
		}
	})

	t.Run("search is a case-insensitive substring, paged, and literal about % and _", func(t *testing.T) {
		got, err := s.ListMyChannelsPage(ctx, orgID, callerID, "TEAM-1", 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 10 { // team-10 … team-19
			t.Fatalf("TEAM-1 matched %d, want 10", len(got))
		}
		more, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "TEAM-1", 4, 8)
		if len(more) != 2 {
			t.Fatalf("second search page has %d rows, want 2", len(more))
		}
		pct, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "%", 50, 0)
		if len(pct) != 1 || pct[0].Name != "100%_done" {
			t.Fatalf("%% must match literally, got %+v", pct)
		}
		us, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "_", 50, 0)
		if len(us) != 1 {
			t.Fatalf("_ must match literally, got %d rows", len(us))
		}
		none, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "zzz-no-such", 50, 0)
		if len(none) != 0 {
			t.Fatalf("no-match search returned %d rows", len(none))
		}
	})

	t.Run("projects what a picker shows, including member count and lock", func(t *testing.T) {
		got, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "team-03", 5, 0)
		if len(got) != 1 || got[0].MemberCount != 2 {
			t.Fatalf("team-03: %+v, want one row with 2 members", got)
		}
		locked, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "team-05", 5, 0)
		if len(locked) != 1 || !locked[0].IsLocked {
			t.Fatalf("team-05 should be locked: %+v", locked)
		}
	})

	t.Run("never offers a channel the caller is not in, nor another org's", func(t *testing.T) {
		got, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "not-mine", 50, 0)
		other, _ := s.ListMyChannelsPage(ctx, orgID, callerID, "other-org", 50, 0)
		if len(got) != 0 || len(other) != 0 {
			t.Fatalf("leaked: %+v / %+v", got, other)
		}
	})
}
