package store

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// Editing a repeating meeting.
//
// An edit RECONCILES the series' upcoming occurrences with the new schedule; it
// does not rewrite them. Reconciling is what keeps an edit from breaking things
// people are already holding:
//
//   - an occurrence whose instant is still in the schedule keeps its id, so a join
//     link already sent for it still works, a guest who arrived by link is still
//     there, and someone waiting in its lobby is not thrown out;
//   - only instants that LEFT the schedule are removed, and only instants that are
//     NEW are written;
//   - people are diffed, not replaced: the series adds the members it now wants and
//     removes only the ones IT seated (call_participants.series_seated), never a
//     guest or someone another participant invited to that one meeting.
//
// Occurrences that have started or are over are history and are never touched.

// UpdateSeries changes a series and reconciles its upcoming occurrences.
//
// The schedule stays anchored where it began (first start, zone), so "every 2
// weeks" keeps its rhythm and the time of day does not move. Its END is counted
// across the occurrences that already exist: "after 10" on a series that has held
// 3 leaves 7.
//
// An edit that would leave nothing upcoming is refused — that is a cancellation,
// and it should say so.
//
// It announces at most once (SeriesChange.Call): to everyone when the schedule or
// title changed, to only the newly added people when nothing but the people
// changed, and to nobody when nothing changed.
func (s *Store) UpdateSeries(
	ctx context.Context, orgID, callerID, seriesID string, p SeriesPatch,
) (*SeriesChange, error) {
	var out *SeriesChange
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		var err error
		out, err = updateSeriesTx(ctx, tx, orgID, callerID, seriesID, p)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func updateSeriesTx(
	ctx context.Context, tx pgx.Tx, orgID, callerID, seriesID string, p SeriesPatch,
) (*SeriesChange, error) {
	sr, err := loadSeriesTx(ctx, tx, seriesID, callerID, true)
	if err != nil {
		return nil, err
	}
	if sr.status == SeriesCancelled {
		return nil, ErrSeriesCancelled
	}
	before := *sr
	people := p.InviteeIDs != nil || p.ChannelIDs != nil
	sr.apply(p)
	if p.ChannelIDs != nil {
		if err := requireCallerInChannelsTx(ctx, tx, orgID, callerID, sr.channelIDs); err != nil {
			return nil, err
		}
	}
	sched, err := recurrence.New(sr.rule, sr.firstStart, sr.timeZone)
	if err != nil {
		return nil, err
	}
	sr.rule = sched.Rule // the normalised form, exactly as a create stores it
	// Only what the organiser just chose is refused if it no longer qualifies; a
	// member deactivated since is dropped quietly, as in a top-up.
	roster, err := resolveRosterTx(ctx, tx, orgID, callerID, sr.inviteeIDs, sr.channelIDs, people)
	if err != nil {
		return nil, err
	}
	res, err := sr.reconcileTx(ctx, tx, sched, roster, time.Now().UTC(), time.Now().UTC().Add(SeriesHorizon))
	if err != nil {
		return nil, err
	}

	out := &SeriesChange{Series: sr.dto()}
	scheduleChanged := before.title != sr.title || before.timeZone != sr.timeZone ||
		!sameRule(before.rule, sr.rule)
	if !scheduleChanged && len(res.added) == 0 {
		return out, nil // nothing anybody needs telling
	}
	if out.Call, err = getCallTx(ctx, tx, res.firstID); err != nil {
		return nil, err
	}
	if !scheduleChanged {
		out.Recipients = res.added // only the newly invited, not a second toast for everyone else
	}
	return out, nil
}

// sameRule compares rules by what they say. Not reflect.DeepEqual: a rule read from
// the database carries an empty weekday list where one built from a request carries
// none at all, and treating that as a change would announce every no-op edit.
func sameRule(a, b recurrence.Rule) bool {
	return a.Frequency == b.Frequency && a.Interval == b.Interval &&
		a.EndCondition == b.EndCondition && a.EndDate == b.EndDate &&
		a.OccurrenceCount == b.OccurrenceCount && slices.Equal(a.Weekdays, b.Weekdays)
}

func (sr *seriesRow) apply(p SeriesPatch) {
	if p.Title != nil {
		sr.title = *p.Title
	}
	if p.InviteeIDs != nil {
		sr.inviteeIDs = uniqueExcept(*p.InviteeIDs, sr.createdBy)
	}
	if p.ChannelIDs != nil {
		sr.channelIDs = uniqueExcept(*p.ChannelIDs, "")
	}
	if p.Recurrence != nil {
		sr.rule = p.Recurrence.Rule
		if p.Recurrence.TimeZone != "" {
			sr.timeZone = p.Recurrence.TimeZone
		}
	}
}

type occurrenceRef struct {
	id string
	at time.Time
}

// reconciled is what an edit did that the caller needs to know.
type reconciled struct {
	// firstID is the soonest upcoming occurrence after the edit.
	firstID string
	// added are the people newly placed on an occurrence that already existed.
	added []string
}

// reconcileTx brings the series' upcoming occurrences in line with `sched` and
// `roster`, and saves the series. See the header of this file for what it keeps.
func (sr *seriesRow) reconcileTx(
	ctx context.Context, tx pgx.Tx, sched recurrence.Schedule, roster []string, now, horizon time.Time,
) (reconciled, error) {
	var out reconciled
	existing, err := upcomingOccurrencesTx(ctx, tx, sr.id, now)
	if err != nil {
		return out, err
	}
	settledAt, settled, err := settledOccurrencesTx(ctx, tx, sr.id, now)
	if err != nil {
		return out, err
	}

	var start *time.Time
	if first, ok := sched.After(now); ok {
		start = &first
	}
	wanted, next := planOccurrences(occurrencePlan{
		Sched: sched, Start: start, Produced: settled, Horizon: horizon, AtLeastOne: true,
		Limit: seriesBatchLimit, Exists: settledAt,
	})
	if len(wanted) == 0 {
		return out, fmt.Errorf("%w: the new schedule has no upcoming meetings; cancel the series instead",
			recurrence.ErrInvalid)
	}

	byInstant := make(map[int64]occurrenceRef, len(existing))
	for _, e := range existing {
		byInstant[e.at.Unix()] = e
	}
	idAt := make(map[int64]string, len(wanted))
	var keep []string
	var add []time.Time
	for _, at := range wanted {
		if e, ok := byInstant[at.Unix()]; ok {
			keep = append(keep, e.id)
			idAt[at.Unix()] = e.id
			delete(byInstant, at.Unix())
		} else {
			add = append(add, at)
		}
	}
	// What is left of the existing occurrences is no longer in the schedule.
	drop := make([]string, 0, len(byInstant))
	for _, e := range byInstant {
		drop = append(drop, e.id)
	}

	if len(drop) > 0 {
		if _, err := removeOccurrencesTx(ctx, tx, drop); err != nil {
			return out, err
		}
	}
	if len(keep) > 0 {
		if err := sr.refreshOccurrencesTx(ctx, tx, keep); err != nil {
			return out, err
		}
		if out.added, err = reconcileRostersTx(ctx, tx, sr, keep, roster); err != nil {
			return out, err
		}
	}
	for _, at := range add {
		id, err := sr.insertAt(ctx, tx, at, roster)
		if err != nil {
			return out, err
		}
		idAt[at.Unix()] = id
	}

	sr.occurrenceCount = settled + len(wanted)
	sr.nextStart = next
	sr.status = SeriesActive
	if next == nil {
		sr.status = SeriesCompleted
	}
	out.firstID = idAt[wanted[0].Unix()]
	return out, sr.save(ctx, tx)
}

// upcomingOccurrencesTx locks and lists a series' occurrences that have not started
// and lie after `now`, soonest first. Locked because both an edit and a cancel are
// about to change or remove them.
func upcomingOccurrencesTx(ctx context.Context, tx pgx.Tx, seriesID string, now time.Time) ([]occurrenceRef, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, scheduled_at FROM calls
		WHERE series_id = $1 AND status = 'SCHEDULED' AND scheduled_at > $2
		ORDER BY scheduled_at
		FOR UPDATE`, seriesID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []occurrenceRef
	for rows.Next() {
		var r occurrenceRef
		if err := rows.Scan(&r.id, &r.at); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// settledOccurrencesTx reads what an edit must leave alone — every occurrence that
// is not upcoming: started, over, or due this instant — as the instants they occupy
// and how many there are, since they count toward an "after N" end.
func settledOccurrencesTx(ctx context.Context, tx pgx.Tx, seriesID string, now time.Time) (map[int64]bool, int, error) {
	rows, err := tx.Query(ctx, `
		SELECT scheduled_at FROM calls
		WHERE series_id = $1 AND NOT (status = 'SCHEDULED' AND scheduled_at > $2)`, seriesID, now)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	at := map[int64]bool{}
	n := 0
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, 0, err
		}
		at[t.Unix()] = true
		n++
	}
	return at, n, rows.Err()
}

// refreshOccurrencesTx brings the fields an edit can change on occurrences it is
// keeping up to date — the title and the channels they were addressed to. Their
// instant, duration and media are not editable, so they are not touched.
func (sr *seriesRow) refreshOccurrencesTx(ctx context.Context, tx pgx.Tx, ids []string) error {
	_, err := tx.Exec(ctx, `
		UPDATE calls SET title = $2, channel_ids = $3::uuid[]
		WHERE id = ANY($1::uuid[])
		  AND (title IS DISTINCT FROM $2 OR channel_ids IS DISTINCT FROM $3::uuid[])`,
		ids, sr.title, nonNil(sr.channelIDs))
	return err
}

// seat is one existing participant of an occurrence.
type seat struct {
	orgID  string
	role   string
	seated bool // placed by the series (call_participants.series_seated)
}

// reconcileRostersTx makes the series-placed people on the given occurrences match
// `roster`, and returns the people it newly placed (each once, however many
// occurrences they joined).
//
// It ADDS members the series now wants, skipping any who would share a room with a
// participant they have a block with — the roster-wide rule AddParticipant applies,
// checked here against people the series did not choose (a manual addition) — and
// REMOVES only participants the series itself placed who are no longer wanted. The
// host, guests who arrived by link, and people another participant added by hand are
// never removed.
func reconcileRostersTx(
	ctx context.Context, tx pgx.Tx, sr *seriesRow, callIDs []string, roster []string,
) ([]string, error) {
	current, err := readSeatsTx(ctx, tx, callIDs)
	if err != nil {
		return nil, err
	}
	want := make(map[string]bool, len(roster))
	for _, u := range roster {
		want[u] = true
	}

	var addCall, addUser, delCall, delUser []string
	seenAdded := map[string]bool{}
	var added []string
	for _, callID := range callIDs {
		have := current[callID]
		adds, err := seatable(ctx, tx, sr.orgID, have, roster)
		if err != nil {
			return nil, err
		}
		for _, u := range adds {
			addCall, addUser = append(addCall, callID), append(addUser, u)
			if !seenAdded[u] {
				seenAdded[u] = true
				added = append(added, u)
			}
		}
		for u, st := range have {
			if st.seated && st.role != RoleHost && !want[u] {
				delCall, delUser = append(delCall, callID), append(delUser, u)
			}
		}
	}

	if len(delCall) > 0 {
		if _, err := tx.Exec(ctx, `
			DELETE FROM call_participants
			WHERE (call_id, user_id) IN (SELECT c, u FROM unnest($1::uuid[], $2::uuid[]) AS t(c, u))`,
			delCall, delUser); err != nil {
			return nil, err
		}
	}
	if len(addCall) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by, series_seated)
			SELECT c, u, $3, 'PARTICIPANT', $4, true FROM unnest($1::uuid[], $2::uuid[]) AS t(c, u)
			ON CONFLICT (call_id, user_id) DO NOTHING`,
			addCall, addUser, sr.orgID, sr.createdBy); err != nil {
			return nil, err
		}
	}
	return added, nil
}

