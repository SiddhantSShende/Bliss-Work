package store

// The 42-day materialisation and the sweeper that maintains it: idempotency, several
// replicas at once, a restart, and races against cancel and edit. See
// meeting_series_helpers_db_test.go for how to run these.

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
	"github.com/task-board/messaging-svc/internal/recurrence"
)

// replica opens ANOTHER Store on the same database — what a second messaging-svc pod
// (or the same pod after a restart) is: its own connection pool, none of the first's
// in-memory state.
func replica(t *testing.T) *Store {
	t.Helper()
	kek, err := crypto.NewDevKEKProvider("lifecycle-test-passphrase", []byte("0123456789abcdef"), 1)
	if err != nil {
		t.Fatalf("dev KEK: %v", err)
	}
	s, err := New(context.Background(), os.Getenv("MESSAGING_TEST_DATABASE_URL"), crypto.New(kek, time.Minute))
	if err != nil {
		t.Fatalf("second connection: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// windBack puts a series back to "only the first `keep` occurrences are written", as it
// stands `keep` days into its own horizon, removing the later ones (rosters with them).
//
// ATOMIC, and under the series row lock — exactly how the application's own operations
// take it. Done as separate statements it would corrupt a series behind the back of a
// sweeper running alongside, and a race test built on that would fail for a reason that
// is the test's, not the product's.
func windBack(t *testing.T, s *Store, seriesID string, keep int) (removed int) {
	t.Helper()
	ctx := context.Background()
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM call_series WHERE id = $1 FOR UPDATE`, seriesID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT scheduled_at FROM calls WHERE series_id = $1 ORDER BY scheduled_at`, seriesID)
		if err != nil {
			return err
		}
		var ats []time.Time
		for rows.Next() {
			var at time.Time
			if err := rows.Scan(&at); err != nil {
				rows.Close()
				return err
			}
			ats = append(ats, at)
		}
		rows.Close()
		if len(ats) <= keep {
			return nil
		}
		cut := ats[keep]
		removed = len(ats) - keep
		if _, err := tx.Exec(ctx, `DELETE FROM call_participants WHERE call_id IN
			(SELECT id FROM calls WHERE series_id = $1 AND scheduled_at >= $2)`, seriesID, cut); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, seriesID, cut); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE call_series SET status = 'ACTIVE', occurrence_count = $2, next_start_at = $3 WHERE id = $1`,
			seriesID, keep, cut)
		return err
	})
	if err != nil {
		t.Fatalf("windBack: %v", err)
	}
	return removed
}

// shiftBack moves a whole series into the past by `days`: its occurrences, its anchor
// and its cursor together, so it looks like a series that was created that long ago and
// never topped up since — the shape a long pause or a long outage really leaves. The
// cursor stays AFTER every occurrence, as it always does.
func shiftBack(t *testing.T, s *Store, seriesID string, days int) {
	t.Helper()
	d := fmt.Sprintf("%d days", days)
	bypassExec(t, s, `UPDATE calls SET scheduled_at = scheduled_at - $2::interval,
		ends_at = ends_at - $2::interval WHERE series_id = $1`, seriesID, d)
	bypassExec(t, s, `UPDATE call_series SET first_start_at = first_start_at - $2::interval,
		next_start_at = next_start_at - $2::interval WHERE id = $1`, seriesID, d)
}

func newDailySeries(t *testing.T, s *Store) (org, host string, c *CallDTO) {
	t.Helper()
	org = newOrg()
	host = seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	c = meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	return org, host, c
}

// A second and third pod run the sweeper at the same moment as the first. The unique
// index is the backstop, but the design is that it is never needed: each series is
// claimed by exactly one of them.
func TestSweeper_SeveralReplicasNeverDoubleWrite(t *testing.T) {
	s := lifecycleStore(t)
	pods := []*Store{s, replica(t), replica(t)}
	_, _, c := newDailySeries(t, s)
	full := len(occurrencesOf(t, s, c.Series.ID))
	windBack(t, s, c.Series.ID, 5)

	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(pod *Store) {
			defer wg.Done()
			_, err := pod.TopUpDueSeries(context.Background(), 100)
			errs <- err
		}(pods[i%len(pods)])
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("a pod's sweep failed: %v", err)
		}
	}
	if got := len(occurrencesOf(t, s, c.Series.ID)); got != full {
		t.Fatalf("%d occurrences after twelve concurrent sweeps on three pods, want exactly %d", got, full)
	}
}

// A restart forgets everything but the database, and the database is enough: the
// series' cursor says where to resume, and running the sweep again changes nothing.
func TestSweeper_ARestartResumesFromTheCursorAndRepeatsAreNoOps(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	_, _, c := newDailySeries(t, s)
	full := len(occurrencesOf(t, s, c.Series.ID))
	windBack(t, s, c.Series.ID, 12)

	restarted := replica(t)
	if n, err := restarted.TopUpDueSeries(ctx, 100); err != nil || n != 1 {
		t.Fatalf("first sweep after the restart advanced %d series (err %v), want 1", n, err)
	}
	if got := len(occurrencesOf(t, s, c.Series.ID)); got != full {
		t.Fatalf("%d occurrences, want %d", got, full)
	}
	for i := 0; i < 3; i++ {
		if n, err := restarted.TopUpDueSeries(ctx, 100); err != nil || n != 0 {
			t.Errorf("repeat sweep %d advanced %d series (err %v), want none", i, n, err)
		}
	}
	if got := len(occurrencesOf(t, s, c.Series.ID)); got != full {
		t.Errorf("repeated sweeps changed the occurrence count to %d", got)
	}
}

// Cancelling while the sweeper is writing: whichever wins, nothing upcoming survives
// and nothing is written after the cancel.
func TestSweeper_CancelRacingATopUpLeavesNothingUpcoming(t *testing.T) {
	s := lifecycleStore(t)
	pods := []*Store{s, replica(t)}
	for round := 0; round < 8; round++ {
		org, host, c := newDailySeries(t, s)
		windBack(t, s, c.Series.ID, 3)

		var wg sync.WaitGroup
		errs := make(chan error, 64) // 6 goroutines x 5 sweeps + the cancel; nobody reads until Wait
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func(pod *Store) {
				defer wg.Done()
				for j := 0; j < 5; j++ {
					_, err := pod.TopUpDueSeries(context.Background(), 100)
					errs <- err
				}
			}(pods[i%2])
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(time.Duration(round*3) * time.Millisecond)
			_, err := s.CancelSeries(context.Background(), org, host, c.Series.ID)
			errs <- err
		}()
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if n := bypassCount(t, s, `SELECT count(*) FROM calls WHERE series_id = $1 AND status = 'SCHEDULED'`, c.Series.ID); n != 0 {
			t.Fatalf("round %d: %d upcoming occurrences survived a cancel", round, n)
		}
		got, _ := s.GetSeries(context.Background(), org, host, c.Series.ID)
		if got.Status != SeriesCancelled || got.NextStartAt != nil {
			t.Fatalf("round %d: series is %s with next %v", round, got.Status, got.NextStartAt)
		}
		// A sweep after the cancel writes nothing.
		if _, err := s.TopUpDueSeries(context.Background(), 100); err != nil {
			t.Fatal(err)
		}
		if n := bypassCount(t, s, `SELECT count(*) FROM calls WHERE series_id = $1 AND status = 'SCHEDULED'`, c.Series.ID); n != 0 {
			t.Fatalf("round %d: the sweeper revived a cancelled series (%d)", round, n)
		}
	}
}

// Editing while the sweeper is writing: no unique-index violation, no error, no
// duplicate, and the survivors are exactly the final rule's instants.
func TestSweeper_EditRacingATopUpNeverDuplicates(t *testing.T) {
	s := lifecycleStore(t)
	pods := []*Store{s, replica(t)}
	for round := 0; round < 6; round++ {
		org, host, c := newDailySeries(t, s)
		id := c.Series.ID

		stop := make(chan struct{})
		var wg sync.WaitGroup
		errs := make(chan error, 200)
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func(pod *Store) {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					// Keep the sweeper with work to do: rewind then top up.
					if _, err := pod.TopUpDueSeries(context.Background(), 100); err != nil {
						errs <- err
					}
				}
			}(pods[i%2])
		}

		rules := []recurrence.Rule{weeklyRule(1, 0, 2, 4), dailyRule(), weeklyRule(2, 1, 3), weeklyRule(1, 6)}
		for i, r := range rules {
			title := "round"
			if _, err := s.UpdateSeries(context.Background(), org, host, id,
				SeriesPatch{Title: &title, Recurrence: &RecurrenceInput{Rule: r, TimeZone: "UTC"}}); err != nil {
				close(stop)
				wg.Wait()
				t.Fatalf("round %d edit %d: %v", round, i, err)
			}
			// Give the sweeper real work between edits, by the same locked rewind the
			// tests above use — not by touching rows behind its back.
			windBack(t, s, id, 3)
		}
		close(stop)
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("round %d: a sweep failed during edits: %v", round, err)
		}

		// Whatever interleaving happened, the rows are a clean, duplicate-free subset of
		// the FINAL rule's schedule, in order.
		final, _ := recurrence.New(rules[len(rules)-1], nextLocal(time.UTC, time.Monday, 8), "UTC")
		rows := occurrencesOf(t, s, id)
		seen := map[int64]bool{}
		for _, r := range rows {
			if seen[r.at.Unix()] {
				t.Fatalf("round %d: two occurrences at %v", round, r.at)
			}
			seen[r.at.Unix()] = true
			if r.at.Weekday() != time.Sunday {
				t.Fatalf("round %d: %v is not a Sunday, which the final rule requires", round, r.at)
			}
			if prev, ok := final.After(r.at.Add(-time.Second)); !ok || !prev.Equal(r.at) {
				t.Fatalf("round %d: %v is not an instant of the final schedule", round, r.at)
			}
		}
	}
}

// ── The organiser leaves, or the service is down for weeks ───────────────────────

// A series does not outlive its organiser's membership. While they are inactive it is
// not topped up, and — importantly — it is not even PICKED, so it cannot sit at the
// front of the queue (oldest cursor first) and starve everyone else's.
func TestSweeper_APausedOrganisersSeriesIsNotToppedUpAndDoesNotCrowdOthersOut(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	_, host, paused := newDailySeries(t, s)
	_, _, other := newDailySeries(t, s)
	windBack(t, s, paused.Series.ID, 3)
	windBack(t, s, other.Series.ID, 3)
	// The paused series has the OLDER cursor, which is what would put it first.
	bypassExec(t, s, `UPDATE call_series SET next_start_at = now() + interval '1 day' WHERE id = $1`, paused.Series.ID)
	bypassExec(t, s, `UPDATE call_series SET next_start_at = now() + interval '2 days' WHERE id = $1`, other.Series.ID)

	if err := s.SetUserActive(ctx, host, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	pausedBefore := len(occurrencesOf(t, s, paused.Series.ID))
	// A pass of ONE series must reach the live one, not spend itself on the paused.
	n, err := s.TopUpDueSeries(ctx, 1)
	if err != nil {
		t.Fatalf("TopUpDueSeries: %v", err)
	}
	if n != 1 {
		t.Fatalf("a one-series pass advanced %d; the paused series crowded the live one out", n)
	}
	if got := len(occurrencesOf(t, s, other.Series.ID)); got <= 3 {
		t.Errorf("the live series was not topped up (%d rows)", got)
	}
	if got := len(occurrencesOf(t, s, paused.Series.ID)); got != pausedBefore {
		t.Errorf("a paused series was written to: %d -> %d", pausedBefore, got)
	}
	if err := s.SetUserActive(ctx, host, true); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
}

// After a long pause the series resumes from NOW: it does not write the meetings it
// missed (the sweeper would start every one at once), and the missed ones do not count
// against an "after N" end.
func TestSweeper_AfterALongPauseASeriesResumesFromNowAndMissedMeetingsDoNotCount(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	host := seedPeople(t, s, org, 1)[0]
	rule := dailyRule()
	rule.EndCondition, rule.OccurrenceCount = recurrence.EndAfterCount, 12
	c := meetingIn{orgID: org, host: host, start: nextLocal(time.UTC, time.Monday, 8), rule: &rule, zone: "UTC"}.schedule(t, s)
	windBack(t, s, c.Series.ID, 3)   // 3 written, 9 to go
	shiftBack(t, s, c.Series.ID, 60) // ...and that was two months ago
	if err := s.SetUserActive(ctx, host, false); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("TopUpDueSeries: %v", err)
	}
	if n := len(occurrencesOf(t, s, c.Series.ID)); n != 3 {
		t.Fatalf("a paused series was written to: %d rows", n)
	}

	if err := s.SetUserActive(ctx, host, true); err != nil {
		t.Fatalf("SetUserActive: %v", err)
	}
	if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
		t.Fatalf("TopUpDueSeries: %v", err)
	}
	if n := bypassCount(t, s, `SELECT count(*) FROM calls WHERE series_id = $1 AND scheduled_at < now() - interval '2 minutes'`, c.Series.ID); n != 3 {
		t.Errorf("%d occurrences lie in the past, want only the original 3: nothing missed may be written", n)
	}
	if n := len(occurrencesOf(t, s, c.Series.ID)); n != 12 {
		t.Errorf("%d occurrences in total, want 12: the 9 missed meetings must not count toward the end", n)
	}
	got, _ := s.GetSeries(ctx, org, host, c.Series.ID)
	if got.Status != SeriesCompleted {
		t.Errorf("status = %s", got.Status)
	}
}

// A cursor that is BEHIND occurrences that already exist — a series restored from a
// backup, or repaired by hand — must heal rather than fail every sweep forever on the
// unique index (which would also spend a slot of every pass on it).
func TestSweeper_ACursorBehindExistingOccurrencesHealsInsteadOfFailingForever(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	_, _, c := newDailySeries(t, s)
	full := len(occurrencesOf(t, s, c.Series.ID))
	rows := occurrencesOf(t, s, c.Series.ID)
	// Damage: the cursor is put back to the 5th occurrence, which exists (as do all
	// the ones after it).
	bypassExec(t, s, `UPDATE call_series SET next_start_at = $2 WHERE id = $1`, c.Series.ID, rows[4].at)

	for i := 0; i < 2; i++ {
		if _, err := s.TopUpDueSeries(ctx, 100); err != nil {
			t.Fatalf("sweep %d failed on a damaged cursor: %v", i, err)
		}
	}
	if n := len(occurrencesOf(t, s, c.Series.ID)); n != full {
		t.Errorf("%d occurrences, want the original %d: nothing may be duplicated or lost", n, full)
	}
	var next *time.Time
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT next_start_at FROM call_series WHERE id = $1`, c.Series.ID).Scan(&next)
	}); err != nil {
		t.Fatal(err)
	}
	if next == nil || !next.After(rows[len(rows)-1].at) {
		t.Errorf("the cursor was not repaired: %v", next)
	}
}

