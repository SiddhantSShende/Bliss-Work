package store

// channelMemberIDs' fan-out cap, and channelMemberIDsAll's uncapped roster
// read, against a real Postgres.
//
// This has to be a DB test: the behaviour under test IS the SQL LIMIT and the
// keyset pagination, so a Go-only test around a fake pgx.Tx would just be
// re-asserting the query string rather than proving it does what it says
// against a real table. See calls_lifecycle_db_test.go's header for the
// harness reused here (opt-in via MESSAGING_TEST_DATABASE_URL) and how to run
// it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedChannelWithMembers creates one channel owned by a fresh user and adds
// `count` members to it in a single set-based INSERT — the same
// unnest(...) shape AddChannelMembers uses, so seeding even a very large
// roster stays one round trip. Returns the channel id and every member id
// that was inserted.
func seedChannelWithMembers(t *testing.T, s *Store, count int) (channelID string, memberIDs []string) {
	t.Helper()
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	creatorID := uuid.Must(uuid.NewV7()).String()
	channelID = uuid.Must(uuid.NewV7()).String()

	ids := make([]string, count)
	for i := range ids {
		ids[i] = uuid.Must(uuid.NewV7()).String()
	}

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "fanout-test", creatorID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id)
			 SELECT $1, $2, unnest($3::uuid[])`,
			channelID, orgID, ids)
		return err
	}); err != nil {
		t.Fatalf("seed channel with %d members: %v", count, err)
	}
	return channelID, ids
}

// TestChannelMemberIDsCapsAtMaxChannelFanout is the regression test for the
// hot-path risk A3 exists to close: without a LIMIT, a channel large enough
// makes channelMemberIDs return a roster big enough for the event it's
// embedded in to trip kafka/outbox.go's maxPublishBytes ceiling and get
// dead-lettered — silently, since the message itself still sends. This proves
// the query never returns more than maxChannelFanout ids, however large the
// channel actually is.
func TestChannelMemberIDsCapsAtMaxChannelFanout(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	// One over the cap so a bug that drops the "+1" (or the cap itself) shows
	// up as an exact-count mismatch rather than an off-by-one that could pass
	// by accident.
	channelID, _ := seedChannelWithMembers(t, s, maxChannelFanout+1)

	var got []string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var err error
		got, err = channelMemberIDs(ctx, tx, channelID)
		return err
	}); err != nil {
		t.Fatalf("channelMemberIDs: %v", err)
	}

	if len(got) != maxChannelFanout {
		t.Fatalf("channelMemberIDs returned %d ids for a channel with %d members, want the cap %d",
			len(got), maxChannelFanout+1, maxChannelFanout)
	}
}

// TestChannelMemberIDsAllReturnsEveryMember proves channelMemberIDsAll — the
// roster endpoint's helper — is NOT subject to maxChannelFanout: the channel
// seeded here has more members than the cap, and every one of them must come
// back, with no duplicates, across however many internal pages that takes.
// This is what "assign to the whole channel" in the task dialog relies on;
// silently truncating it would drop assignees rather than merely delay a live
// push.
func TestChannelMemberIDsAllReturnsEveryMember(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	// Bigger than the fan-out cap AND not a multiple of the internal page
	// size, so this exercises a partial final page on top of proving the cap
	// doesn't apply.
	total := maxChannelFanout + channelMemberPageSize + 7
	channelID, seeded := seedChannelWithMembers(t, s, total)

	var got []string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var err error
		got, err = channelMemberIDsAll(ctx, tx, channelID)
		return err
	}); err != nil {
		t.Fatalf("channelMemberIDsAll: %v", err)
	}

	if len(got) != total {
		t.Fatalf("channelMemberIDsAll returned %d ids, want every seeded member (%d) — "+
			"it must not be capped like channelMemberIDs", len(got), total)
	}

	want := make(map[string]bool, len(seeded))
	for _, id := range seeded {
		want[id] = true
	}
	seen := make(map[string]bool, len(got))
	for _, id := range got {
		if seen[id] {
			t.Fatalf("channelMemberIDsAll returned duplicate id %s (pagination cursor bug)", id)
		}
		seen[id] = true
		if !want[id] {
			t.Fatalf("channelMemberIDsAll returned id %s that was never seeded", id)
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("channelMemberIDsAll returned %d distinct ids, want %d (some seeded member is missing)",
			len(seen), len(want))
	}
}
