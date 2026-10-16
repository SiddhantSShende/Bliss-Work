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
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/metrics"
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
// ── Why `sid` guards this too ─────────────────────────────────────────────────
// A departure and a reconnect are told apart by TIME above, but a reconnect can
// ALSO race the webhook that reports the OLD connection's own departure: LiveKit
// webhooks are at-least-once and not guaranteed ordered, so a stale
// participant_left for a session that has already been superseded can arrive
// AFTER MarkJoinedFromSFU has already recorded the new one. Closing the row on
// identity alone in that case marks someone who is still in the call as having
// left — session_id (0030) is what lets this UPDATE tell "this really is the
// current session leaving" from "this is an old session's stale echo", the same
// way the whole file tells a reload from a departure: by checking something the
// SFU's own state has since moved past. NULL session_id (no join webhook seen
// yet for this row) matches unconditionally, so this only ever narrows
// behaviour once a session has actually been observed.
//
// Returns whether this call actually recorded a fresh departure (false when
// the row was already closed — by an explicit leave that beat the webhook
// here, or a stale echo, see below — so the caller does not notify on a
// departure that isn't new), and whether it closed a screen share. A call or
// participant this service does not recognise is reported as nothing having
// happened rather than an error: the SFU also runs rooms this deployment did
// not create, and a webhook about one of those is noise, not a failure.
//
// ── Why a fresh departure recorded here also counts as a metrics "drop" ──────
// LeaveCall and EndCall both close call_participants.left_at synchronously,
// as part of handling the client's own request, strictly before that client
// goes on to disconnect from LiveKit — so an intentional hangup's webhook
// always finds left_at already set and RowsAffected()==0 here. The only way
// this UPDATE actually closes a row is a departure nobody announced: exactly
// what metrics.CallDroppedTotal exists to count. See metrics/calls.go's
// package doc comment.
func (s *Store) MarkLeftFromSFU(ctx context.Context, callID, userID, sid string) (bool, bool, error) {
	var (
		recorded   bool
		wasSharing bool
		kind       string
	)
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// Read once, before the UPDATE: a call this deployment does not
		// recognise (see the doc comment above) has no row to read either, and
		// erroring out here — rather than falling through with an empty kind —
		// keeps that case identical to today's "nothing happened", not a
		// mislabeled metric.
		kerr := tx.QueryRow(ctx, `SELECT kind FROM calls WHERE id = $1`, callID).Scan(&kind)
		if errors.Is(kerr, pgx.ErrNoRows) {
			return nil
		}
		if kerr != nil {
			return kerr
		}
		// $3 = '' matches unconditionally too, alongside a NULL row: every real
		// LiveKit participant event carries a sid, so an empty one here means
		// the caller genuinely has none to give (a malformed payload, or a
		// pre-0030 code path) — falling back to identity-only matching is the
		// pre-fix behaviour, not a new hole, and is safer than dropping a real
		// departure because we cannot name the session that made it.
		ct, err := tx.Exec(ctx, `
			UPDATE call_participants SET left_at = now(), waiting_since = NULL
			WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL
			  AND (session_id IS NULL OR $3 = '' OR session_id = $3)`, callID, userID, sid)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			// Not on this roster, their own leave request already landed, or
			// (see above) this is a stale echo for a session a newer one has
			// since replaced. Either way there is nothing to record.
			return nil
		}
		recorded = true
		wasSharing, err = stopSharesTx(ctx, tx, callID, &userID)
		return err
	})
	if err != nil {
		return false, false, err
	}
	if recorded {
		metrics.CallDroppedTotal.WithLabelValues(metrics.CallTypeFor(kind)).Inc()
	}
	return recorded, wasSharing, nil
}