// readSeatsTx reads who is on each occurrence. Under bypass, because a guest from
// another org holds a row stamped with THEIR org that the host's RLS hides — and
// hiding them here would make an edit blind to exactly the people it must not
// disturb. Put back to what it was, as endCallTx does.
func readSeatsTx(ctx context.Context, tx pgx.Tx, callIDs []string) (map[string]map[string]seat, error) {
	prev, err := beginBypassGUC(ctx, tx)
	if err != nil {
		return nil, err
	}
	out, rerr := func() (map[string]map[string]seat, error) {
		rows, err := tx.Query(ctx, `
			SELECT call_id::text, user_id::text, org_id::text, role, series_seated
			FROM call_participants WHERE call_id = ANY($1::uuid[])`, callIDs)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := make(map[string]map[string]seat, len(callIDs))
		for rows.Next() {
			var callID, userID string
			var st seat
			if err := rows.Scan(&callID, &userID, &st.orgID, &st.role, &st.seated); err != nil {
				return nil, err
			}
			if out[callID] == nil {
				out[callID] = map[string]seat{}
			}
			out[callID][userID] = st
		}
		return out, rows.Err()
	}()
	if serr := restoreBypassGUC(ctx, tx, prev); rerr == nil {
		rerr = serr
	}
	return out, rerr
}

// seatable filters the wanted roster to the people an occurrence does not already
// have and may be added to it: none may have a block with someone already there.
func seatable(ctx context.Context, tx pgx.Tx, orgID string, have map[string]seat, roster []string) ([]string, error) {
	var adds, sameOrg []string
	for _, u := range roster {
		if _, ok := have[u]; !ok {
			adds = append(adds, u)
		}
	}
	if len(adds) == 0 {
		return nil, nil
	}
	for u, st := range have {
		if st.orgID == orgID {
			sameOrg = append(sameOrg, u)
		}
	}
	if len(sameOrg) == 0 {
		return adds, nil
	}
	blocked, err := blockedPairsTx(ctx, tx, orgID, append(append([]string{}, sameOrg...), adds...))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, u := range adds {
		if !conflicts(blocked, u, sameOrg) {
			out = append(out, u)
		}
	}
	return out, nil
}
