package store

// B-MSG-9: when ListMyCalls overflows its page it must keep the calls the caller
// is about to be in, not the furthest-future ones — while still answering newest
// first. See calls_lifecycle_db_test.go's header for the harness.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestListMyCalls_OverflowKeepsSoonestAndLiveAndStaysNewestFirst(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]

	at := func(h time.Duration) time.Time { return time.Now().UTC().Add(h) }
	soon := meetingIn{orgID: org, host: host, start: at(2 * time.Hour)}.schedule(t, s)
	mid := meetingIn{orgID: org, host: host, start: at(5 * time.Hour)}.schedule(t, s)
	far := meetingIn{orgID: org, host: host, start: at(9 * time.Hour)}.schedule(t, s)
	farthest := meetingIn{orgID: org, host: host, start: at(12 * time.Hour)}.schedule(t, s)
	live := meetingIn{orgID: org, host: host, start: at(7 * time.Hour)}.schedule(t, s)
	// The call that is happening now, however its scheduled time sorts.
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE calls SET status = 'LIVE', started_at = now() WHERE id = $1`, live.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	// Page of 3 from 5 candidates: LIVE, then the two soonest upcoming.
	got, err := s.ListMyCalls(ctx, org, host, 3)
	if err != nil {
		t.Fatalf("ListMyCalls: %v", err)
	}
	var ids []string
	for _, c := range got {
		ids = append(ids, c.ID)
	}
	// Response order is unchanged: newest (by time) first.
	want := []string{live.ID, mid.ID, soon.ID}
	if len(ids) != len(want) {
		t.Fatalf("got %d calls %v, want %v (far=%s farthest=%s must be the ones cut)", len(ids), ids, want, far.ID, farthest.ID)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("got %v, want %v", ids, want)
		}
	}

	// A page that fits everything is the plain newest-first list, as before.
	all, err := s.ListMyCalls(ctx, org, host, 100)
	if err != nil {
		t.Fatal(err)
	}
	wantAll := []string{farthest.ID, far.ID, live.ID, mid.ID, soon.ID}
	if len(all) != len(wantAll) {
		t.Fatalf("got %d calls, want %d", len(all), len(wantAll))
	}
	for i := range wantAll {
		if all[i].ID != wantAll[i] {
			t.Fatalf("full list order = %v, want %v", callIDsOf(all), wantAll)
		}
	}
}

func callIDsOf(cs []CallDTO) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.ID
	}
	return out
}