// MarkJoinedFromSFU records which SFU connection is now current for a
// participant, so a later stale participant_left for the connection it
// replaces can be recognised as stale rather than closing the roster row out
// from under whoever is actually still in the call.
//
// Deliberately separate from MarkJoined (calls.go): that one is the CLIENT's
// own "I connected" request and drives attendance (joined_at, waiting_since);
// this one is the SFU's report of a NEW connection and drives only
// session_id — the two can arrive in either order relative to each other,
// and this one has no opinion about attendance at all. A call or participant
// this service does not recognise is reported as nothing having happened,
// matching MarkLeftFromSFU: the SFU also runs rooms this deployment did not
// create.
func (s *Store) MarkJoinedFromSFU(ctx context.Context, callID, userID, sid string) error {
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		var (
			oldSID *string
			kind   string
		)
		selErr := tx.QueryRow(ctx, `
			SELECT cp.session_id, c.kind
			FROM call_participants cp
			JOIN calls c ON c.id = cp.call_id
			WHERE cp.call_id = $1 AND cp.user_id = $2`, callID, userID).
			Scan(&oldSID, &kind)
		if errors.Is(selErr, pgx.ErrNoRows) {
			return nil
		}
		if selErr != nil {
			return selErr
		}
		if _, err := tx.Exec(ctx, `
			UPDATE call_participants SET session_id = $3
			WHERE call_id = $1 AND user_id = $2`, callID, userID, sid); err != nil {
			return err
		}
		// Newly connected iff the SFU session id actually CHANGED. left_at is
		// NOT usable for this — MarkJoined (calls.go) clears it the instant the
		// client REQUESTS a token, before this webhook confirms the SFU
		// connection actually succeeded, so left_at is already NULL again by
		// the time a genuine rejoin's webhook lands here; an earlier version
		// of this function keyed off left_at and undercounted rejoins for
		// exactly that reason. The session id has no such race: it is written
		// ONLY here, so identical consecutive values mean a duplicate delivery
		// of the same webhook (LiveKit's delivery is at-least-once) or the
		// same session's own re-announcement, and a changed value — including
		// from NULL — always means a new SFU connection actually formed. See
		// metrics/calls.go's package doc comment for why this, not callToken
		// returning 200, is what "connected" means.
		isNewConnection := oldSID == nil || *oldSID != sid
		if isNewConnection {
			metrics.CallConnectedTotal.WithLabelValues(metrics.CallTypeFor(kind)).Inc()
		}
		return nil
	})
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

// ── What "over" means, in one place ──────────────────────────────────────────
//
// A call is over when its status says so (ENDED, CANCELLED) OR when it is still
// SCHEDULED/LIVE but its own record says it finished: `ended_at` is set, or it
// has run past `ends_at`. The clock half is the sweeper's rule
// (ExpireOverdueCalls), and the sweeper only runs every callSweepInterval
// on replicas that may be down, deploying, or behind — so for as long as it has
// not got round to a row, that row is over in fact and LIVE in the table.
//
// Every READ therefore asks the same question the sweeper does, through the two
// helpers below, rather than trusting the status column alone. The sweeper stays
// the only WRITER: it alone moves the row, closes the roster, revokes the links
// and tells the room. Reads just refuse to report a call as open that the clock
// has already closed — which is what keeps a lapsed call out of "Live" and out
// of the token endpoint for the seconds (or, with a sweeper outage, hours)
// before the row catches up. A repeating meeting is untouched: each occurrence
// is its own row with its own ends_at, so only the past one lapses.

// lapsedSQL is the predicate "open in the table, but finished": an ended_at
// that was recorded without the status following (nothing in this service
// writes that, which is why it is checked rather than assumed), or a scheduled
// end that has passed. alias is the calls table's alias in the surrounding
// query ("" for none).
func lapsedSQL(alias string) string {
	if alias != "" {
		alias += "."
	}
	return `(` + alias + `status IN ('SCHEDULED', 'LIVE') AND (` + alias + `ended_at IS NOT NULL OR (` +
		alias + `ends_at IS NOT NULL AND ` + alias + `ends_at <= now())))`
}

