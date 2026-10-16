package store

// The waiting room.
//
// A scheduled call has two distinct moments that used to be one: the time it was
// put in the calendar, and the time somebody actually opened it. Collapsing them
// meant the earliest arrival started the meeting — join a call five minutes
// early and it is, as far as everyone else's client is concerned, in progress.
//
// So arriving and starting are now separate acts with separate authority:
//
//	ARRIVING  anyone on the roster may do it, at any time. If the call has not
//	          started they are parked (call_participants.waiting_since) and
//	          AuthorizeCallAccess returns Waiting instead of a grant. No room
//	          token exists for them yet, which is what actually keeps them out —
//	          the lobby is not a screen the client is trusted to show.
//	STARTING  only the people canStartCallTx names below. It flips the call LIVE
//	          and empties the lobby in ONE statement, so everyone waiting is
//	          admitted together.
//
// ── What this deliberately is not ────────────────────────────────────────────
// There is no admit, no deny, no per-person decision anywhere in this file. A
// host does not review the lobby and let people through one at a time; starting
// the call lets in everybody at once, and anyone arriving afterwards walks
// straight in. The rule being implemented is "members cannot join BEFORE the
// host", not "members join subject to the host's approval" — those need very
// different code, and this is the cheaper and less annoying of the two.

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// canStartCallTx reports whether this caller may open a scheduled call.
//
// Three ways in, and they are the same three for every kind of call:
//
//   - HOST on the call. That is whoever scheduled it — ScheduleChannelCall,
//     ScheduleMeeting and CreateDirectCall all seat their creator as HOST — plus
//     anyone they have since made one.
//   - org_admin, IF the call belongs to their org. The org qualifier is what
//     stops an admin of org B, invited to org A's meeting by link, from starting
//     someone else's call: admin over your own workspace is not admin over the
//     workspace that invited you.
//   - owner or admin of the channel, for a CHANNEL call. A channel call belongs
//     to the channel more than to the person who happened to schedule it, so the
//     people who run the channel can start it if the organiser is late.
//
// Note what is NOT here: being a mere participant, however early you arrived,
// and being the only person present. Neither confers the right to start.
// `role` is the caller's role on the roster, or "" if they are not on it —
// which is a reachable state rather than a refusal: a channel admin who was
// never added to the call, or an org admin, can both legitimately start one.
//
// It is PASSED IN rather than looked up. Every caller has already read this
// exact row to decide whether the person belongs in the call at all, and
// re-reading it made the waiting-room poll — which runs every few seconds for
// every person sitting in a lobby — pay for the same query twice.
func canStartCallTx(
	ctx context.Context, tx pgx.Tx, orgID, userID, role string, claimRoles []string, c *callRow,
) (bool, error) {
	if role == RoleHost {
		return true, nil
	}

	// Both remaining routes are powers over the HOSTING org's resources, so
	// neither applies to a caller looking in from another org.
	if c.orgID != orgID {
		return false, nil
	}
	if isOrgAdmin(claimRoles) {
		return true, nil
	}
	if c.kind == CallChannel && c.channelID != nil {
		chRole, err := channelRole(ctx, tx, *c.channelID, userID)
		if err != nil {
			return false, err
		}
		if chRole == RoleOwner || chRole == RoleAdmin {
			return true, nil
		}
	}
	return false, nil
}

// clearLobbyTx empties a call's waiting room and reports who was in it.
//
// Runs with app.bypass_rls flipped on for the one statement, because the people
// in the lobby are not all visible to the person letting them in: a cross-org
// guest's participant row belongs to their own org, so a host clearing the
// lobby under their own RLS would clear their colleagues and silently skip the
// external guests. That left a guest showing as "waiting" in a call that had
// already started — harmless while nobody could see their row, and wrong the
// moment the roster read was widened (see rostersTx).
//
// The widening is safe for the same reasons it is there: the statement can only
// touch ONE call, the caller has already been authorised for the act this is
// part of (starting the call, or ending it), and the only column it writes is
// the lobby mark. It is not a way to add anyone to anything.
//
// Callers must have decided the caller may do this BEFORE calling — nothing
// here re-checks it.
func clearLobbyTx(ctx context.Context, tx pgx.Tx, callID string) ([]string, error) {
	prev, err := beginBypassGUC(ctx, tx)
	if err != nil {
		return nil, err
	}
	admitted, uerr := callIDsTx(ctx, tx, `
		UPDATE call_participants SET waiting_since = NULL
		WHERE call_id = $1 AND waiting_since IS NOT NULL
		RETURNING user_id`, callID)
	// Back to what it WAS. endCallTx calls this from BOTH shapes of transaction
	// — a host's own (bypass off) and the sweeper's (bypass on) — and hard-
	// setting 'off' here is what stopped the sweeper ever ending a call. See
	// beginBypassGUC.
	serr := restoreBypassGUC(ctx, tx, prev)
	if uerr != nil {
		return nil, uerr
	}
	if serr != nil {
		return nil, serr
	}
	return admitted, nil
}

