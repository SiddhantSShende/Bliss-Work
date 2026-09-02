package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// The calendar read: every call the caller is in that OVERLAPS a window.
//
// ── Why neither existing read answers this ───────────────────────────────────
// ListMyCalls answers "what am I expected at" and caps finished calls at
// MyCallsHistoryDays, so a calendar navigated back past a month renders as an
// empty week that is not empty. ListMyCallHistory has no day cap but is a
// keyset cursor running newest-first, so reaching an arbitrary week means
// paging everything in between — and it excludes SCHEDULED and LIVE entirely,
// which is most of what a calendar is for.
//
// A calendar asks a third question — "what falls between these two instants" —
// and it is naturally bounded by the window itself rather than by a cursor, so
// this is one page and no cursor. The window is what bounds the cost; the row
// cap below only stops a pathological one.
const (
	// MaxCallRangeDays is the widest window a single read will serve. A month
	// grid spans at most six weeks, so a quarter is generous headroom while
	// still refusing a request for a decade.
	MaxCallRangeDays = 92
	// MaxCallRangePage caps the rows one window can return. Each row carries a
	// full roster (see appendCallsTx), so this is a response-size bound rather
	// than a paging scheme — a calendar week that hits it is unreadable long
	// before it is incomplete.
	MaxCallRangePage = 500
)

// callOccurrenceStart is when a call sits on a calendar, and callOccurrenceEnd
// is where its block stops.
//
// Start is the SAME expression ListMyCallHistory sorts on and the same one the
// client computes (lib/meetingTime.whenOf). They have to agree: a calendar that
// placed a meeting at a different instant than the list beside it would be two
// answers to one question.
//
// End prefers the ACTUAL end, falls back to the PLANNED end, and finally to the
// start — a call with neither is a point on the calendar, not a block, and the
// client gives it a readable minimum height rather than the server inventing a
// duration nobody chose.
//
// The overlap test below treats a call as occupying the HALF-OPEN interval
// [callOccurrenceStart, callOccurrenceEnd) — strict at both ends, symmetric
// with the window itself. A call that ends exactly on some window's `from` has
// nothing left inside that window; it belongs only to the window that actually
// contains it, the one it's the RIGHT edge of. A non-strict end check would
// count it in both: an 11pm-midnight meeting queried both in the week it ran
// and the week that begins exactly when it stops.
const (
	callOccurrenceStart = `COALESCE(c.scheduled_at, c.started_at, c.ended_at, c.created_at)`
	callOccurrenceEnd   = `COALESCE(c.ended_at, c.ends_at, c.scheduled_at, c.started_at, c.created_at)`
)

// ListMyCallsInRange returns the calls the caller is a participant of whose
// occurrence overlaps [from, to), oldest first.
//
// Overlap rather than containment, deliberately: a meeting that started at
// 23:30 on Sunday and ran into Monday belongs on both days, and a week view
// that only asked "does it START here" would drop it from the week it ran into.
//
// Includes every status. A calendar shows what happened as well as what is
// coming, and CANCELLED rows are what tell somebody the thing they remember
// booking is not happening — the client renders the distinction.
//
// "Is in" is the roster join, exactly as ListMyCalls and ListMyCallHistory do
// it, so this includes cross-org meetings the caller was invited to — the read
// path the participant RLS disjunct exists for.
func (s *Store) ListMyCallsInRange(
	ctx context.Context, orgID, callerID string, from, to time.Time,
) ([]CallDTO, error) {
	// Clamped rather than rejected, the same posture as clampCallHistoryPage:
	// the HTTP layer refuses a nonsense window with a 400 before it ever
	// becomes a query (see listMyCallsInRange), and this is the ceiling every
	// caller gets regardless of which one it is.
	if !to.After(from) {
		return []CallDTO{}, nil
	}
	if max := from.Add(MaxCallRangeDays * 24 * time.Hour); to.After(max) {
		to = max
	}

	out := []CallDTO{}
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		ids, ierr := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			JOIN call_participants p ON p.call_id = c.id AND p.user_id = $1
			WHERE `+callOccurrenceStart+` < $3
			  AND `+callOccurrenceEnd+` > $2
			ORDER BY `+callOccurrenceStart+` ASC, c.id ASC
			LIMIT $4`, callerID, from, to, MaxCallRangePage)
		if ierr != nil {
			return ierr
		}
		return appendCallsTx(ctx, tx, ids, &out)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
