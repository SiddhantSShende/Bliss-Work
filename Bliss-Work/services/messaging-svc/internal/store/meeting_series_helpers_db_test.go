package store

// Shared fixtures for the repeating-meeting tests (meeting_series_*_db_test.go).
//
// Opt-in, on the same terms as calls_lifecycle_db_test.go — a real Postgres with
// RLS actually enforcing, reached as a role that does not bypass it:
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run 'TestMeetingSeries|TestMeetingRoster' -v

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// seedPeople seeds n active org-mates and returns their ids. ids[0] is the
// organiser by convention.
func seedPeople(t *testing.T, s *Store, orgID string, n int) []string {
	t.Helper()
	ids := make([]string, n)
	for i := range ids {
		ids[i] = uuid.Must(uuid.NewV7()).String()
		seedUser(t, s, orgID, ids[i], fmt.Sprintf("u%d-%s", i, ids[i][:8]), fmt.Sprintf("User %d", i))
	}
	return ids
}

func newOrg() string { return uuid.Must(uuid.NewV7()).String() }

// nextLocal is the next time it is `hour`:00 on a `wd`, in loc, strictly after
// tomorrow's start — so a series anchored there is never in the past.
func nextLocal(loc *time.Location, wd time.Weekday, hour int) time.Time {
	d := time.Now().In(loc).AddDate(0, 0, 1)
	for d.Weekday() != wd {
		d = d.AddDate(0, 0, 1)
	}
	return time.Date(d.Year(), d.Month(), d.Day(), hour, 0, 0, 0, loc)
}

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("zone %s: %v", name, err)
	}
	return loc
}

func weeklyRule(interval int, days ...int) recurrence.Rule {
	return recurrence.Rule{Frequency: recurrence.Weekly, Interval: interval, Weekdays: days,
		EndCondition: recurrence.EndNever}
}

func dailyRule() recurrence.Rule {
	return recurrence.Rule{Frequency: recurrence.Daily, Interval: 1, EndCondition: recurrence.EndNever}
}

// meetingIn is everything a test varies when it creates a meeting.
type meetingIn struct {
	orgID, host string
	start       time.Time
	rule        *recurrence.Rule // nil = a one-off
	zone        string
	invitees    []string
	channels    []string
}

// schedule creates a one-hour meeting and returns it, failing the test on error.
func (m meetingIn) schedule(t *testing.T, s *Store) *CallDTO {
	t.Helper()
	c, err := m.tryScheduling(s)
	if err != nil {
		t.Fatalf("ScheduleMeetingWithOptions: %v", err)
	}
	if c.Series != nil {
		retireAtEnd(t, s, c.Series.ID)
	}
	return c
}

// retireAtEnd stops a series when its test ends. The sweeper is global by design, so a
// series left ACTIVE — by a test that failed halfway, or that wound it back on purpose —
// would be topped up by every LATER test's sweep, and one left in a broken state would
// make those sweeps fail for a reason that has nothing to do with them.
func retireAtEnd(t *testing.T, s *Store, seriesID string) {
	t.Cleanup(func() {
		_ = s.withBypass(context.Background(), func(tx pgx.Tx) error {
			_, err := tx.Exec(context.Background(),
				`UPDATE call_series SET status = 'CANCELLED', next_start_at = NULL WHERE id = $1`, seriesID)
			return err
		})
	})
}

func (m meetingIn) tryScheduling(s *Store) (*CallDTO, error) {
	start := m.start
	end := start.Add(time.Hour)
	opts := MeetingOptions{ChannelIDs: m.channels}
	if m.rule != nil {
		opts.Recurrence = &RecurrenceInput{Rule: *m.rule, TimeZone: m.zone}
	}
	return s.ScheduleMeetingWithOptions(context.Background(), m.orgID, m.host,
		"Team sync", "video", &start, &end, m.invitees, opts)
}

type storedOccurrence struct {
	id, status string
	at         time.Time
}

// occurrencesOf reads a series' rows straight from the table, oldest first.
func occurrencesOf(t *testing.T, s *Store, seriesID string) []storedOccurrence {
	t.Helper()
	var out []storedOccurrence
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id::text, status, scheduled_at FROM calls
			WHERE series_id = $1 ORDER BY scheduled_at`, seriesID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var o storedOccurrence
			if err := rows.Scan(&o.id, &o.status, &o.at); err != nil {
				return err
			}
			out = append(out, o)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read occurrences: %v", err)
	}
	return out
}

// rosterOf maps user id -> role for one call, read under bypass.
func rosterOf(t *testing.T, s *Store, callID string) map[string]string {
	t.Helper()
	out := map[string]string{}
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT user_id::text, role FROM call_participants WHERE call_id = $1`, callID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var u, role string
			if err := rows.Scan(&u, &role); err != nil {
				return err
			}
			out[u] = role
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read roster: %v", err)
	}
	return out
}

// bypassExec runs one statement as the fixture — there is no caller here.
func bypassExec(t *testing.T, s *Store, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	}); err != nil {
		t.Fatalf("fixture SQL %q: %v", sql, err)
	}
}

// bypassExecErr is bypassExec for a statement that is EXPECTED to fail.
func bypassExecErr(s *Store, sql string, args ...any) error {
	ctx := context.Background()
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	})
}

func bypassCount(t *testing.T, s *Store, sql string, args ...any) int {
	t.Helper()
	var n int
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, sql, args...).Scan(&n)
	}); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// expectedInHorizon is what the schedule says should exist by `horizon`, with
// the first occurrence always present — the store's own rule, worked out
// independently through the (separately tested) recurrence engine.
func expectedInHorizon(t *testing.T, rule recurrence.Rule, start time.Time, zone string, horizon time.Time) []time.Time {
	t.Helper()
	sched, err := recurrence.New(rule, start, zone)
	if err != nil {
		t.Fatalf("recurrence.New: %v", err)
	}
	var out []time.Time
	cur, _ := sched.After(sched.Anchor.Add(-time.Nanosecond))
	for len(out) < seriesBatchLimit && sched.Allows(cur, len(out)) {
		if cur.After(horizon) && len(out) > 0 {
			break
		}
		out = append(out, cur)
		next, ok := sched.After(cur)
		if !ok {
			break
		}
		cur = next
	}
	return out
}