// activateCallRowTx flips a SCHEDULED call to LIVE and empties its lobby —
// the shared half of StartCall (a human starting it) and activateCallTx (the
// clock starting it, calls_lifecycle.go), guarded the same way both callers
// need: only the caller that actually flips the row (status = 'SCHEDULED')
// gets started=true, so two hosts racing each other, or the sweeper catching
// up with a host who just started it by hand, cannot double-report it.
//
// startedBy is nil for the clock, the starting caller's id for a human — the
// same "nobody did this, the clock did" convention endCallTx's callers
// already use for actorID. A SCHEDULED row's started_by is always NULL
// already (this UPDATE is the only writer of that column, and the guard
// means it only ever runs once per call), so setting it to nil here is not
// distinguishable from activateCallTx's previous "leave it alone".
func activateCallRowTx(
	ctx context.Context, tx pgx.Tx, callID string, startedBy *string,
) (started bool, admitted []string, rung []string, err error) {
	ct, err := tx.Exec(ctx, `
		UPDATE calls
		SET status = 'LIVE', started_at = COALESCE(started_at, now()), started_by = $2
		WHERE id = $1 AND status = 'SCHEDULED'`, callID, startedBy)
	if err != nil {
		return false, nil, nil, err
	}
	if ct.RowsAffected() == 0 {
		return false, nil, nil, nil
	}
	// Empty the lobby in one statement. This is the whole admission step —
	// there is no second pass deciding which of them to let through, which is
	// why it can be unconditional over the call.
	admitted, err = clearLobbyTx(ctx, tx, callID)
	if err != nil {
		return false, nil, nil, err
	}
	// Ring every invitee who has not yet joined, declined, or missed a
	// previous ring — the same deadline an ad-hoc call's own peers get at
	// creation (DirectRingTimeout), given here instead at the moment a
	// MEETING/CHANNEL call's own invite becomes answerable. The HOST is
	// excluded: the caller always has their own seat and must never be rung
	// for a meeting they are the one starting.
	rows, err := tx.Query(ctx, `
		UPDATE call_participants
		SET ring_expires_at = now() + $2::interval
		WHERE call_id = $1 AND role <> 'HOST'
		  AND joined_at IS NULL AND left_at IS NULL
		  AND declined_at IS NULL AND missed_at IS NULL
		RETURNING user_id`, callID, DirectRingTimeout)
	if err != nil {
		return false, nil, nil, err
	}
	for rows.Next() {
		var uid string
		if serr := rows.Scan(&uid); serr != nil {
			rows.Close()
			return false, nil, nil, serr
		}
		rung = append(rung, uid)
	}
	if rerr := rows.Err(); rerr != nil {
		return false, nil, nil, rerr
	}
	rows.Close()
	return true, admitted, rung, nil
}

// StartCall opens a scheduled call and admits everyone waiting for it.
//
// Idempotent: starting a call that is already LIVE returns it unchanged rather
// than failing. Two hosts pressing the button at the same moment, or one host
// pressing it twice because the first response was slow, is not an error worth
// surfacing — and the UPDATE is guarded on status = 'SCHEDULED' so the second
// one cannot rewrite started_at or steal credit for starting it.
//
// Returns the call and the ids of everyone whose lobby mark was cleared —
// including the external guests of a cross-org meeting, which is why the clear
// runs through clearLobbyTx rather than as a plain UPDATE under the starter's
// own RLS.
//
// What actually admits people is the call being LIVE, which this makes true for
// everyone at once. The list is used for logging, and deliberately not to decide
// who gets told: the fan-out goes to the whole roster, so a client that arrives
// between the UPDATE and the notification is not left behind.
func (s *Store) StartCall(
	ctx context.Context, orgID, callerID, callID string, claimRoles []string,
) (*CallDTO, []string, []string, error) {
	var (
		out      *CallDTO
		admitted []string
		rung     []string
	)
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		c, seat, err := getCallAndSeatTx(ctx, tx, callID, callerID)
		if err != nil {
			return err
		}
		if c.status == CallEnded || c.status == CallCancelled {
			return ErrCallEnded
		}
		ok, err := canStartCallTx(ctx, tx, orgID, callerID, seat.role, claimRoles, c)
		if err != nil {
			return err
		}
		if !ok {
			return ErrForbidden
		}
		if c.status == CallScheduled {
			_, admitted, rung, err = activateCallRowTx(ctx, tx, callID, &callerID)
			if err != nil {
				return err
			}
		}
		out, err = getCallTx(ctx, tx, callID)
		return err
	})
	if err != nil {
		return nil, nil, nil, err
	}
	return out, admitted, rung, nil
}

// CallStarterIDs lists the people who could start this call and so are worth
// telling that somebody is waiting for them.
//
// Best-effort by construction: org admins are carried in the JWT and this
// service holds no copy of the org's role assignments (see isOrgAdmin), so an
// org admin who is not otherwise attached to the call cannot be enumerated here.
// They are not who the notification is for — the organiser is — and a missed
// courtesy ping is not worth mirroring another service's role table for.
//
// Runs under bypass: a MEETING host may be in a different org from the guest
// whose arrival triggered this, and the recipient list is computed entirely
// server-side from the call.
func (s *Store) CallStarterIDs(ctx context.Context, callID string) ([]string, error) {
	var ids []string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		ids, err = callIDsTx(ctx,
			tx, `SELECT user_id FROM call_participants WHERE call_id = $1 AND role = 'HOST'`, callID)
		if err != nil {
			return err
		}
		if c.kind == CallChannel && c.channelID != nil {
			more, err := callIDsTx(ctx, tx, `
				SELECT user_id FROM channel_members
				WHERE channel_id = $1 AND role IN ('owner', 'admin')`, *c.channelID)
			if err != nil {
				return err
			}
			ids = append(ids, more...)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return dedupeIDs(ids), nil
}

// dedupeIDs keeps the first occurrence of each id. A channel owner who is also
// the call's HOST appears in both queries above and must be told once.
func dedupeIDs(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, id := range in {
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