// ── Abuse and exposure ───────────────────────────────────────────────────────────

// Each series writes six weeks of occurrences; without a cap one member could hold an
// enormous number of rows, and the write rate limit counts requests, not rows.
func TestSeries_AnOrganiserCannotRunUnboundedSeries(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org := newOrg()
	p := seedPeople(t, s, org, 2)
	host, other := p[0], p[1]
	// One weekday, so each series is a handful of rows and the test stays fast.
	rule := weeklyRule(1, 0)
	start := nextLocal(time.UTC, time.Monday, 8)
	var last *CallDTO
	for i := 0; i < MaxActiveSeriesPerOrganiser; i++ {
		last = meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}.schedule(t, s)
	}
	if _, err := (meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}).tryScheduling(s); err != ErrTooManySeries {
		t.Fatalf("series number %d: err = %v, want ErrTooManySeries", MaxActiveSeriesPerOrganiser+1, err)
	}
	// One-offs are not series and are not limited by it.
	if _, err := (meetingIn{orgID: org, host: host, start: start}).tryScheduling(s); err != nil {
		t.Errorf("a one-off was refused: %v", err)
	}
	// Somebody else is unaffected.
	if _, err := (meetingIn{orgID: org, host: other, start: start, rule: &rule, zone: "UTC"}).tryScheduling(s); err != nil {
		t.Errorf("another organiser was refused: %v", err)
	}
	// Cancelling one makes room.
	if _, err := s.CancelSeries(ctx, org, host, last.Series.ID); err != nil {
		t.Fatalf("CancelSeries: %v", err)
	}
	if _, err := (meetingIn{orgID: org, host: host, start: start, rule: &rule, zone: "UTC"}).tryScheduling(s); err != nil {
		t.Errorf("after cancelling one, the next was refused: %v", err)
	}
}

