package store

// Ending a call when nobody asked us to.
//
// ── The hole this closes ─────────────────────────────────────────────────────
// Every way a call could previously end was a REQUEST from a browser: a host
// pressing End (EndCall), or anybody hanging up or navigating away (LeaveCall,
// which also ends the call when the leaver is its host). Both are correct and
// both stay — but both require a client that is still running, still on a
// network, and still willing to speak.
//
// So a closed laptop, a killed tab, a crashed renderer or a dropped connection
// left `call_participants.left_at` NULL forever, and if the person it happened
// to was the HOST, the call itself stayed LIVE forever. That is not merely an
// untidy row. OnCallUserIDs derives "Busy" from precisely those two facts, so
// somebody who walked out of a meeting yesterday was still being reported to
// their colleagues as being in it — a status nobody in the product could clear,
// because the only thing that clears it is a request from a browser that is
// gone.
//
// Three sources of truth are added here, and they answer different questions:
//
//   - THE SFU (MarkLeftFromSFU / EndCallFromSFU) knows who is actually
//     connected. It has its own keepalive, so it notices a dead client within
//     seconds, and it tells us over the signed webhook that was already wired
//     up for recordings. This is what closes "they left without saying so".
//
//   - THE CLOCK (ExpireOverdueCalls) knows when the meeting was supposed to be
//     over. This is what closes "nobody ever turned up", where there is no SFU
//     room and therefore no webhook to wait for.
//
//   - TIME SINCE (ExpireHostlessCalls) is what separates an organiser who has
//     gone from one who is reconnecting. The SFU reports both identically and
//     instantly; only waiting tells them apart.
//
// Everything here runs under bypass. There is no caller to scope to: the SFU
// holds no BlissWork account, and the sweeper is a background loop with no
// request behind it. The identifiers are the server's own — a call id it wrote
// and a user id off a roster it wrote — never a value a user supplied.

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MarkLeftFromSFU records that the SFU saw a participant disconnect.
//
// The same departure LeaveCall records, arriving from the other side: LeaveCall
// is the client saying "I am going", this is the SFU saying "they have gone".
// A client that manages both is the ordinary case and costs nothing — the
// UPDATE is guarded on `left_at IS NULL`, so the second one to arrive is a
// no-op and neither event is emitted twice.
//
// ── Why this does NOT end the call when the host is the one who went ─────────
// A deliberate leave does (see endsCallOnLeave), and must: pressing Leave is an
// unambiguous statement. This is not that statement. `participant_left` fires
// the instant a connection drops, and the commonest reason a connection drops
// is that somebody RELOADED THE PAGE — so ending the call here would take a
// meeting away from everyone in it because its organiser pressed F5.
//
// The SFU cannot tell a reload from a departure, and neither can we in the
// instant we hear about it. What distinguishes them is whether the person comes
// back, which is a question only time answers — so it is answered by the
// sweeper (ExpireHostlessCalls) a grace period later, where a host who
// reconnects has simply cleared the condition.
//
// Returns whether the departure closed a screen share, so the caller knows
// whether to say so. A call or participant this service does not recognise is
// reported as nothing having happened rather than an error: the SFU also runs
// rooms this deployment did not create, and a webhook about one of those is
// noise, not a failure.
func (s *Store) MarkLeftFromSFU(ctx context.Context, callID, userID string) (bool, error) {
	var wasSharing bool
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE call_participants SET left_at = now(), waiting_since = NULL
			WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, callID, userID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			// Not on this roster, or their own leave request already landed.
			// Either way there is nothing to record and nothing to announce.
			return nil
		}
		wasSharing, err = stopSharesTx(ctx, tx, callID, &userID)
		return err
	})
	if err != nil {
		return false, err
	}
	return wasSharing, nil
}

