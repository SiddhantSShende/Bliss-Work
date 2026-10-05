package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/recurrence"
)

// Repeating meetings.
//
// See migrations/0033_meeting_series.sql for the model: a `call_series` row is
// the template, and each occurrence is an ordinary MEETING row, so the sweeper,
// the waiting room, invite links, recordings and transcripts all work on it with
// no knowledge that it repeats. This file is the MODEL: the series row, its DTOs
// and how it is read and saved. What is done with it — writing occurrences,
// keeping it topped up, changing and cancelling it — is in meeting_series_ops.go.
//
// ── How far ahead occurrences exist ──────────────────────────────────────────
// A rolling horizon (SeriesHorizon). The request that creates or edits a series
// writes what falls inside it, and the call sweeper tops it up as time passes, so
// a series that never ends is a handful of rows however long it runs.

const (
	// SeriesHorizon is how far ahead occurrences are written. Six weeks covers a
	// month grid with room to spare while keeping a daily meeting to ~42 rows
	// (each with a full roster) rather than years of them.
	SeriesHorizon = 42 * 24 * time.Hour
	// seriesBatchLimit bounds what ONE transaction writes for one series, so a
	// daily series with a huge roster cannot hold a transaction open for long.
	// The remainder is written on the next sweep.
	seriesBatchLimit = 60
	// SeriesSweepLimit bounds how many series one sweeper pass tops up. Small on
	// purpose, for the same reason as OverdueSweepLimit.
	SeriesSweepLimit = 20
	// SeriesUpcomingInList is how many upcoming occurrences of one series
	// ListMyCalls returns. That list is "what am I expected at", capped at one
	// page, and sorted so the FURTHEST meetings survive the cap — a daily series
	// written six weeks ahead would otherwise push every nearer meeting off it.
	// The calendar reads its own windowed endpoint and shows them all.
	SeriesUpcomingInList = 3
	// MaxActiveSeriesPerOrganiser bounds how many repeating meetings one person can
	// have running. Each writes ~six weeks of occurrences, each seating up to
	// MaxMeetingRoster people, and the write limiter is per request rather than per
	// row — so without this one member could hold a very large number of rows. Fifty
	// is far past what anybody organises.
	MaxActiveSeriesPerOrganiser = 50
)

// Series statuses.
const (
	SeriesActive    = "ACTIVE"
	SeriesCancelled = "CANCELLED"
	// SeriesCompleted means every occurrence the rule allows has been written;
	// the last ones may still be upcoming.
	SeriesCompleted = "COMPLETED"
)

// ErrMeetingTooLarge is a roster over MaxMeetingRoster.
var ErrMeetingTooLarge = errors.New("too many people on this meeting")

// ErrTooManySeries is an organiser at MaxActiveSeriesPerOrganiser.
var ErrTooManySeries = errors.New("too many repeating meetings: cancel one before starting another")

// ErrSeriesCancelled is an edit of a series that was cancelled.
var ErrSeriesCancelled = errors.New("this meeting series was cancelled")

// errNothingWritten is a series that validated but wrote no occurrence. The
// validation that precedes every write makes it unreachable; it is here so a
// future change to that validation fails loudly rather than by indexing an empty
// slice.
var errNothingWritten = errors.New("a valid meeting series produced no occurrences")

// RecurrenceDTO is a rule as the API states it.
type RecurrenceDTO struct {
	Frequency       string  `json:"frequency"`
	Interval        int     `json:"interval"`
	Weekdays        []int   `json:"weekdays"`
	EndCondition    string  `json:"endCondition"`
	EndDate         *string `json:"endDate,omitempty"`
	OccurrenceCount *int    `json:"occurrenceCount,omitempty"`
	TimeZone        string  `json:"timeZone"`
}

// SeriesSummaryDTO rides on every occurrence, so a row can say "repeats weekly".
// It carries nothing about who was invited.
type SeriesSummaryDTO struct {
	ID         string        `json:"id"`
	Status     string        `json:"status"`
	Recurrence RecurrenceDTO `json:"recurrence"`
}

// MeetingSeriesDTO is a whole series, for its organiser: what an edit form needs
// to show what was picked.
type MeetingSeriesDTO struct {
	SeriesSummaryDTO
	CreatedBy       string   `json:"createdBy"`
	Title           string   `json:"title"`
	Media           string   `json:"media"`
	StartAt         string   `json:"startAt"`
	DurationMinutes int      `json:"durationMinutes"`
	NextStartAt     *string  `json:"nextStartAt,omitempty"`
	InviteeIDs      []string `json:"inviteeIds"`
	ChannelIDs      []string `json:"channelIds"`
	OccurrenceCount int      `json:"occurrenceCount"`
}

