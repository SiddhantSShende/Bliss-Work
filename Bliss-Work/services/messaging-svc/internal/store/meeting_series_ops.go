package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// The operations on a repeating meeting: writing its occurrences, keeping it
// topped up, changing it and cancelling it. The model they act on — the series
// row, its DTOs and how it is read and saved — is in meeting_series.go.

// ── Writing occurrences ──────────────────────────────────────────────────────

// materializeTx writes the occurrences that fall inside the horizon, advancing the
// series' cursor as it goes, and saves the series. Which instants those are is
// planOccurrences' decision, not this function's.
//
// notBefore is the earliest instant worth writing (zero for "any"): a top-up passes
// "now" so a series that was paused resumes from the present. exists are instants
// that already have an occurrence, which are stepped over rather than written again.
//
// Returns the ids written, in order.
func (sr *seriesRow) materializeTx(
	ctx context.Context, tx pgx.Tx, sched recurrence.Schedule, roster []string,
	horizon, notBefore time.Time, exists map[int64]bool, atLeastOne bool,
) ([]string, error) {
	planned, next := planOccurrences(occurrencePlan{
		Sched: sched, Start: sr.nextStart, Produced: sr.occurrenceCount,
		Horizon: horizon, AtLeastOne: atLeastOne, Limit: seriesBatchLimit, NotBefore: notBefore, Exists: exists,
	})
	created := make([]string, 0, len(planned))
	for _, at := range planned {
		id, err := sr.insertAt(ctx, tx, at, roster)
		if err != nil {
			return nil, err
		}
		created = append(created, id)
	}
	sr.occurrenceCount += len(planned)
	sr.nextStart = next
	if next == nil {
		sr.status = SeriesCompleted
	}
	return created, sr.save(ctx, tx)
}

// insertAt writes one occurrence of the series at `at`, seating `roster` as the
// series' own people.
func (sr *seriesRow) insertAt(ctx context.Context, tx pgx.Tx, at time.Time, roster []string) (string, error) {
	spec := occurrenceSpec{
		orgID: sr.orgID, hostID: sr.createdBy, title: sr.title, media: sr.media,
		at: &at, channelIDs: sr.channelIDs, seriesID: &sr.id, roster: roster,
	}
	if sr.durationMinutes > 0 {
		end := at.Add(time.Duration(sr.durationMinutes) * time.Minute)
		spec.endsAt = &end
	}
	return insertOccurrenceTx(ctx, tx, spec)
}

type seriesCreate struct {
	orgID, hostID, title, media string
	start                       time.Time
	endsAt                      *time.Time
	rec                         RecurrenceInput
	invitees, channels          []string
}

// createSeriesTx starts a series and writes its first occurrences, returning the
// id of the first. `roster` is who to seat, already resolved.
func createSeriesTx(ctx context.Context, tx pgx.Tx, c seriesCreate, roster []string) (string, error) {
	sched, err := recurrence.New(c.rec.Rule, c.start, c.rec.TimeZone)
	if err != nil {
		return "", err
	}
	first, _ := sched.After(sched.Anchor.Add(-time.Nanosecond)) // New proved it exists
	minutes := 0
	if c.endsAt != nil {
		minutes = int(c.endsAt.Sub(c.start) / time.Minute)
	}
	sr := &seriesRow{
		id: uuid.Must(uuid.NewV7()).String(), orgID: c.orgID, createdBy: c.hostID,
		title: c.title, media: c.media, timeZone: c.rec.TimeZone, firstStart: sched.Anchor,
		durationMinutes: minutes, rule: sched.Rule, nextStart: &first, status: SeriesActive,
		inviteeIDs: uniqueExcept(c.invitees, c.hostID), channelIDs: uniqueExcept(c.channels, ""),
	}
	created, err := sr.materializeTx(ctx, tx, sched, roster, time.Now().UTC().Add(SeriesHorizon), time.Time{}, nil, true)
	if err != nil {
		return "", err
	}
	if len(created) == 0 {
		return "", errNothingWritten
	}
	return created[0], nil
}