// effectiveStatusSQL and effectiveEndedAtSQL are the status and ended_at a
// reader should be told: the stored values, except for a lapsed call, which is
// ENDED as of its recorded end (or, failing that, its scheduled one).
func effectiveStatusSQL(alias string) string {
	col := "status"
	if alias != "" {
		col = alias + ".status"
	}
	return `(CASE WHEN ` + lapsedSQL(alias) + ` THEN 'ENDED' ELSE ` + col + ` END)`
}

func effectiveEndedAtSQL(alias string) string {
	p := ""
	if alias != "" {
		p = alias + "."
	}
	return `(CASE WHEN ` + lapsedSQL(alias) + ` THEN COALESCE(` + p + `ended_at, ` + p + `ends_at) ELSE ` + p + `ended_at END)`
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
// Ten seconds. It started at two minutes, matching the SFU's own
// `empty_timeout`, and was cut deliberately (commit 5dc5dfd, "the
// host-disconnect grace period drops to 10s so hostless rooms close promptly")
// because the cost of the two mistakes is not symmetric here: a host who
// reloads and comes back walks into a call they can restart in one click, while
// a hostless room left standing shows a meeting as LIVE and everybody who was
// in it as busy, to colleagues who act on that.
//
// It is a floor on the delay, not the whole of it. The sweeper is a
// callSweepInterval ticker, so the real worst case before an abandoned call
// closes is this plus one interval — about forty seconds today. Cutting this
// alone below the interval buys nothing; the interval is the other half.
//
// A ceiling rather than the usual case either way: pressing Leave still ends
// the call at once (LeaveCall), and this only covers departures nobody
// announced.
const HostGracePeriod = 10 * time.Second

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
			  -- A conference outlives its host: it is only hostless while nobody
			  -- else is in it. (A 1:1 keeps the old rule.)
			  AND NOT (`+adhocConferenceSQL("c")+` AND EXISTS (
			      SELECT 1 FROM call_participants p
			      WHERE p.call_id = c.id AND p.role <> 'HOST'
			        AND p.joined_at IS NOT NULL AND p.left_at IS NULL))
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

// AbandonedCallAfter is how long a LIVE call with no scheduled end may sit with
// nobody connected before the sweeper closes it.
//
// This is the one case the clock cannot close: a call that named no end time
// ("No end time", or a "meet now" nobody joined) has no ends_at for
// ExpireOverdueCalls to reach, and ExpireHostlessCalls requires that a host
// actually joined. A scheduled call the sweeper opens at its start time that
// nobody ever turns up to has no SFU room either, so there is no room_finished
// webhook to end it — it stayed LIVE, in everyone's Live list, indefinitely.
//
// Deliberately long. Ending a meeting under someone who is merely late is the
// worse mistake; twelve hours of nobody being connected is not "late".
const AbandonedCallAfter = 12 * time.Hour

// ExpireAbandonedCalls ends LIVE calls that have no scheduled end, have nobody
// connected, and have had no activity (start, join or leave) for longer than
// the given period — and, regardless of age, any open call whose own record
// already says it ended (ended_at set; reads already report it as over, see
// lapsedSQL, and this makes the row agree). Returns the calls this pass ended.
//
// Concurrency-safe on the same terms as ExpireOverdueCalls: SKIP LOCKED to
// claim and endCallTx's status guard so exactly one sweeper reports each call.
func (s *Store) ExpireAbandonedCalls(
	ctx context.Context, idle time.Duration, limit int,
) ([]*CallDTO, error) {
	if limit <= 0 {
		limit = OverdueSweepLimit
	}
	if idle <= 0 {
		idle = AbandonedCallAfter
	}
	var ended []*CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			WHERE c.status IN ('SCHEDULED', 'LIVE')
			  AND (c.ended_at IS NOT NULL OR (
			      c.status = 'LIVE'
			      AND c.ends_at IS NULL
			      AND NOT EXISTS (
			          SELECT 1 FROM call_participants p
			          WHERE p.call_id = c.id AND p.joined_at IS NOT NULL AND p.left_at IS NULL)
			      AND GREATEST(c.started_at, c.scheduled_at, c.created_at,
			          (SELECT max(GREATEST(p.joined_at, p.left_at))
			             FROM call_participants p WHERE p.call_id = c.id))
			          < now() - $1::interval))
			ORDER BY c.id
			LIMIT $2
			FOR UPDATE OF c SKIP LOCKED`, idle, limit)
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

// DueSweepLimit bounds one pass of the auto-start sweep — same reasoning as
// OverdueSweepLimit: small on purpose, so a backlog drains over several ticks
// rather than in one burst competing with live traffic.
const DueSweepLimit = 50

// ActivateDueCalls starts every SCHEDULED call whose scheduled start has
// arrived, admitting anyone already waiting in its lobby, and returns the ones
// this pass actually started.
//
// Shares its SCHEDULED -> LIVE transition with StartCall (calls_lobby.go) via
// activateCallRowTx, so a call the CLOCK starts looks, to every client,
// identical to one a host started by hand. started_by is left nil — the same
// "nobody did this, the clock did" convention endCallTx's callers already use
// for actorID when a call ends by itself.
//
// SAFE TO RUN ON EVERY REPLICA CONCURRENTLY, on the same terms as
// ExpireOverdueCalls: FOR UPDATE SKIP LOCKED claims each row exclusively, and
// the UPDATE's own `status = 'SCHEDULED'` guard means only the sweeper that
// actually claimed a row reports having started it.
func (s *Store) ActivateDueCalls(ctx context.Context, limit int) ([]*CallDTO, error) {
	if limit <= 0 {
		limit = DueSweepLimit
	}
	var started []*CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT id FROM calls
			WHERE status = 'SCHEDULED'
			  AND scheduled_at IS NOT NULL
			  AND scheduled_at <= now()
			ORDER BY scheduled_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED`, limit)
		if err != nil {
			return err
		}
		for _, id := range ids {
			c, err := activateCallTx(ctx, tx, id)
			if err != nil {
				return err
			}
			if c != nil {
				started = append(started, c)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return started, nil
}

// activateCallTx opens a SCHEDULED call inside an existing transaction and
// returns it as it is AFTER starting, or nil if somebody else already did (the
// UPDATE's own status guard reports zero rows affected).
//
// The batched, no-caller counterpart to StartCall's single-call transition —
// both share activateCallRowTx's UPDATE and lobby clear, with no
// canStartCallTx check here because there is no caller to authorise: this
// only ever runs from ActivateDueCalls, over a row the sweep itself already
// claimed with FOR UPDATE SKIP LOCKED.
func activateCallTx(ctx context.Context, tx pgx.Tx, callID string) (*CallDTO, error) {
	started, _, err := activateCallRowTx(ctx, tx, callID, nil)
	if err != nil {
		return nil, err
	}
	if !started {
		return nil, nil
	}
	return getCallTx(ctx, tx, callID)
}

// RingExpirySweepLimit bounds one pass of the ring-expiry sweep — same
// reasoning as OverdueSweepLimit.
const RingExpirySweepLimit = 50

// ExpiredRing is one ring the sweep resolved as unanswered — see
// ExpireRingingInvitations.
type ExpiredRing struct {
	CallID string
	// InviterID is who issued THIS ring (call_participants.invited_by) — the
	// one person told "they did not answer", never the whole roster: see
	// events.TypeCallNoAnswer's doc comment.
	InviterID string
	// InviteeID is who was rung and did not answer.
	InviteeID string
	// Ended is the call as it is AFTER ending, set only when this was the
	// call's only ring and nobody else had ever answered it — see this
	// function's own doc comment. Nil when the call keeps going for whoever
	// else is already in it.
	Ended *CallDTO
}

// ExpireRingingInvitations resolves every ring whose deadline has passed
// without an answer.
//
// Each expired ring is judged on its own, by what the REST of the roster has
// done, not by who issued it:
//
//   - If no PARTICIPANT other than the one who just timed out has EVER
//     joined this call, there is nobody in it to leave the caller talking
//     to, so the call ends — a 1:1 nobody answered, or the last unanswered
//     seat of a multi-select "Call" where none of them picked up. The HOST's
//     own seat does not count here: in the unified call room the caller
//     always joins immediately, and their doing so must never, by itself,
//     be mistaken for the invitee having answered.
//   - If some OTHER participant has already joined — this invitation was an
//     ADDITION to a call already under way (AddParticipant, see store/
//     calls_adhoc.go's doc comment) — only IT expires. The call is left
//     exactly as it was, for the same reason ExpireEmptyConferences does not
//     end a conference off one departure: everyone else's presence is
//     unaffected by one invitation nobody answered.
//
// When a ring's expiry DOES end the call, every other still-pending
// invitation on it is cleared (ring_expires_at, with no missed_at — they did
// not miss a call that was still going, it simply stopped being answerable)
// rather than left to be claimed, fruitlessly, by every sweep tick from now
// until ExpireAbandonedCalls would eventually have reached them anyway.
//
// Concurrency-safe on the same terms as the sweeps above: FOR UPDATE SKIP
// LOCKED claims each row, and the resolving UPDATE's own guard (joined_at,
// left_at, declined_at and missed_at all still NULL) means a join or decline
// that lands first — even one blocked behind this very lock until it
// releases — wins outright. See ClaimCallSession's and MarkJoined's own
// missed_at guard for the other half of that race: an answer that arrives
// after this sweep already claimed the row finds missed_at already set and
// is refused, which is what makes a late join rejected safely rather than
// racing to decide which mistake survives.
func (s *Store) ExpireRingingInvitations(ctx context.Context, limit int) ([]ExpiredRing, error) {
	if limit <= 0 {
		limit = RingExpirySweepLimit
	}
	var out []ExpiredRing
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT cp.call_id, cp.user_id, cp.invited_by
			FROM call_participants cp
			JOIN calls c ON c.id = cp.call_id
			WHERE c.status = 'LIVE'
			  AND cp.ring_expires_at IS NOT NULL
			  AND cp.ring_expires_at <= now()
			  AND cp.joined_at IS NULL
			  AND cp.left_at IS NULL
			  AND cp.declined_at IS NULL
			ORDER BY cp.call_id, cp.user_id
			LIMIT $1
			FOR UPDATE OF cp SKIP LOCKED`, limit)
		if err != nil {
			return err
		}
		type ringClaim struct{ callID, userID, invitedBy string }
		var claims []ringClaim
		for rows.Next() {
			var c ringClaim
			if serr := rows.Scan(&c.callID, &c.userID, &c.invitedBy); serr != nil {
				rows.Close()
				return serr
			}
			claims = append(claims, c)
		}
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}
		rows.Close()

		for _, c := range claims {
			ct, err := tx.Exec(ctx, `
				UPDATE call_participants
				SET missed_at = now(), ring_expires_at = NULL
				WHERE call_id = $1 AND user_id = $2
				  AND joined_at IS NULL AND left_at IS NULL
				  AND declined_at IS NULL AND missed_at IS NULL`,
				c.callID, c.userID)
			if err != nil {
				return err
			}
			if ct.RowsAffected() == 0 {
				continue // answered, declined, or already resolved since the claim above
			}
			var othersJoined bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM call_participants
					WHERE call_id = $1 AND user_id <> $2
					  AND role <> 'HOST' AND joined_at IS NOT NULL)`,
				c.callID, c.userID).Scan(&othersJoined); err != nil {
				return err
			}
			exp := ExpiredRing{CallID: c.callID, InviterID: c.invitedBy, InviteeID: c.userID}
			if !othersJoined {
				ended, err := endCallTx(ctx, tx, c.callID)
				if err != nil {
					return err
				}
				exp.Ended = ended
				if ended != nil {
					if _, err := tx.Exec(ctx, `
						UPDATE call_participants
						SET ring_expires_at = NULL
						WHERE call_id = $1 AND user_id <> $2
						  AND joined_at IS NULL AND left_at IS NULL
						  AND declined_at IS NULL AND missed_at IS NULL`,
						c.callID, c.userID); err != nil {
						return err
					}
				}
			}
			out = append(out, exp)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
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