// RecurrenceInput is a rule and the zone it is read in.
type RecurrenceInput struct {
	Rule     recurrence.Rule
	TimeZone string
}

// MeetingOptions are the parts of a new meeting beyond a plain one-off.
type MeetingOptions struct {
	ChannelIDs []string
	// Recurrence makes the meeting the first of a series. Requires a start time.
	Recurrence *RecurrenceInput
}

// SeriesPatch is an edit. A nil field is left as it was.
type SeriesPatch struct {
	Title      *string
	InviteeIDs *[]string
	ChannelIDs *[]string
	Recurrence *RecurrenceInput
}

// SeriesChange is what the API layer announces after a series changes.
type SeriesChange struct {
	Series *MeetingSeriesDTO
	// Call is the soonest occurrence the change touched, on which the ONE
	// notification a change sends is hung — never one per occurrence. nil means
	// there is nothing anybody needs telling (an edit that changed nothing).
	Call *CallDTO
	// Recipients is who to tell about Call. nil means Call's own roster; an edit that
	// only added people names just them, so everyone else is not toasted a second time.
	Recipients []string
}

// seriesRow is call_series as the code works on it.
type seriesRow struct {
	id, orgID, createdBy, title, media, timeZone, status string
	firstStart                                           time.Time
	durationMinutes                                      int
	rule                                                 recurrence.Rule
	occurrenceCount                                      int
	nextStart                                            *time.Time
	inviteeIDs, channelIDs                               []string
}

const seriesCols = `id::text, org_id::text, created_by::text, title, media, time_zone,
	first_start_at, duration_minutes, frequency, frequency_interval, weekdays,
	end_condition, end_date, occurrence_limit, occurrence_count, next_start_at,
	invitee_ids::text[], channel_ids::text[], status`

// channelIDsVisible selects a meeting's channel ids as the caller may see them. Only
// the HOSTING org does: a guest who arrived by link is an outsider, and which
// channels the host org addressed the meeting to — opaque ids, but its internal
// structure all the same — is not theirs to read. `app.org_id` is the caller's own
// org (withCaller); under a bypass transaction it is unset and the answer is empty,
// which is right, since nothing sent to a client is read that way.
const channelIDsVisible = `(CASE WHEN org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
	THEN channel_ids ELSE '{}'::uuid[] END)::text[]`

type rowScanner interface{ Scan(dest ...any) error }

func scanSeries(row rowScanner) (*seriesRow, error) {
	var (
		sr       seriesRow
		weekdays []int16
		endDate  *time.Time
		limit    *int
	)
	if err := row.Scan(&sr.id, &sr.orgID, &sr.createdBy, &sr.title, &sr.media, &sr.timeZone,
		&sr.firstStart, &sr.durationMinutes, &sr.rule.Frequency, &sr.rule.Interval, &weekdays,
		&sr.rule.EndCondition, &endDate, &limit, &sr.occurrenceCount, &sr.nextStart,
		&sr.inviteeIDs, &sr.channelIDs, &sr.status); err != nil {
		return nil, err
	}
	sr.rule.Weekdays = make([]int, len(weekdays))
	for i, d := range weekdays {
		sr.rule.Weekdays[i] = int(d)
	}
	if endDate != nil {
		sr.rule.EndDate = endDate.Format("2006-01-02")
	}
	if limit != nil {
		sr.rule.OccurrenceCount = *limit
	}
	return &sr, nil
}

func (sr *seriesRow) summary() SeriesSummaryDTO {
	rec := RecurrenceDTO{
		Frequency:    sr.rule.Frequency,
		Interval:     sr.rule.Interval,
		Weekdays:     append([]int{}, sr.rule.Weekdays...),
		EndCondition: sr.rule.EndCondition,
		TimeZone:     sr.timeZone,
	}
	if sr.rule.EndDate != "" {
		d := sr.rule.EndDate
		rec.EndDate = &d
	}
	if sr.rule.EndCondition == recurrence.EndAfterCount {
		n := sr.rule.OccurrenceCount
		rec.OccurrenceCount = &n
	}
	return SeriesSummaryDTO{ID: sr.id, Status: sr.status, Recurrence: rec}
}

