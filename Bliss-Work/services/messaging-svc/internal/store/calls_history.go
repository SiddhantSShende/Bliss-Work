package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// The meetings history: every call the caller was in that is over, paged.
//
// ── Why this is not ListMyCalls with a bigger limit ──────────────────────────
// ListMyCalls answers "what am I expected at", and it answers it in one shot:
// one page, capped at 100 rows, and — crucially — capped at MyCallsHistoryDays
// of finished calls. Both caps are right for that question. Neither is right
// for "show me everything I have ever been in": the day cap silently ends the
// list at a month with no indication there is more behind it, and a single
// unbounded page of a year of meetings is a query whose cost grows with the
// user's tenure.
//
// So the Past list gets its own read, with a keyset cursor and no day cap, and
// ListMyCalls is left exactly as it was — Upcoming and Live are bounded by
// what is actually on a calendar, and the page that serves them still works.

// CallPageDTO is a page of calls plus the cursor that continues it. NextCursor
// is nil when this is the last page — which is what the client's "load more"
// keys off, rather than guessing from a short page.
type CallPageDTO struct {
	Items      []CallDTO `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

// Page bounds for the history read. Smaller default than a message page: each
// row carries a full roster, so fifty calls is already a large response.
const (
	DefaultCallHistoryPage = 25
	MaxCallHistoryPage     = 100
)

func clampCallHistoryPage(n int) int {
	if n <= 0 {
		return DefaultCallHistoryPage
	}
	if n > MaxCallHistoryPage {
		return MaxCallHistoryPage
	}
	return n
}

// ListMyCallHistory returns the finished calls the caller was in, newest first.
//
// "Was in" is the roster join, exactly as ListMyCalls does it, so this includes
// cross-org meetings they were invited to — the read path the participant RLS
// disjunct exists for.
//
// The sort key is COALESCE(scheduled_at, started_at, ended_at, created_at),
// which is the same "when did this meeting happen" the client computes
// (lib/meetingTime.whenOf). They have to agree: a client that sorted the page
// differently from the cursor that produced it would show rows out of order at
// every page boundary, and could hide one entirely.
func (s *Store) ListMyCallHistory(
	ctx context.Context, orgID, callerID, cursor string, limit int,
) (*CallPageDTO, error) {
	limit = clampCallHistoryPage(limit)
	curAt, curID, err := decodeTranscriptCursor(cursor)
	if err != nil {
		return nil, ErrForbidden
	}
	// First page: an upper bound nothing can exceed, for the same reason
	// decodeInboxCursor returns now+1s — the `$2 = ''` guard already makes the
	// comparison a no-op, but Postgres does not promise to short-circuit it.
	if cursor == "" {
		curAt = time.Now().UTC().Add(24 * time.Hour)
		curID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
	}

	out := &CallPageDTO{Items: []CallDTO{}}
	err = s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		// Plus one to detect another page. Ordered and keyed on the same
		// (when, id) tuple so a boundary can neither repeat nor skip a meeting.
		ids, ierr := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			JOIN call_participants p ON p.call_id = c.id AND p.user_id = $1
			WHERE c.status IN ('ENDED', 'CANCELLED')
			  AND ($2 = ''
			       OR COALESCE(c.scheduled_at, c.started_at, c.ended_at, c.created_at) < $3
			       OR (COALESCE(c.scheduled_at, c.started_at, c.ended_at, c.created_at) = $3
			           AND c.id < $4))
			ORDER BY COALESCE(c.scheduled_at, c.started_at, c.ended_at, c.created_at) DESC,
			         c.id DESC
			LIMIT $5`, callerID, cursor, curAt, curID, limit+1)
		if ierr != nil {
			return ierr
		}
		more := len(ids) > limit
		if more {
			ids = ids[:limit]
		}
		if aerr := appendCallsTx(ctx, tx, ids, &out.Items); aerr != nil {
			return aerr
		}
		if more && len(out.Items) > 0 {
			last := out.Items[len(out.Items)-1]
			c := encodeTranscriptCursor(historySortKey(last), last.ID)
			out.NextCursor = &c
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// historySortKey re-derives the SQL sort expression from the hydrated row, so
// the cursor points at exactly the tuple the next page's WHERE compares
// against. Reading it back off the DTO rather than selecting it alongside the
// id keeps appendCallsTx — which is shared with ListMyCalls — untouched.
//
// The DTO's timestamps are already UTC ISO strings with millisecond precision,
// which is what the column holds and what RFC3339Nano round-trips.
func historySortKey(c CallDTO) string {
	for _, t := range []*string{c.ScheduledAt, c.StartedAt, c.EndedAt} {
		if t != nil && *t != "" {
			return *t
		}
	}
	return c.CreatedAt
}