// Which channels the hosting org addressed a meeting to is the host org's business: a
// guest from another org reads the meeting, but not its channel ids.
func TestSeries_AGuestDoesNotReadTheHostOrgsChannelIds(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	org, guestOrg := newOrg(), newOrg()
	p := seedPeople(t, s, org, 2)
	host, colleague := p[0], p[1]
	guest := seedPeople(t, s, guestOrg, 1)[0]
	ch := newChannel(t, s, org, host, colleague)
	c := meetingIn{orgID: org, host: host, start: time.Now().UTC().Add(3 * time.Hour), channels: []string{ch}}.schedule(t, s)

	inv, err := s.CreateInvite(ctx, org, host, c.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	joined, err := s.RedeemInvite(ctx, guestOrg, guest, inv.Token)
	if err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	if len(joined.ChannelIDs) != 0 {
		t.Errorf("the redeem response carried channel ids %v", joined.ChannelIDs)
	}
	seen, err := s.GetCall(ctx, guestOrg, guest, c.ID)
	if err != nil || len(seen.ChannelIDs) != 0 {
		t.Errorf("the guest's GetCall channelIds = %v (err %v), want none", seen.ChannelIDs, err)
	}
	list, err := s.ListMyCalls(ctx, guestOrg, guest, 50)
	if err != nil {
		t.Fatalf("ListMyCalls: %v", err)
	}
	for _, x := range list {
		if x.ID == c.ID && len(x.ChannelIDs) != 0 {
			t.Errorf("the guest's list carried channel ids %v", x.ChannelIDs)
		}
	}
	// The host org still sees them, and always as a non-nil list.
	for _, who := range []string{host, colleague} {
		got, err := s.GetCall(ctx, org, who, c.ID)
		if err != nil || len(got.ChannelIDs) != 1 || got.ChannelIDs[0] != ch {
			t.Errorf("%s reads channelIds %v (err %v), want [%s]", who, got.ChannelIDs, err, ch)
		}
	}
}