func (sr *seriesRow) dto() *MeetingSeriesDTO {
	return &MeetingSeriesDTO{
		SeriesSummaryDTO: sr.summary(),
		CreatedBy:        sr.createdBy,
		Title:            sr.title,
		Media:            sr.media,
		StartAt:          *tsPtr(&sr.firstStart),
		DurationMinutes:  sr.durationMinutes,
		NextStartAt:      tsPtr(sr.nextStart),
		InviteeIDs:       nonNil(sr.inviteeIDs),
		ChannelIDs:       nonNil(sr.channelIDs),
		OccurrenceCount:  sr.occurrenceCount,
	}
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// save writes every mutable column. One statement for every change to a series —
// materialising, editing, cancelling — so they cannot drift in what they persist.
func (sr *seriesRow) save(ctx context.Context, tx pgx.Tx) error {
	var endDate *time.Time
	if sr.rule.EndDate != "" {
		d, err := time.Parse("2006-01-02", sr.rule.EndDate)
		if err != nil {
			return err
		}
		endDate = &d
	}
	var limit *int
	if sr.rule.EndCondition == recurrence.EndAfterCount {
		limit = &sr.rule.OccurrenceCount
	}
	weekdays := make([]int16, len(sr.rule.Weekdays))
	for i, d := range sr.rule.Weekdays {
		weekdays[i] = int16(d)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO call_series (id, org_id, created_by, title, media, time_zone, first_start_at,
		    duration_minutes, frequency, frequency_interval, weekdays, end_condition, end_date,
		    occurrence_limit, occurrence_count, next_start_at, invitee_ids, channel_ids, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::smallint[], $12, $13::date, $14, $15,
		    $16, $17::uuid[], $18::uuid[], $19)
		ON CONFLICT (id) DO UPDATE SET
		    title = EXCLUDED.title, time_zone = EXCLUDED.time_zone,
		    duration_minutes = EXCLUDED.duration_minutes, frequency = EXCLUDED.frequency,
		    frequency_interval = EXCLUDED.frequency_interval, weekdays = EXCLUDED.weekdays,
		    end_condition = EXCLUDED.end_condition, end_date = EXCLUDED.end_date,
		    occurrence_limit = EXCLUDED.occurrence_limit,
		    occurrence_count = EXCLUDED.occurrence_count, next_start_at = EXCLUDED.next_start_at,
		    invitee_ids = EXCLUDED.invitee_ids, channel_ids = EXCLUDED.channel_ids,
		    status = EXCLUDED.status, updated_at = now()`,
		sr.id, sr.orgID, sr.createdBy, sr.title, sr.media, sr.timeZone, sr.firstStart,
		sr.durationMinutes, sr.rule.Frequency, sr.rule.Interval, weekdays, sr.rule.EndCondition,
		endDate, limit, sr.occurrenceCount, sr.nextStart, nonNil(sr.inviteeIDs), nonNil(sr.channelIDs),
		sr.status)
	return err
}

// ── Reading ──────────────────────────────────────────────────────────────────

// seriesSummariesTx reads the series behind a page of calls, keyed by series id.
// Under RLS, so a guest from another org — who cannot read the hosting org's
// series row — simply gets no summary and sees the occurrence as a plain meeting.
func seriesSummariesTx(ctx context.Context, tx pgx.Tx, ids []string) (map[string]*SeriesSummaryDTO, error) {
	out := make(map[string]*SeriesSummaryDTO, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT `+seriesCols+` FROM call_series WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		sr, err := scanSeries(rows)
		if err != nil {
			return nil, err
		}
		sum := sr.summary()
		out[sr.id] = &sum
	}
	return out, rows.Err()
}

// loadSeriesTx reads a series, FOR UPDATE when it is about to be changed, and
// checks the caller organised it.
// Every way of not being allowed — no such series, another org's, someone else's
// — answers ErrForbidden, so nobody can probe for series ids.
func loadSeriesTx(ctx context.Context, tx pgx.Tx, seriesID, callerID string, forUpdate bool) (*seriesRow, error) {
	q := `SELECT ` + seriesCols + ` FROM call_series WHERE id = $1`
	if forUpdate {
		q += ` FOR UPDATE`
	}
	sr, err := scanSeries(tx.QueryRow(ctx, q, seriesID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if canonicalUUID(sr.createdBy) != canonicalUUID(callerID) {
		return nil, ErrForbidden
	}
	return sr, nil
}

// GetSeries reads a series for its organiser.
func (s *Store) GetSeries(ctx context.Context, orgID, callerID, seriesID string) (*MeetingSeriesDTO, error) {
	var out *MeetingSeriesDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		sr, err := loadSeriesTx(ctx, tx, seriesID, callerID, false)
		if err != nil {
			return err
		}
		out = sr.dto()
		return nil
	})
	return out, err
}
