package store

// The channel roster is paged with LIMIT/OFFSET, so its order must be total,
// against a real Postgres with RLS enforcing.
//
// Members added together (a bulk invite, or the seed of a new channel) share one
// joined_at. The roster was ordered by (role rank, joined_at) alone, so those ties
// broke differently for each LIMIT+OFFSET: a page could repeat a member that
// another page had already shown, and skip one that no page showed, which an admin
// reading the roster cannot tell from the person not being there.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestChannelRoster_PagingShowsEveryMemberOnceWhenTheyShareAJoinTime(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, owner, "owner", "Owner")

	others := map[string]string{}
	for i := 0; i < 11; i++ {
		id := uuid.Must(uuid.NewV7()).String()
		others[id] = "member"
		seedUser(t, s, orgID, id, "member"+id[:8], "Member")
	}
	channelID := seedChannelWithRoles(t, s, orgID, owner, others)

	roster := func(limit, offset int) []string {
		t.Helper()
		members, err := s.ChannelRoster(ctx, orgID, channelID, owner, nil, limit, offset)
		if err != nil {
			t.Fatalf("ChannelRoster(limit=%d, offset=%d): %v", limit, offset, err)
		}
		ids := make([]string, 0, len(members))
		for _, m := range members {
			ids = append(ids, m.UserID)
		}
		return ids
	}

	everything := roster(100, 0)
	if len(everything) != 12 {
		t.Fatalf("unpaged roster has %d members, want 12", len(everything))
	}
	var paged []string
	for offset := 0; offset < 12; offset += 3 {
		paged = append(paged, roster(3, offset)...)
	}

	seen := map[string]int{}
	for _, id := range paged {
		seen[id]++
	}
	if len(seen) != 12 {
		t.Errorf("paging showed %d distinct members, want 12 (some were skipped)", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("member %s appeared %d times across pages, want once", id, n)
		}
	}
	for i := range everything {
		if paged[i] != everything[i] {
			t.Fatalf("paged order differs from the unpaged order at %d: %s vs %s", i, paged[i], everything[i])
		}
	}
}