// EndCallFromSFU closes a call whose room the SFU has finished with.
//
// `room_finished` fires when the last participant leaves a room, which is the
// one moment a call is definitely over regardless of who was hosting it or how
// they left. It is the backstop for the case MarkLeftFromSFU cannot cover:
// everyone drifts out of a meeting nobody was hosting — a channel call, or one
// whose host was never in it — and the row would otherwise stay LIVE with a
// roster full of people the product would go on reporting as busy.
//
// Nil means this call was already over, which is the common case: the host
// pressed End, we deleted the room, and the SFU is telling us about the room we
// just deleted. The caller announces nothing.
func (s *Store) EndCallFromSFU(ctx context.Context, callID string) (*CallDTO, error) {
	var out *CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var err error
		out, err = endCallTx(ctx, tx, callID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// OverdueSweepLimit bounds one pass of the sweeper.
//
// Small on purpose. The sweep runs on a short interval, and every call it ends
// costs a fan-out to the roster and a room deletion on the SFU — so a backlog
// is better drained over several ticks than in one burst that competes with
// live traffic. A deployment that is somehow behind by more than this catches
// up within seconds.
const OverdueSweepLimit = 50

// ExpireOverdueCalls ends every call that has run past the time it was
// scheduled to finish, and returns the ones this call actually ended.
//
// Only calls with an `ends_at`. A call that named no duration is left alone
// rather than given a default length here — guessing when a meeting somebody is
// sitting in should stop is worse than leaving it to the host, and the ones
// with nobody in them are closed by the SFU's room_finished instead.
//
// SAFE TO RUN ON EVERY REPLICA CONCURRENTLY, which matters because it is a
// plain ticker in each process with no leader election. `FOR UPDATE SKIP
// LOCKED` means two sweepers never pick the same row, and endCallTx's own
// `status IN ('SCHEDULED','LIVE')` guard means that even if they somehow did,
// only one of them reports having ended it — so the roster is told once.
func (s *Store) ExpireOverdueCalls(ctx context.Context, limit int) ([]*CallDTO, error) {
	if limit <= 0 {
		limit = OverdueSweepLimit
	}
	var ended []*CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT id FROM calls
			WHERE ends_at IS NOT NULL
			  AND ends_at <= now()
			  AND status IN ('SCHEDULED', 'LIVE')
			ORDER BY ends_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, limit)
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

// HostGracePeriod is how long a call outlives its organiser's connection before
// the sweeper closes it.
//
// This number is the difference between "the organiser left" and "the organiser
// reloaded the page". A disconnect looks identical to both for as long as it
// takes the person to come back, and every value here trades one mistake for
// the other: too short ends meetings under people who refreshed, too long
// leaves a hostless room open and its participants showing as busy.
//
// Two minutes, matching the SFU's own `empty_timeout` — a reload, a brief
// network drop and a laptop lid closing and reopening all resolve well inside
// it, and nothing in the product treats a two-minute-stale call as current. It
// is a ceiling rather than the usual case: pressing Leave still ends the call
// at once (LeaveCall), and this only covers the departures nobody announced.
const HostGracePeriod = 2 * time.Minute

// ExpireHostlessCalls ends live calls whose HOST has been disconnected for
// longer than the grace period.
//
// The delayed half of "a meeting ends when its organiser leaves". The immediate
// half is LeaveCall, which acts on a deliberate departure the moment it is
// announced; this covers the ones nobody announces — the closed laptop, the
// killed tab, the network that went away — where the only evidence is a
// participant row the SFU closed and a host who has not come back.
//
// A host who reconnects inside the grace period clears the condition simply by
// existing: rejoining sets `left_at` back to NULL (MarkJoined), so the NOT
// EXISTS below stops matching and the call is never considered again.
//
// Requires that a host actually JOINED at some point. A live call whose host
// has not turned up — one an org admin opened for them — is not hostless, it is
// waiting, and taking it down would be the opposite of what anyone wants.
//
// Concurrency-safe on the same terms as ExpireOverdueCalls: SKIP LOCKED to
// claim, and endCallTx's status guard to make sure exactly one sweeper reports
// having ended any given call.
func (s *Store) ExpireHostlessCalls(
	ctx context.Context, grace time.Duration, limit int,
) ([]*CallDTO, error) {
	if limit <= 0 {
		limit = OverdueSweepLimit
	}
	if grace <= 0 {
		grace = HostGracePeriod
	}
	var ended []*CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			WHERE c.status = 'LIVE'
			  AND EXISTS (
			      SELECT 1 FROM call_participants p
			      WHERE p.call_id = c.id AND p.role = 'HOST'
			        AND p.joined_at IS NOT NULL)
			  AND NOT EXISTS (
			      SELECT 1 FROM call_participants p
			      WHERE p.call_id = c.id AND p.role = 'HOST'
			        AND (p.left_at IS NULL OR p.left_at > now() - $1::interval))
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

// EndsAtFor computes a call's scheduled end from its start and a duration.
//
// One place rather than three, because the three scheduling endpoints must not
// disagree about what "60 minutes" means. A zero or negative duration is "no
// scheduled end", which is what an omitted field decodes to, so a caller that
// says nothing gets a call the sweeper ignores.
//
// A call with no `scheduledAt` starts NOW — that is what "meet now" means
// everywhere else in this file — so its end is measured from now, not from a
// nil start that would silently drop the duration.
func EndsAtFor(scheduledAt *time.Time, d time.Duration) *time.Time {
	if d <= 0 {
		return nil
	}
	start := time.Now().UTC()
	if scheduledAt != nil {
		start = scheduledAt.UTC()
	}
	end := start.Add(d)
	return &end
}
