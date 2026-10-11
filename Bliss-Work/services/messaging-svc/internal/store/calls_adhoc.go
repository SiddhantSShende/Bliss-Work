package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Ad-hoc calls: a 1:1 ring that grows into a conference.
//
// An ad-hoc call is a DIRECT call with no scheduled_at. Two people is a 1:1
// call; three or more is a conference call. It is the SAME row throughout — no
// new kind, no new table — and it is NOT a Meeting: it has no invite link, no
// calendar entry, no "Upcoming" or history row, and nothing that Meetings hang
// off a schedule. A DIRECT call WITH a scheduled_at is a diary entry in a chat
// and keeps every behaviour it already had.

// MaxAdhocCallParticipants caps everyone who holds a seat in an ad-hoc call at
// once, caller included. A conference is a call somebody rang, not a webinar;
// anything bigger is a Meeting (see MaxMeetingRoster) and should be scheduled
// as one. Bounds the work one request can do too: a multi-select Call writes
// the whole roster in a single transaction.
const MaxAdhocCallParticipants = 20

// ErrCallFull is an ad-hoc call over MaxAdhocCallParticipants.
var ErrCallFull = errors.New("call has reached its participant limit")

// adhocDirectSQL is the predicate "this call is ad-hoc". alias is the calls
// table's alias in the surrounding query ("" for none).
func adhocDirectSQL(alias string) string {
	if alias != "" {
		alias += "."
	}
	return `(` + alias + `kind = 'DIRECT' AND ` + alias + `scheduled_at IS NULL)`
}

// adhocConferenceSQL is "ad-hoc, and past two seats": the point at which the
// host walking out no longer takes the call with them.
func adhocConferenceSQL(alias string) string {
	prefix := alias
	if prefix != "" {
		prefix += "."
	}
	return `(` + adhocDirectSQL(alias) + ` AND
		(SELECT count(*) FROM call_participants r WHERE r.call_id = ` + prefix + `id) > 2)`
}

// IsAdhocDirect reports whether a call, as the API returns it, is ad-hoc.
func IsAdhocDirect(c *CallDTO) bool {
	return c != nil && c.Kind == CallDirect && c.ScheduledAt == nil
}

// requireAdhocRoom fails with ErrCallFull when seating inviteeID would take the
// ad-hoc call past MaxAdhocCallParticipants. Someone already seated does not
// count twice: re-adding them is how a person who dropped is rung again.
//
// Locks the call row first, so two near-simultaneous adds cannot both count the
// same headroom and together overshoot the cap.
func requireAdhocRoom(ctx context.Context, tx pgx.Tx, callID, inviteeID string) error {
	var locked string
	if err := tx.QueryRow(ctx,
		`SELECT id FROM calls WHERE id = $1 FOR UPDATE`, callID).Scan(&locked); err != nil {
		return err
	}
	var seated int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM call_participants
		WHERE call_id = $1 AND left_at IS NULL AND user_id <> $2`,
		callID, inviteeID).Scan(&seated); err != nil {
		return err
	}
	if seated+1 > MaxAdhocCallParticipants {
		return ErrCallFull
	}
	return nil
}

// adhocEndsOnLeave decides whether one person's departure closes an ad-hoc
// call SYNCHRONOUSLY, in the same transaction as their leave. Runs AFTER the
// leaver's row was closed.
//
// Two shapes, told apart by how many seats the call has ever had:
//
//   - two seats: a 1:1. The host walking out ends it, as it always has — the
//     other person has nobody to talk to and the row must not stay LIVE.
//   - three or more: a conference. A departure here NEVER ends it synchronously
//     — not even the host's, and not even when this leave is the one that
//     brings "present" to zero. See ExpireEmptyConferences for why: the only
//     thing a single LeaveCall transaction can see is an instant snapshot, and
//     a DIFFERENT participant's own join can be committing concurrently —
//     AddParticipant/CreateConferenceCall seat everyone on the roster before
//     any of them has necessarily called the token endpoint, so "present == 0"
//     immediately after one departure is the ORDINARY shape of a conference
//     mid-handoff, not evidence it is over. Ending it here raced a late
//     joiner's own in-flight request and could close a call nobody meant to
//     end. Whether a conference is REALLY empty is a question only time can
//     answer, so that question belongs to the sweeper, which re-reads a
//     settled state a few seconds later rather than deciding off one instant.
func adhocEndsOnLeave(ctx context.Context, tx pgx.Tx, orgID string, seat callerSeat, c *callRow) (bool, error) {
	if !c.lapsed && c.status != CallLive {
		return false, nil
	}
	var roster int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM call_participants WHERE call_id = $1`, c.id).Scan(&roster); err != nil {
		return false, err
	}
	return adhocShouldEnd(orgID, seat, c, roster), nil
}

// adhocShouldEnd is the rule of adhocEndsOnLeave, free of the database: a 1:1
// ends exactly the way every other call kind does (endsCallOnLeave); a
// conference (more than two seats, ever) never ends from a leave alone.
func adhocShouldEnd(orgID string, seat callerSeat, c *callRow, roster int) bool {
	if roster > 2 {
		return false
	}
	return endsCallOnLeave(orgID, seat, c)
}