// existingInstantsTx lists the instants (unix seconds) a series already occupies at or
// after `from`.
func existingInstantsTx(ctx context.Context, tx pgx.Tx, seriesID string, from time.Time) (map[int64]bool, error) {
	rows, err := tx.Query(ctx,
		`SELECT scheduled_at FROM calls WHERE series_id = $1 AND scheduled_at >= $2`, seriesID, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			return nil, err
		}
		out[at.Unix()] = true
	}
	return out, rows.Err()
}

// requireRoomForAnotherSeriesTx refuses a new series once its organiser is running
// MaxActiveSeriesPerOrganiser. Soft on purpose: two requests racing may overshoot by
// one, which is harmless — the cap exists to bound rows, not to be exact.
func requireRoomForAnotherSeriesTx(ctx context.Context, tx pgx.Tx, organiserID string) error {
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM call_series WHERE created_by = $1 AND status = 'ACTIVE'`,
		organiserID).Scan(&n); err != nil {
		return err
	}
	if n >= MaxActiveSeriesPerOrganiser {
		return ErrTooManySeries
	}
	return nil
}

// TopUpDueSeries writes the occurrences that have come inside the horizon, for
// every active series that needs some, and reports how many series it advanced.
//
// Safe on every replica at once — the same terms as the other sweeps: each series
// is claimed FOR UPDATE SKIP LOCKED in its own transaction, so two sweepers never
// write the same occurrence and one series that fails cannot roll back the rest.
// A failure is returned (joined) after every series has had its turn.
func (s *Store) TopUpDueSeries(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = SeriesSweepLimit
	}
	horizon := time.Now().UTC().Add(SeriesHorizon)
	var ids []string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var err error
		ids, err = callIDsTx(ctx, tx, `
			SELECT id FROM call_series cs
			WHERE cs.status = 'ACTIVE' AND cs.next_start_at IS NOT NULL AND cs.next_start_at <= $1
			  AND `+organiserActive+`
			ORDER BY cs.next_start_at
			LIMIT $2`, horizon, limit)
		return err
	}); err != nil {
		return 0, err
	}
	advanced := 0
	var errs []error
	for _, id := range ids {
		did, err := s.topUpSeries(ctx, id, horizon)
		if err != nil {
			errs = append(errs, fmt.Errorf("series %s: %w", id, err))
			continue
		}
		if did {
			advanced++
		}
	}
	return advanced, errors.Join(errs...)
}

// organiserActive is true for a series whose organiser is still an active member of
// the org. A series does not outlive its organiser's membership: a suspended or
// removed person's meetings must not go on being written — seating colleagues and
// ringing them for a meeting nobody with authority can start — until the series is
// reactivated by their return.
//
// Part of the SELECT that picks series to top up, so a paused series is not picked
// at all. Left in, it would sit at the head of the queue (oldest cursor first) and
// crowd out live series every pass.
const organiserActive = `EXISTS (
	SELECT 1 FROM user_projection up
	WHERE up.user_id = cs.created_by AND up.org_id = cs.org_id AND up.active)`

func (s *Store) topUpSeries(ctx context.Context, id string, horizon time.Time) (bool, error) {
	did := false
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		sr, err := scanSeries(tx.QueryRow(ctx, `
			SELECT `+seriesCols+` FROM call_series cs
			WHERE cs.id = $1 AND cs.status = 'ACTIVE' AND cs.next_start_at <= $2
			  AND `+organiserActive+`
			FOR UPDATE SKIP LOCKED`, id, horizon))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // another replica has it, it was cancelled, or its organiser left
		}
		if err != nil {
			return err
		}
		sched, err := recurrence.New(sr.rule, sr.firstStart, sr.timeZone)
		if err != nil {
			return err
		}
		roster, err := resolveRosterTx(ctx, tx, sr.orgID, sr.createdBy, sr.inviteeIDs, sr.channelIDs, false)
		if err != nil {
			return err
		}
		// Step over anything already written at or after the cursor. The cursor is
		// supposed to sit after every occurrence, so this is normally empty — but a
		// series restored from a backup, or repaired by hand, can have a cursor that
		// does not, and writing an instant twice hits the unique index and would fail
		// every sweep of that series forever. This makes the sweeper heal instead.
		exists, err := existingInstantsTx(ctx, tx, sr.id, *sr.nextStart)
		if err != nil {
			return err
		}
		// From now: a series that was paused (organiser away, service down) must not
		// write the meetings it missed.
		created, err := sr.materializeTx(ctx, tx, sched, roster, horizon, time.Now().UTC().Add(-time.Minute), exists, false)
		did = len(created) > 0
		return err
	})
	return did, err
}

// CancelSeries stops a series and removes its upcoming occurrences. Occurrences
// that have already started or ended stay as history. Cancelling twice is not an
// error.
func (s *Store) CancelSeries(ctx context.Context, orgID, callerID, seriesID string) (*SeriesChange, error) {
	var out *SeriesChange
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		sr, err := loadSeriesTx(ctx, tx, seriesID, callerID, true)
		if err != nil {
			return err
		}
		if sr.status == SeriesCancelled {
			out = &SeriesChange{Series: sr.dto()}
			return nil
		}
		dropped, err := deleteUnstartedTx(ctx, tx, seriesID, time.Now().UTC())
		if err != nil {
			return err
		}
		sr.status, sr.nextStart = SeriesCancelled, nil
		sr.occurrenceCount -= len(dropped.ids)
		if err := sr.save(ctx, tx); err != nil {
			return err
		}
		out = &SeriesChange{Series: sr.dto(), Recipients: dropped.recipients}
		if len(dropped.ids) > 0 {
			// The rows are gone, so this describes the soonest one from what the
			// series still knows. It is a notification body, never read back.
			out.Call = &CallDTO{
				ID: dropped.ids[0], OrgID: sr.orgID, Kind: CallMeeting, Title: sr.title,
				Media: sr.media, Status: CallCancelled, ScheduledAt: tsPtr(&dropped.first),
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

type droppedOccurrences struct {
	ids        []string
	first      time.Time
	recipients []string
}

// deleteUnstartedTx removes a series' occurrences that have not started, with
// their rosters and links, and reports who was on them so the one notification a
// cancel sends can reach them after the rows that named them are gone.
func deleteUnstartedTx(ctx context.Context, tx pgx.Tx, seriesID string, now time.Time) (droppedOccurrences, error) {
	var d droppedOccurrences
	refs, err := upcomingOccurrencesTx(ctx, tx, seriesID, now)
	if err != nil || len(refs) == 0 {
		return d, err
	}
	d.first = refs[0].at
	d.ids = make([]string, len(refs))
	for i, r := range refs {
		d.ids[i] = r.id
	}
	d.recipients, err = removeOccurrencesTx(ctx, tx, d.ids)
	return d, err
}

// removeOccurrencesTx deletes occurrences with their rosters and links, and
// returns everyone who was on them.
func removeOccurrencesTx(ctx context.Context, tx pgx.Tx, ids []string) ([]string, error) {
	// A guest from another org holds a participant row stamped with THEIR org,
	// invisible under the host's RLS — the same widening endCallTx makes to close
	// a roster. Put back to what it was, not to off.
	prev, err := beginBypassGUC(ctx, tx)
	if err != nil {
		return nil, err
	}
	recipients, err := callIDsTx(ctx, tx,
		`SELECT DISTINCT user_id FROM call_participants WHERE call_id = ANY($1::uuid[])`, ids)
	if err == nil {
		_, err = tx.Exec(ctx, `DELETE FROM call_participants WHERE call_id = ANY($1::uuid[])`, ids)
	}
	if rerr := restoreBypassGUC(ctx, tx, prev); err == nil {
		err = rerr
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM call_invites WHERE call_id = ANY($1::uuid[])`, ids); err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `DELETE FROM calls WHERE id = ANY($1::uuid[])`, ids)
	return recipients, err
}