// ConferenceEmptyGracePeriod is how long an ad-hoc conference may sit with
// nobody present before ExpireEmptyConferences closes it.
//
// The conference's own version of HostGracePeriod, for a different reason:
// that one tells a reload apart from a real departure; this one gives a
// participant whose join is already on the wire — AddParticipant rings them
// before their client has necessarily reached the token endpoint — time to
// land before "nobody is here" is believed. A callToken round trip is
// ordinarily well under a second; ten seconds is generous without leaving an
// empty conference open for long.
const ConferenceEmptyGracePeriod = 10 * time.Second

// ExpireEmptyConferences ends LIVE ad-hoc conferences (more than two seats —
// see adhocConferenceSQL) that have had somebody actually join at some point
// and have had nobody present for longer than the grace period.
//
// This, not LeaveCall, is what actually closes a conference once everyone has
// left it — see adhocEndsOnLeave's own doc comment for why a leave never
// decides this itself. "Had somebody join at some point" is what tells this
// apart from an invite nobody ever answered: that case has no departure to
// anchor a grace period to and is left to ExpireAbandonedCalls' much longer
// idle window — closing it here, within seconds of the call being made, would
// hang up on people who are simply slow to click Join.
//
// Concurrency-safe on the same terms as the other sweeps: SKIP LOCKED to
// claim each row, and endCallTx's own status guard so exactly one sweeper
// reports having ended any given call.
func (s *Store) ExpireEmptyConferences(
	ctx context.Context, grace time.Duration, limit int,
) ([]*CallDTO, error) {
	if limit <= 0 {
		limit = OverdueSweepLimit
	}
	if grace <= 0 {
		grace = ConferenceEmptyGracePeriod
	}
	var ended []*CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			WHERE c.status = 'LIVE'
			  AND `+adhocConferenceSQL("c")+`
			  AND EXISTS (
			      SELECT 1 FROM call_participants p
			      WHERE p.call_id = c.id AND p.joined_at IS NOT NULL)
			  AND NOT EXISTS (
			      SELECT 1 FROM call_participants p
			      WHERE p.call_id = c.id AND p.joined_at IS NOT NULL AND p.left_at IS NULL)
			  AND (SELECT max(p.left_at) FROM call_participants p
			       WHERE p.call_id = c.id AND p.joined_at IS NOT NULL)
			      < now() - $1::interval
			ORDER BY c.id
			LIMIT $2
			FOR UPDATE SKIP LOCKED`, grace, limit)
		if err != nil {
			return err
		}
		for _, id := range ids {
			c, err := endCallTx(ctx, tx, id)
			if err != nil {
				return err
			}
			if c != nil {
				ended = append(ended, c)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ended, nil
}

// CreateConferenceCall opens ONE ad-hoc DIRECT call seating the caller as HOST
// and every peer as a PARTICIPANT — the multi-select "Call" action. LIVE
// immediately, like a 1:1 ring; the handler rings each peer.
//
// Every check CreateDirectCall and AddParticipant make, for every peer: same
// org, no block between the caller and a peer, and — which neither of those
// can express for a roster built in one go — no block between two peers who
// would otherwise land in the same room.
func (s *Store) CreateConferenceCall(
	ctx context.Context, orgID, callerID string, peerIDs []string, title, media string,
) (*CallDTO, error) {
	seen := make(map[string]struct{}, len(peerIDs))
	for _, p := range peerIDs {
		if p == callerID {
			return nil, ErrSelfCall
		}
		if _, dup := seen[p]; dup {
			return nil, ErrForbidden
		}
		seen[p] = struct{}{}
	}
	if len(peerIDs) == 0 {
		return nil, ErrForbidden
	}
	if len(peerIDs)+1 > MaxAdhocCallParticipants {
		return nil, ErrCallFull
	}
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		for _, p := range peerIDs {
			if err := requireSameOrgUser(ctx, tx, orgID, p); err != nil {
				return err
			}
		}
		everyone := append([]string{callerID}, peerIDs...)
		for i, u := range everyone[:len(everyone)-1] {
			blocked, err := blockedAgainstAnyTx(ctx, tx, orgID, u, everyone[i+1:])
			if err != nil {
				return err
			}
			if blocked {
				return ErrForbidden
			}
		}
		id := uuid.Must(uuid.NewV7()).String()
		now := time.Now().UTC()
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, media, created_by, started_at, status)
			VALUES ($1, $2, 'DIRECT', $3, $4, $5, $6, 'LIVE')`,
			id, orgID, title, media, callerID, now); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			VALUES ($1, $2, $3, 'HOST', $2)`, id, callerID, orgID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			SELECT $1, u, $2, 'PARTICIPANT', $3 FROM unnest($4::uuid[]) AS u`,
			id, orgID, callerID, peerIDs); err != nil {
			return err
		}
		var derr error
		out, derr = getCallTx(ctx, tx, id)
		return derr
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
