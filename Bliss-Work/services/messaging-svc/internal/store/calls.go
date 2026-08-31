package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// Call kinds. See 0015_calls.sql for why these three and not one flag.
const (
	// CallDirect is the ad-hoc call between two people that already existed.
	// Any participant may pull in another member of their OWN org mid-call.
	CallDirect = "DIRECT"
	// CallChannel is scoped to a channel: the invite set IS the channel's
	// membership, so there is no link to hand out and none to revoke.
	CallChannel = "CHANNEL"
	// CallMeeting has an explicit roster and is joinable by link, including by
	// a registered user from a DIFFERENT org.
	CallMeeting = "MEETING"
)

// Call statuses.
const (
	CallScheduled = "SCHEDULED"
	CallLive      = "LIVE"
	CallEnded     = "ENDED"
	CallCancelled = "CANCELLED"
)

// Participant roles.
const (
	RoleHost        = "HOST"
	RoleParticipant = "PARTICIPANT"
)

// ErrInviteInvalid covers every reason a join link will not be honoured —
// unknown, revoked, expired, or spent. Deliberately ONE error: distinguishing
// them to the redeemer would turn the endpoint into an oracle for guessing
// tokens, and none of the distinctions help a legitimate user.
var ErrInviteInvalid = errors.New("invite link is not valid")

// ErrCallEnded is returned when a join arrives after the call is over.
var ErrCallEnded = errors.New("call has ended")

// ErrNoInviteForKind is returned when someone tries to mint a link for a call
// that is not a MEETING. Channel calls have no link BY DESIGN — you are in the
// call because you are in the channel — so this is a product rule, not a
// limitation to work around later.
var ErrNoInviteForKind = errors.New("only meetings can be joined by link")

// CallDTO is a call as the API returns it.
type CallDTO struct {
	ID          string  `json:"id"`
	OrgID       string  `json:"orgId"`
	Kind        string  `json:"kind"`
	ChannelID   *string `json:"channelId,omitempty"`
	Title       string  `json:"title"`
	Media       string  `json:"media"`
	CreatedBy   string  `json:"createdBy"`
	ScheduledAt *string `json:"scheduledAt,omitempty"`
	// EndsAt is when the call is SCHEDULED to be over, which is a different
	// fact from EndedAt — the first is a plan, the second is history. Absent
	// on a call that named no duration; the sweeper leaves those alone.
	EndsAt    *string `json:"endsAt,omitempty"`
	StartedAt *string `json:"startedAt,omitempty"`
	// StartedBy is who let everyone in, which is not always who scheduled it.
	StartedBy    *string              `json:"startedBy,omitempty"`
	EndedAt      *string              `json:"endedAt,omitempty"`
	Status       string               `json:"status"`
	CreatedAt    string               `json:"createdAt"`
	Participants []CallParticipantDTO `json:"participants,omitempty"`
	// ActiveShares is what is on screen right now. Present on every read so a
	// participant who joins mid-share knows about it immediately, rather than
	// inferring it from whichever tracks happen to arrive first.
	ActiveShares []CallShareDTO `json:"activeShares"`
	// RecordingStatus is "RECORDING" while the SFU is writing a recording of
	// this call, "READY" once there is something to play, and absent when
	// neither is true.
	//
	// Two things at once, deliberately. It is what tells a PARTICIPANT they are
	// being recorded — which nobody should have to be told twice, or find out
	// afterwards — and it is what lets a list of past meetings offer playback
	// without minting a signed link per row for links nobody clicks. The link
	// itself comes from GET /calls/{id}/recording, one at a time.
	//
	// A failed recording is reported as neither: there is nothing to play and
	// nothing still running, and the operator's copy of the failure is in the
	// row, not in a participant's screen.
	RecordingStatus *string `json:"recordingStatus,omitempty"`
}

// CallParticipantDTO is one row of a call's roster.
type CallParticipantDTO struct {
	UserID   string  `json:"userId"`
	OrgID    string  `json:"orgId"`
	Role     string  `json:"role"`
	Username string  `json:"username,omitempty"`
	JoinedAt *string `json:"joinedAt,omitempty"`
	LeftAt   *string `json:"leftAt,omitempty"`
	// WaitingSince is set while this participant is held in the waiting room,
	// and cleared the moment the call starts. Non-null therefore means "here,
	// but not yet let in" — which is a different state from both "in the room"
	// (joinedAt set) and "not turned up" (both null).
	WaitingSince *string `json:"waitingSince,omitempty"`
	// External marks a participant whose org differs from the call's, which the
	// UI surfaces so nobody is surprised by who is in the room.
	External bool `json:"external"`
}

// CallShareDTO is one live screen share.
type CallShareDTO struct {
	ID     string `json:"id"`
	CallID string `json:"callId"`
	UserID string `json:"userId"`
	// Source is SCREEN, WINDOW or TAB — see ShareSource.
	Source    string `json:"source"`
	StartedAt string `json:"startedAt"`
}

// CallInviteDTO is returned ONCE, at mint time. The token is not stored and
// cannot be recovered — only its SHA-256 lives in the database, so reading the
// table does not let you join a meeting.
type CallInviteDTO struct {
	ID        string `json:"id"`
	CallID    string `json:"callId"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	MaxUses   *int   `json:"maxUses,omitempty"`
}

func tsPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000Z")
	return &s
}

// ── Scheduling ───────────────────────────────────────────────────────────────

// ScheduleChannelCall creates a CHANNEL call. The caller must be a member of
// the channel; no roster is copied, because the roster IS the channel and
// copying it would let someone who has since left keep a seat.
func (s *Store) ScheduleChannelCall(
	ctx context.Context, orgID, callerID, channelID, title, media string,
	scheduledAt, endsAt *time.Time,
) (*CallDTO, error) {
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		id := uuid.Must(uuid.NewV7()).String()
		status := CallScheduled
		if scheduledAt == nil {
			status = CallLive
		}
		var startedAt *time.Time
		if scheduledAt == nil {
			now := time.Now().UTC()
			startedAt = &now
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, channel_id, title, media,
			                   created_by, scheduled_at, ends_at, started_at, status)
			VALUES ($1, $2, 'CHANNEL', $3, $4, $5, $6, $7, $8, $9, $10)`,
			id, orgID, channelID, title, media, callerID,
			scheduledAt, endsAt, startedAt, status); err != nil {
			return err
		}
		// The organiser is a HOST from the outset so they can end the call even
		// before anyone else joins.
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			VALUES ($1, $2, $3, 'HOST', $2)`,
			id, callerID, orgID); err != nil {
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

// ScheduleMeeting creates a MEETING with an explicit roster. inviteeIDs are
// same-org users added up front; everyone else arrives by link.
func (s *Store) ScheduleMeeting(
	ctx context.Context, orgID, callerID, title, media string,
	scheduledAt, endsAt *time.Time, inviteeIDs []string,
) (*CallDTO, error) {
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		id := uuid.Must(uuid.NewV7()).String()
		status := CallScheduled
		var startedAt *time.Time
		if scheduledAt == nil {
			status = CallLive
			now := time.Now().UTC()
			startedAt = &now
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, media,
			                   created_by, scheduled_at, ends_at, started_at, status)
			VALUES ($1, $2, 'MEETING', $3, $4, $5, $6, $7, $8, $9)`,
			id, orgID, title, media, callerID,
			scheduledAt, endsAt, startedAt, status); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			VALUES ($1, $2, $3, 'HOST', $2)`,
			id, callerID, orgID); err != nil {
			return err
		}
		for _, uid := range inviteeIDs {
			if uid == callerID {
				continue
			}
			// Every invitee must really be in the caller's org, resolved from
			// user_projection exactly as AddParticipant does.
			//
			// The WITH CHECK does NOT cover this, which an earlier version of
			// this comment claimed it did. The INSERT stamps org_id with the
			// CALLER's org, so a cross-org id smuggled into inviteeIds writes a
			// row that passes the policy — it matches the caller's org — while
			// asserting that someone from another org is in this one. That row
			// is itself the grant: the calls RLS policy admits anyone holding a
			// participant row, so writing it would hand an outsider the meeting
			// without a link, which is the one thing the link path exists to
			// keep auditable.
			var invOrg string
			err := tx.QueryRow(ctx,
				`SELECT org_id FROM user_projection WHERE user_id = $1`, uid).Scan(&invOrg)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrForbidden
			}
			if err != nil {
				return err
			}
			if invOrg != orgID {
				return ErrForbidden
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
				VALUES ($1, $2, $3, 'PARTICIPANT', $4)
				ON CONFLICT (call_id, user_id) DO NOTHING`,
				id, uid, orgID, callerID); err != nil {
				return err
			}
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

// CreateDirectCall creates a DIRECT call in a one-to-one chat.
//
// Two things at once, distinguished only by scheduledAt:
//
//	nil   the ad-hoc ring that already existed, LIVE immediately, so that an
//	      in-call "add someone" has a real entity to attach a participant to.
//	set   a call scheduled in a chat, which channels and meetings could already
//	      do and chats could not. It lands SCHEDULED, which puts it behind the
//	      same waiting room as every other scheduled call: the peer who opens it
//	      early waits until whoever scheduled it starts it.
//
// The peer must belong to the caller's org. That check is not about scheduling
// — it closes a gap the ad-hoc path had too. The INSERT below stamps org_id
// with the CALLER's org for both rows, so naming a user from another org here
// would write a row claiming they are in an org they are not, and since the
// calls RLS policy grants read access to anyone holding a participant row, that
// row is itself the grant. Cross-org entry belongs on the meeting-link path,
// which is the one place it can be audited.
func (s *Store) CreateDirectCall(
	ctx context.Context, orgID, callerID, peerID, title, media string,
	scheduledAt, endsAt *time.Time,
) (*CallDTO, error) {
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		var peerOrg string
		err := tx.QueryRow(ctx,
			`SELECT org_id FROM user_projection WHERE user_id = $1`, peerID).Scan(&peerOrg)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if peerOrg != orgID {
			return ErrForbidden
		}

		id := uuid.Must(uuid.NewV7()).String()
		status := CallScheduled
		var startedAt *time.Time
		if scheduledAt == nil {
			status = CallLive
			now := time.Now().UTC()
			startedAt = &now
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO calls (id, org_id, kind, title, media, created_by,
			                   scheduled_at, ends_at, started_at, status)
			VALUES ($1, $2, 'DIRECT', $3, $4, $5, $6, $7, $8, $9)`,
			id, orgID, title, media, callerID,
			scheduledAt, endsAt, startedAt, status); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			VALUES ($1, $2, $3, 'HOST', $2), ($1, $4, $3, 'PARTICIPANT', $2)`,
			id, callerID, orgID, peerID); err != nil {
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

// ── Roster ───────────────────────────────────────────────────────────────────

// AddParticipant pulls another user into an existing call.
//
// TWO org checks, and both are load-bearing:
//   - the CALLER must belong to the call's hosting org, or a guest who redeemed
//     one meeting link could add their own colleagues; and
//   - the INVITEE must belong to that same org, or this becomes a second
//     cross-org door.
//
// With both in place, cross-org entry really does exist on exactly one path —
// redeeming a MEETING link — so there is a single place to audit. An earlier
// version of this comment asserted that guarantee while only checking the
// invitee, which made it false for MEETING calls.
func (s *Store) AddParticipant(
	ctx context.Context, orgID, callerID, callID, inviteeID string,
) error {
	return s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		if c.status == CallEnded || c.status == CallCancelled {
			return ErrCallEnded
		}
		// Only the HOSTING org may widen a call.
		//
		// Without this, a cross-org guest who redeemed ONE meeting link could
		// walk their entire organisation in: they pass the presence check below
		// (RedeemInvite leaves left_at NULL), resolve a colleague through the
		// org-isolated user_projection, and the INSERT stamps org_id = their own
		// org — which satisfies call_participants' WITH CHECK. RLS is not a
		// backstop here precisely because the row is written under the guest's
		// own org, so the check has to be explicit and it has to be here.
		if c.orgID != orgID {
			return ErrForbidden
		}
		// The caller must already be in the call. Being in the same org is not
		// enough — otherwise anyone in the org could add themselves to any call.
		var present bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM call_participants
			               WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL)`,
			callID, callerID).Scan(&present); err != nil {
			return err
		}
		if !present {
			return ErrForbidden
		}
		// The invitee must belong to the CALLER's org. user_projection is this
		// service's local mirror of who exists, so this needs no cross-service
		// call on the hot path.
		var inviteeOrg string
		err = tx.QueryRow(ctx,
			`SELECT org_id FROM user_projection WHERE user_id = $1`, inviteeID).Scan(&inviteeOrg)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if inviteeOrg != orgID {
			return ErrForbidden
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by)
			VALUES ($1, $2, $3, 'PARTICIPANT', $4)
			ON CONFLICT (call_id, user_id)
			DO UPDATE SET left_at = NULL, invited_by = EXCLUDED.invited_by`,
			callID, inviteeID, orgID, callerID)
		return err
	})
}

// MarkJoined stamps attendance, and clears the waiting-room mark if the caller
// had been held there.
//
// It deliberately does NOT start the call. It used to: the first participant to
// ask for a room token flipped a SCHEDULED call to LIVE, which meant a meeting
// began whenever its earliest arrival opened it and an organiser could walk into
// a call that had been running without them. Starting is now its own act, with
// its own authority — see StartCall in calls_lobby.go — and this only ever
// records that somebody turned up. Nothing calls it before that is allowed:
// AuthorizeCallAccess refuses a token for a call that has not started.
func (s *Store) MarkJoined(ctx context.Context, orgID, userID, callID string) error {
	return s.withCaller(ctx, orgID, userID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE call_participants
			SET joined_at = COALESCE(joined_at, now()), left_at = NULL, waiting_since = NULL
			WHERE call_id = $1 AND user_id = $2`, callID, userID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return ErrForbidden
		}
		return nil
	})
}

// LeaveCall records a departure — and ends the call when the person leaving is
// the one hosting it.
//
// A participant walking out only leaves; the call stays LIVE for everyone still
// in it. A HOST walking out ENDS it, in this same transaction: the meeting is
// theirs, and one that outlives its organiser is a room the roster can keep
// rejoining, with a live row in everyone's Meetings list, until somebody
// remembers to press End. Ending it here is also the only way it happens on the
// paths that have no button to press — closing the tab, navigating away.
//
// Deliberately HOST and not canStartCallTx's wider set. An org admin or channel
// owner MAY end a call they are attending (that is what EndCall is for), but
// their leaving must not, or an admin who drops into someone else's meeting for
// two minutes takes it down on the way out.
//
// Clearing waiting_since makes this double as "give up waiting". Someone who
// closes the tab in the lobby leaves it, and if they come back they are a fresh
// arrival — which is what re-notifies the host that they are there.
//
// Returns whether the departure also ended a screen share, and the ended call
// when this leave ended one, so the handler knows which events to emit.
func (s *Store) LeaveCall(
	ctx context.Context, orgID, userID, callID string,
) (bool, *CallDTO, error) {
	var (
		wasSharing bool
		ended      *CallDTO
	)
	err := s.withCaller(ctx, orgID, userID, func(tx pgx.Tx) error {
		// Seat and status BEFORE the leave, because both decide what this is:
		// whether the leaver hosts the call, and whether there is still a call
		// to end. Reading it after would work too, and would cost a second
		// round trip for a fact this read already carries.
		c, seat, err := getCallAndSeatTx(ctx, tx, callID, userID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE call_participants SET left_at = now(), waiting_since = NULL
			WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, callID, userID); err != nil {
			return err
		}
		// Leaving stops whatever you were sharing. Without this a share stays
		// recorded as live against a participant who is no longer in the room,
		// and every client that joins later is told about a share that ended.
		wasSharing, err = stopSharesTx(ctx, tx, callID, &userID)
		if err != nil {
			return err
		}
		if !endsCallOnLeave(orgID, seat, c) {
			return nil
		}
		ended, err = endCallTx(ctx, tx, callID)
		return err
	})
	if err != nil {
		return false, nil, err
	}
	return wasSharing, ended, nil
}

// EndCall closes a call. HOSTS ONLY.
//
// Returns the call as it is AFTER ending, which is why it returns one at all.
// The handler used to read the call first and announce that DTO, so `call.ended`
// carried status LIVE and endedAt nil — every client was told a call had ended
// by an event whose body said it was still running, and any client that trusted
// the body over the type re-rendered it as live. Reading it here also costs
// nothing extra: it happens inside the transaction that just ended the call,
// instead of a separate round trip before it.
func (s *Store) EndCall(
	ctx context.Context, orgID, callerID, callID string,
) (*CallDTO, error) {
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		// Role and hosting org in one read, because both are needed and they
		// live one join apart.
		var role, callOrg string
		err := tx.QueryRow(ctx, `
			SELECT p.role, c.org_id
			FROM call_participants p
			JOIN calls c ON c.id = p.call_id
			WHERE p.call_id = $1 AND p.user_id = $2`,
			callID, callerID).Scan(&role, &callOrg)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if role != RoleHost {
			return ErrForbidden
		}
		// Ending is a power over the HOSTING org's call. Nothing promotes a
		// cross-org guest to HOST today, so this is unreachable — but if it ever
		// became reachable the failure without this check is ugly rather than
		// safe: the UPDATE below would trip the calls WITH CHECK, which is
		// org-only, and the caller would get a 500 out of the database instead
		// of a refusal from the code that made the decision.
		if callOrg != orgID {
			return ErrForbidden
		}
		out, err = endCallTx(ctx, tx, callID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// endsCallOnLeave reports whether one person's departure closes the call.
//
// Kept separate from LeaveCall, and free of the database, because it is the
// whole rule: everything else in that function happens either way. Three
// conditions, and each one is load-bearing:
//
//   - HOST on the roster. Not canStartCallTx's wider set — an org admin or
//     channel owner may END a call they are attending, but their walking out of
//     one must not take it down with them.
//   - the HOSTING org. Ending is a power over that org's call, and nothing
//     seats a cross-org guest as HOST today; without this, if that ever changed,
//     the UPDATE would trip the calls WITH CHECK (org-only) and fail with a
//     database error instead of leaving the call alone.
//   - a call there is still something to end. A leave arriving after somebody
//     pressed End, or after the other host left, is ordinary rather than an
//     error, and simply has no call left to close.
func endsCallOnLeave(orgID string, seat callerSeat, c *callRow) bool {
	if seat.role != RoleHost || c.orgID != orgID {
		return false
	}
	return c.status == CallLive || c.status == CallScheduled
}

// endCallTx closes a call inside an existing transaction and returns it as it
// is AFTER ending. Shared by the two ways a call ends — a host pressing End
// (EndCall) and a host walking out (LeaveCall) — so the two cannot drift into
// ending a call by different amounts.
//
// Callers must have decided the caller may do this BEFORE calling; nothing
// here re-checks it.
func endCallTx(ctx context.Context, tx pgx.Tx, callID string) (*CallDTO, error) {
	ct, err := tx.Exec(ctx, `
		UPDATE calls SET status = 'ENDED', ended_at = now()
		WHERE id = $1 AND status IN ('SCHEDULED', 'LIVE')`, callID)
	if err != nil {
		return nil, err
	}
	// Somebody else got there first: two hosts leaving in the same instant, or a
	// leave racing the End button. Nil rather than the call, so the caller knows
	// it did not end it and stays quiet — the winner already revoked the links,
	// emptied the lobby, and told the roster.
	if ct.RowsAffected() == 0 {
		return nil, nil
	}
	// Revoke every outstanding link in the same transaction: a meeting that
	// has ended must not remain joinable by a link already in someone's
	// inbox.
	if _, err := tx.Exec(ctx, `
		UPDATE call_invites SET revoked_at = now()
		WHERE call_id = $1 AND revoked_at IS NULL`, callID); err != nil {
		return nil, err
	}
	// Empty the waiting room, external guests included. A call that ended
	// before it ever started would otherwise leave people parked in a lobby
	// for a meeting that is never going to begin — and leave a stale lobby
	// mark on the roster everyone can now read.
	if _, err := clearLobbyTx(ctx, tx, callID); err != nil {
		return nil, err
	}
	// CLOSE OUT THE ROSTER. Everyone still holding an open participant row is
	// recorded as having left now, because they have: the room is about to be
	// deleted on the SFU and there is nothing left to be in.
	//
	// Not cosmetic. `left_at` is only ever written by the client's own leave
	// request, so anybody whose browser was closed rather than clicked keeps an
	// open row indefinitely — and OnCallUserIDs reads exactly those rows to
	// decide who is "Busy". Without this line the ONLY thing that stopped a
	// departed participant being shown to their colleagues as still in a
	// meeting was the call leaving LIVE, which is precisely the state a call
	// with no end time never leaves.
	//
	// Same reason clearLobbyTx (above) widens app.bypass_rls: call_participants
	// carries the PARTICIPANT's own org, not the call's, so a cross-org guest's
	// row is invisible under the host's own RLS (EndCall/LeaveCall both run
	// this via s.withCaller). Without the widening, ending or leaving a
	// meeting closed out every same-org row correctly and silently left every
	// cross-org guest's row open — joinedAt set, leftAt null — on a call the
	// data already says ENDED.
	prevBypass, err := beginBypassGUC(ctx, tx)
	if err != nil {
		return nil, err
	}
	_, uerr := tx.Exec(ctx, `
		UPDATE call_participants SET left_at = now()
		WHERE call_id = $1 AND joined_at IS NOT NULL AND left_at IS NULL`,
		callID)
	// Back to what it WAS, same as clearLobbyTx — this function is also called
	// from the sweeper's already-bypassed transaction, and hard-setting 'off'
	// here would break that path the same way it would have broken clearLobbyTx.
	if serr := restoreBypassGUC(ctx, tx, prevBypass); serr != nil {
		return nil, serr
	}
	if uerr != nil {
		return nil, uerr
	}
	// Close every live share. Passing nil means "everyone's" — the one
	// place a share is stopped by someone other than the person sharing,
	// and it is the call ending rather than a participant reaching for
	// somebody else's stop button. Nothing needs telling that the shares
	// stopped: call.ended already says the room is gone.
	if _, err := stopSharesTx(ctx, tx, callID, nil); err != nil {
		return nil, err
	}
	return getCallTx(ctx, tx, callID)
}

// ── Invite links (MEETING only) ──────────────────────────────────────────────

// inviteTokenBytes is the raw entropy behind a join link. 32 bytes is well past
// the point where guessing is the attack you should worry about.
const inviteTokenBytes = 32

func hashToken(tok string) []byte {
	sum := sha256.Sum256([]byte(tok))
	return sum[:]
}

// CreateInvite mints a join link for a MEETING. Returns the token exactly once.
func (s *Store) CreateInvite(
	ctx context.Context, orgID, callerID, callID string, ttl time.Duration, maxUses *int,
) (*CallInviteDTO, error) {
	var out *CallInviteDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		if c.kind != CallMeeting {
			return ErrNoInviteForKind
		}
		if c.status == CallEnded || c.status == CallCancelled {
			return ErrCallEnded
		}
		// Only the HOSTING org mints links for its own meeting, the same rule
		// AddParticipant enforces. Today the host check below is the binding
		// one — RedeemInvite only ever writes PARTICIPANT rows, so a guest
		// cannot be a HOST — but that is an accident of how the two paths
		// happen to line up, and it would stop being true the moment anything
		// promoted a participant. Stating the org rule where the org is known
		// costs one comparison and does not depend on that coincidence holding.
		if c.orgID != orgID {
			return ErrForbidden
		}
		// Hosts only. A participant who was themselves invited by link must not
		// be able to widen the room further.
		var role string
		err = tx.QueryRow(ctx,
			`SELECT role FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, callerID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if role != RoleHost {
			return ErrForbidden
		}

		raw := make([]byte, inviteTokenBytes)
		if _, err := rand.Read(raw); err != nil {
			return err
		}
		tok := base64.RawURLEncoding.EncodeToString(raw)
		id := uuid.Must(uuid.NewV7()).String()
		expires := time.Now().UTC().Add(ttl)
		// org_id is the CALL's, not the minter's. They are equal after the check
		// above, but the invite belongs to the meeting — RedeemInvite reads it
		// back to decide who is being let into which org's room — so it is
		// written from the call row rather than from the request's claims.
		if _, err := tx.Exec(ctx, `
			INSERT INTO call_invites (id, call_id, org_id, token_hash, created_by, expires_at, max_uses)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			id, callID, c.orgID, hashToken(tok), callerID, expires, maxUses); err != nil {
			return err
		}
		out = &CallInviteDTO{
			ID:        id,
			CallID:    callID,
			Token:     tok,
			ExpiresAt: expires.Format("2006-01-02T15:04:05.000Z"),
			MaxUses:   maxUses,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RedeemInvite turns a join link into a participant row, for a user who may
// belong to ANY org.
//
// Runs under bypass, and it has to: the redeemer cannot see the call or the
// invite yet, so RLS would hide the very rows this needs to read in order to
// decide whether they are allowed. The bypass is safe because the decision is
// made ENTIRELY from the token — a value the caller possesses — and never from
// a caller-supplied org, call id or user list. Every field written is either
// derived from the invite row or is the verified JWT identity.
func (s *Store) RedeemInvite(
	ctx context.Context, joinerOrgID, joinerID, token string,
) (*CallDTO, error) {
	if token == "" {
		return nil, ErrInviteInvalid
	}
	var out *CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// Look the invite up by hash. Locked so two simultaneous redemptions of
		// a single-use link cannot both succeed.
		var (
			inviteID, callID string
			expiresAt        time.Time
			maxUses          *int
			uses             int
			revokedAt        *time.Time
			storedHash       []byte
		)
		err := tx.QueryRow(ctx, `
			SELECT id, call_id, token_hash, expires_at, max_uses, uses, revoked_at
			FROM call_invites WHERE token_hash = $1 FOR UPDATE`,
			hashToken(token)).Scan(&inviteID, &callID, &storedHash, &expiresAt, &maxUses, &uses, &revokedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInviteInvalid
		}
		if err != nil {
			return err
		}
		// Constant-time compare even though the lookup was by hash: the column
		// is UNIQUE so this can only ever confirm what the index found, and it
		// costs nothing to keep the comparison off the timing channel.
		if subtle.ConstantTimeCompare(storedHash, hashToken(token)) != 1 {
			return ErrInviteInvalid
		}
		if revokedAt != nil || time.Now().UTC().After(expiresAt) {
			return ErrInviteInvalid
		}
		if maxUses != nil && uses >= *maxUses {
			return ErrInviteInvalid
		}

		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		if c.kind != CallMeeting {
			// Defence in depth: only meetings can have invites at all, so this
			// would mean a row was written by something that skipped
			// CreateInvite.
			return ErrInviteInvalid
		}
		if c.status == CallEnded || c.status == CallCancelled {
			return ErrCallEnded
		}

		// org_id is the JOINER's own org, not the meeting's. That is the whole
		// point: it is what makes them visible to their own org's RLS and what
		// marks them External in the roster.
		var inserted bool
		if err := tx.QueryRow(ctx, `
			INSERT INTO call_participants (call_id, user_id, org_id, role, via_invite)
			VALUES ($1, $2, $3, 'PARTICIPANT', $4)
			ON CONFLICT (call_id, user_id) DO UPDATE SET left_at = NULL
			RETURNING (xmax = 0)`,
			callID, joinerID, joinerOrgID, inviteID).Scan(&inserted); err != nil {
			return err
		}
		// Only a genuinely new participant spends a use. Re-joining after a
		// dropped connection must not burn a single-use link.
		if inserted {
			if _, err := tx.Exec(ctx,
				`UPDATE call_invites SET uses = uses + 1 WHERE id = $1`, inviteID); err != nil {
				return err
			}
		}
		var derr error
		out, derr = getCallTx(ctx, tx, callID)
		return derr
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeInvite kills a link early. Hosts only.
func (s *Store) RevokeInvite(ctx context.Context, orgID, callerID, callID, inviteID string) error {
	return s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx,
			`SELECT role FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, callerID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if role != RoleHost {
			return ErrForbidden
		}
		_, err = tx.Exec(ctx,
			`UPDATE call_invites SET revoked_at = now()
			 WHERE id = $1 AND call_id = $2 AND revoked_at IS NULL`, inviteID, callID)
		return err
	})
}

// ── Reads ────────────────────────────────────────────────────────────────────

type callRow struct {
	id, orgID, kind, status string
	channelID               *string
}

func getCallRowTx(ctx context.Context, tx pgx.Tx, callID string) (*callRow, error) {
	var c callRow
	err := tx.QueryRow(ctx,
		`SELECT id, org_id, kind, status, channel_id FROM calls WHERE id = $1`, callID).
		Scan(&c.id, &c.orgID, &c.kind, &c.status, &c.channelID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// callerSeat is what one person's relationship to a call looks like.
type callerSeat struct {
	// role is their role on the roster, or "" if they are not on it. Not being
	// on the roster is a reachable state rather than an error: a CHANNEL call
	// admits any member of its channel, and an org admin has powers over a call
	// they were never invited to.
	role string
	// waiting is whether their lobby mark is already set. Knowing this up front
	// is what lets the steady-state waiting poll skip its UPDATE entirely and
	// stay a read-only transaction.
	waiting bool
}

// getCallAndSeatTx reads the call and the caller's place in it together.
//
// One round trip where there were two, and the two were always issued as a
// pair: every path that needs the call row goes on to ask what this person's
// role in it is. The waiting-room poll made that pairing expensive — it runs
// every few seconds for every person sitting in a lobby, and a five-hundred
// person meeting that has not started yet is five hundred of them.
//
// The LEFT JOIN keeps the two failure modes distinct, which a plain join would
// have merged: no row at all means the call is not visible to this caller, and
// a row with an empty role means the call is visible but they are not on its
// roster. Those lead to different places — the first is a refusal, the second
// may be an automatic enrolment.
//
// RLS applies to each table separately and is what makes this safe: the `calls`
// policy admits same-org readers and participants, and the `call_participants`
// policy admits a row for the reader themselves, so the join can only ever
// surface this caller's own seat.
func getCallAndSeatTx(
	ctx context.Context, tx pgx.Tx, callID, userID string,
) (*callRow, callerSeat, error) {
	var (
		c    callRow
		seat callerSeat
	)
	err := tx.QueryRow(ctx, `
		SELECT c.id, c.org_id, c.kind, c.status, c.channel_id,
		       COALESCE(p.role, ''), p.waiting_since IS NOT NULL
		FROM calls c
		LEFT JOIN call_participants p
		       ON p.call_id = c.id AND p.user_id = $2
		WHERE c.id = $1`, callID, userID).
		Scan(&c.id, &c.orgID, &c.kind, &c.status, &c.channelID, &seat.role, &seat.waiting)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, seat, ErrForbidden
	}
	if err != nil {
		return nil, seat, err
	}
	return &c, seat, nil
}

// rostersTx reads the rosters of calls the caller has ALREADY been shown, keyed
// by call id.
//
// ── Why this one read widens RLS ─────────────────────────────────────────────
// The call_participants policy admits a row to the reader's own ORG and to the
// reader THEMSELVES, and nothing else. That is not an oversight: the policy has
// to stay free of subqueries, because the only fact that would justify a wider
// grant — "I hold a row in this same call" — is a lookup on call_participants
// from inside call_participants' own policy, which Postgres refuses as infinite
// recursion. Routing it through `calls` recurses too, since the calls policy
// subqueries call_participants to admit exactly these guests.
//
// Left alone, a cross-org meeting has no shared roster in either direction: the
// host cannot see the guest they invited by link, and the guest sees a
// participant list containing one person, themselves. Both were true, and both
// make a nonsense of a feature whose whole point is meeting someone outside your
// organisation. CallParticipantDTO.External could never be true for anybody but
// the reader either.
//
// So the grant is made HERE, in code, where the reason for it can be read:
//
//   - every caller has already proved it may see the call. getCallTx read the
//     call row under RLS and returned ErrForbidden if it was hidden;
//     appendCallsTx is handed ids from queries that were themselves RLS-scoped.
//     A call's roster is part of the call, not a separate permission.
//   - the widening is one SELECT wide. It is bounded by the ids passed in, and
//     app.bypass_rls goes back off before this returns.
//   - and it cannot outlive the transaction even if that reset were skipped:
//     set_config(..., true) is transaction-local, so COMMIT or ROLLBACK clears
//     it. That is the same property that makes the GUCs safe behind a
//     transaction-mode pooler.
//
// The write path is deliberately NOT widened by this. Who may be ADDED to a
// call is still decided by AddParticipant and RedeemInvite, and still checked
// against RLS on the way in.
func rostersTx(
	ctx context.Context, tx pgx.Tx, ids []string,
) (map[string][]CallParticipantDTO, error) {
	out := make(map[string][]CallParticipantDTO, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	prev, err := beginBypassGUC(ctx, tx)
	if err != nil {
		return nil, err
	}
	rerr := readRosterRows(ctx, tx, ids, out)
	// Always attempt the reset, including after a failed read: a read error does
	// not necessarily abort the server-side transaction, and the statements that
	// follow this one must not inherit the bypass.
	//
	// Back to what it WAS, not to 'off'. Under withBypass the caller's whole
	// transaction is already widened, and hard-setting 'off' here silently took
	// that away from every statement after this one — see beginBypassGUC.
	serr := restoreBypassGUC(ctx, tx, prev)
	if rerr != nil {
		return nil, rerr
	}
	if serr != nil {
		return nil, serr
	}
	return out, nil
}

// readRosterRows is the query rostersTx wraps. Split out so the bypass is set
// and cleared on one path each, whatever the read does.
func readRosterRows(
	ctx context.Context, tx pgx.Tx, ids []string, into map[string][]CallParticipantDTO,
) error {
	rows, err := tx.Query(ctx, `
		SELECT p.call_id, p.user_id, p.org_id, p.role, COALESCE(up.username, ''),
		       p.joined_at, p.left_at, p.waiting_since
		FROM call_participants p
		LEFT JOIN user_projection up ON up.user_id = p.user_id
		WHERE p.call_id = ANY($1)
		ORDER BY p.call_id, p.created_at ASC`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			callID                         string
			p                              CallParticipantDTO
			joinedAt, leftAt, waitingSince *time.Time
		)
		if err := rows.Scan(&callID, &p.UserID, &p.OrgID, &p.Role, &p.Username,
			&joinedAt, &leftAt, &waitingSince); err != nil {
			return err
		}
		p.JoinedAt, p.LeftAt, p.WaitingSince = tsPtr(joinedAt), tsPtr(leftAt), tsPtr(waitingSince)
		into[callID] = append(into[callID], p)
	}
	return rows.Err()
}

// markExternal flags the participants whose org differs from the call's. Done
// after the read rather than in SQL because it is the same comparison for every
// row of one call, and the call's org is already in hand.
func markExternal(callOrgID string, roster []CallParticipantDTO) []CallParticipantDTO {
	for i := range roster {
		roster[i].External = roster[i].OrgID != callOrgID
	}
	return roster
}

func getCallTx(ctx context.Context, tx pgx.Tx, callID string) (*CallDTO, error) {
	var (
		d                                       CallDTO
		scheduledAt, endsAt, startedAt, endedAt *time.Time
		createdAt                               time.Time
	)
	err := tx.QueryRow(ctx, `
		SELECT id, org_id, kind, channel_id, title, media, created_by,
		       scheduled_at, ends_at, started_at, started_by, ended_at, status, created_at
		FROM calls WHERE id = $1`, callID).
		Scan(&d.ID, &d.OrgID, &d.Kind, &d.ChannelID, &d.Title, &d.Media, &d.CreatedBy,
			&scheduledAt, &endsAt, &startedAt, &d.StartedBy, &endedAt, &d.Status, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	d.ScheduledAt, d.StartedAt, d.EndedAt = tsPtr(scheduledAt), tsPtr(startedAt), tsPtr(endedAt)
	d.EndsAt = tsPtr(endsAt)
	d.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z")

	byCall, err := rostersTx(ctx, tx, []string{callID})
	if err != nil {
		return nil, err
	}
	d.Participants = markExternal(d.OrgID, byCall[callID])
	if d.Participants == nil {
		d.Participants = []CallParticipantDTO{}
	}

	// Shares are NOT read under the roster's widening, and do not need it: a
	// share row carries the CALL's org, so the hosting org sees it directly,
	// and a cross-org guest reaches it through the participant disjunct in the
	// call_screenshares policy — which is not recursive, because it subqueries
	// call_participants rather than itself.
	d.ActiveShares, err = activeSharesTx(ctx, tx, callID)
	if err != nil {
		return nil, err
	}

	// Recordings need no widening either: the call_recordings policy admits the
	// hosting org and anyone on the roster, which is exactly who may see the
	// call in the first place.
	var recStatus *string
	if err := tx.QueryRow(ctx, `
		SELECT status FROM call_recordings
		WHERE call_id = $1 AND status IN ('RECORDING', 'READY')
		ORDER BY started_at DESC LIMIT 1`, callID).Scan(&recStatus); err != nil &&
		!errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	d.RecordingStatus = recStatus
	return &d, nil
}

// GetCall reads one call. Visibility is enforced by RLS: same org, or a call
// you are a participant of.
func (s *Store) GetCall(ctx context.Context, orgID, callerID, callID string) (*CallDTO, error) {
	var out *CallDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		var derr error
		out, derr = getCallTx(ctx, tx, callID)
		return derr
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CallForNotify reads just enough of a call to describe it in an event.
//
// Deliberately NOT GetCall. Three differences, all of them the point:
//
//   - it skips the roster and the share list, which no notification carries and
//     which would be two extra queries on paths (a screen share toggling, a
//     joiner polling the lobby) that run often;
//   - it runs under bypass, because a MEETING's recipients legitimately span
//     orgs and this is the server describing a call to itself; and
//   - nothing it returns is ever sent to the caller. It feeds EmitCallLifecycle
//     and stops there, so the bypass cannot become a read of a call the
//     requester could not otherwise see. Every caller has already passed the
//     authorization for the action being announced.
func (s *Store) CallForNotify(ctx context.Context, callID string) (*CallDTO, error) {
	var out *CallDTO
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var (
			d           CallDTO
			scheduledAt *time.Time
		)
		err := tx.QueryRow(ctx, `
			SELECT id, org_id, kind, channel_id, title, media, status, scheduled_at
			FROM calls WHERE id = $1`, callID).
			Scan(&d.ID, &d.OrgID, &d.Kind, &d.ChannelID, &d.Title, &d.Media,
				&d.Status, &scheduledAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		d.ScheduledAt = tsPtr(scheduledAt)
		out = &d
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListChannelCalls returns the scheduled and live calls for a channel. Caller
// must be a member.
func (s *Store) ListChannelCalls(
	ctx context.Context, orgID, callerID, channelID string, limit int,
) ([]CallDTO, error) {
	limit = clampMessagePage(limit)
	out := []CallDTO{}
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}
		ids, err := callIDsTx(ctx, tx, `
			SELECT id FROM calls
			WHERE channel_id = $1 AND status IN ('SCHEDULED', 'LIVE')
			ORDER BY scheduled_at DESC NULLS FIRST
			LIMIT $2`, channelID, limit)
		if err != nil {
			return err
		}
		return appendCallsTx(ctx, tx, ids, &out)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// MyCallsHistoryDays is how far back this list reaches for calls that are over.
//
// A window rather than everything: the page that reads this shows "what am I
// expected at", and a meeting from eighteen months ago is not that. It is also
// what bounds the query — without it a long-lived account's finished calls would
// crowd the page cap and push its upcoming ones off the end.
const MyCallsHistoryDays = 30

// ListMyCalls returns the calls the caller is a participant of, newest first.
// Includes cross-org meetings they were invited to, which is the read path the
// participant RLS disjunct exists for.
//
// Finished calls are included for MyCallsHistoryDays. They used to be filtered
// out entirely, which left the Meetings page's "Past" tab permanently empty and
// made a call's recording unreachable — there was no row to offer it from.
func (s *Store) ListMyCalls(ctx context.Context, orgID, callerID string, limit int) ([]CallDTO, error) {
	limit = clampMessagePage(limit)
	out := []CallDTO{}
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		ids, err := callIDsTx(ctx, tx, `
			SELECT c.id FROM calls c
			JOIN call_participants p ON p.call_id = c.id AND p.user_id = $1
			WHERE c.status IN ('SCHEDULED', 'LIVE')
			   OR (c.status IN ('ENDED', 'CANCELLED')
			       AND COALESCE(c.ended_at, c.scheduled_at, c.created_at)
			           > now() - make_interval(days => $3))
			ORDER BY COALESCE(c.scheduled_at, c.created_at) DESC
			LIMIT $2`, callerID, limit, MyCallsHistoryDays)
		if err != nil {
			return err
		}
		return appendCallsTx(ctx, tx, ids, &out)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func callIDsTx(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]string, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// appendCallsTx hydrates a page of calls in THREE queries, whatever its size.
//
// It used to call getCallTx per id, and getCallTx is three queries — the call
// row, its roster, its live shares. So a fifty-call page was a hundred and fifty
// round trips inside one transaction, and the cost grew with the page rather
// than with the work. Here each of the three reads covers the whole page with
// `= ANY($1)`, and the rows are stitched together in memory.
//
// Still hydrated AFTER the id cursor is closed: a second query on the same tx
// while rows is still open errors with "conn busy", the same constraint the
// message readers work around.
//
// Order is preserved from `ids`, which is what the caller sorted.
func appendCallsTx(ctx context.Context, tx pgx.Tx, ids []string, out *[]CallDTO) error {
	if len(ids) == 0 {
		return nil
	}

	// 1. The calls themselves.
	byID := make(map[string]*CallDTO, len(ids))
	rows, err := tx.Query(ctx, `
		SELECT id, org_id, kind, channel_id, title, media, created_by,
		       scheduled_at, ends_at, started_at, started_by, ended_at, status, created_at
		FROM calls WHERE id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var (
			d                                       CallDTO
			scheduledAt, endsAt, startedAt, endedAt *time.Time
			createdAt                               time.Time
		)
		if err := rows.Scan(&d.ID, &d.OrgID, &d.Kind, &d.ChannelID, &d.Title, &d.Media,
			&d.CreatedBy, &scheduledAt, &endsAt, &startedAt, &d.StartedBy, &endedAt,
			&d.Status, &createdAt); err != nil {
			rows.Close()
			return err
		}
		d.ScheduledAt, d.StartedAt, d.EndedAt = tsPtr(scheduledAt), tsPtr(startedAt), tsPtr(endedAt)
		d.EndsAt = tsPtr(endsAt)
		d.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05.000Z")
		d.Participants = []CallParticipantDTO{}
		d.ActiveShares = []CallShareDTO{}
		byID[d.ID] = &d
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// 2. Every roster for the page, in one read. Same widening as getCallTx and
	// for the same reason — see rostersTx.
	rosters, err := rostersTx(ctx, tx, ids)
	if err != nil {
		return err
	}
	for callID, roster := range rosters {
		c, ok := byID[callID]
		if !ok {
			continue // RLS hid the call but not its roster; nothing to attach it to
		}
		c.Participants = markExternal(c.OrgID, roster)
	}

	// 3. Every live share for the page, in one read.
	srows, err := tx.Query(ctx, `
		SELECT call_id, id, user_id, source, started_at
		FROM call_screenshares
		WHERE call_id = ANY($1) AND stopped_at IS NULL
		ORDER BY call_id, started_at ASC`, ids)
	if err != nil {
		return err
	}
	for srows.Next() {
		var (
			sh        CallShareDTO
			startedAt time.Time
		)
		if err := srows.Scan(&sh.CallID, &sh.ID, &sh.UserID, &sh.Source, &startedAt); err != nil {
			srows.Close()
			return err
		}
		c, ok := byID[sh.CallID]
		if !ok {
			continue
		}
		sh.StartedAt = startedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		c.ActiveShares = append(c.ActiveShares, sh)
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return err
	}

	// 4. Which of these calls are being recorded, and which have something to
	// play back. One read for the page. DISTINCT ON keeps the newest of the two
	// states that matter, so a call recorded twice reports the current attempt
	// rather than an arbitrary one.
	rrows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (call_id) call_id, status FROM call_recordings
		WHERE call_id = ANY($1) AND status IN ('RECORDING', 'READY')
		ORDER BY call_id, started_at DESC`, ids)
	if err != nil {
		return err
	}
	for rrows.Next() {
		var callID, status string
		if err := rrows.Scan(&callID, &status); err != nil {
			rrows.Close()
			return err
		}
		if c, ok := byID[callID]; ok {
			st := status
			c.RecordingStatus = &st
		}
	}
	rrows.Close()
	if err := rrows.Err(); err != nil {
		return err
	}

	// Emit in the caller's order. An id with no row was hidden by RLS between
	// the id query and this one, which is a legitimate race rather than an
	// error — the caller asked for what it may see, and this is that.
	for _, id := range ids {
		if c, ok := byID[id]; ok {
			*out = append(*out, *c)
		}
	}
	return nil
}

// ── Authorization for media access ───────────────────────────────────────────

// CallAccess is what the LiveKit token minter needs to decide what to grant.
type CallAccess struct {
	CallID   string
	Kind     string
	Status   string
	Role     string
	External bool
	// DisplayName is how this caller should be LABELLED in the room, and it is
	// resolved here rather than taken from the JWT because the token has only
	// `username` — which auth-svc derives from the email local-part at signup,
	// so it is an address fragment and not a name anybody chose. Populated only
	// on the path that actually mints a token; the lobby polls this endpoint,
	// and a name it will not use is a lookup per poll.
	DisplayName string
	// Waiting is true when the caller belongs in this call but it has not
	// started yet. NO TOKEN MAY BE MINTED in that state — the caller is in the
	// waiting room, and the fields below say what to tell them about it.
	Waiting bool
	// CanStart reports whether this caller is one of the people who could end
	// the wait. It is what turns a lobby screen into a "Start meeting" button
	// for the organiser and a "waiting for the host" message for everybody
	// else, without the client having to work out org roles for itself.
	CanStart bool
	// NewlyWaiting is true only on the request that actually put the caller in
	// the lobby, never on the polls that follow. Clients poll this endpoint
	// while they wait, so it is what keeps one arrival from turning into a
	// stream of identical "someone is waiting" notifications.
	NewlyWaiting bool
}

// AuthorizeCallAccess answers "may this user be in this room, and as what".
//
// This is the single gate in front of media. It is deliberately separate from
// the REST reads: a token that lets you publish into a room is worth more than
// a row, so the decision is made once, here, from the database rather than from
// anything the client asserts.
//
// A CHANNEL call resolves through live channel membership rather than the
// participant table, so someone removed from the channel loses the room at
// their next token refresh even if they attended earlier.
//
// It is ALSO the waiting room. Belonging to a call and being allowed into it
// are two different questions once calls can be scheduled, and this answers both
// in one pass: a caller who belongs but whose call has not started comes back
// with Waiting set and no grant. That ordering matters — the membership checks
// run first, so the lobby is only ever offered to people who would have been
// admitted, and it never becomes a way to discover calls you are not part of.
func (s *Store) AuthorizeCallAccess(
	ctx context.Context, orgID, userID, callID string, claimRoles []string,
) (*CallAccess, error) {
	var out *CallAccess
	err := s.withCaller(ctx, orgID, userID, func(tx pgx.Tx) error {
		c, seat, err := getCallAndSeatTx(ctx, tx, callID, userID)
		if err != nil {
			return err
		}
		if c.status == CallEnded || c.status == CallCancelled {
			return ErrCallEnded
		}

		isChannelCall := c.kind == CallChannel && c.channelID != nil
		switch {
		case seat.role != "":
			// On the roster. A channel member who has since LEFT the channel
			// keeps a stale participant row, so for a channel call the row
			// alone is never the grant — membership is re-checked below.
			if isChannelCall {
				if err := requireChannelMember(ctx, tx, orgID, *c.channelID, userID); err != nil {
					return err
				}
			}
		case isChannelCall:
			// Not on the roster yet. A CHANNEL call admits any current member
			// of its channel without a prior invite — that IS the feature.
			//
			// The membership check here also covers the stale-row case above,
			// so it is not repeated: this branch and that one are exclusive.
			if err := requireChannelMember(ctx, tx, orgID, *c.channelID, userID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO call_participants (call_id, user_id, org_id, role)
				VALUES ($1, $2, $3, 'PARTICIPANT')
				ON CONFLICT (call_id, user_id) DO UPDATE SET left_at = NULL`,
				callID, userID, orgID); err != nil {
				return err
			}
			seat.role = RoleParticipant
		default:
			// Not on the roster, and no channel to inherit membership from.
			return ErrForbidden
		}

		out = &CallAccess{
			CallID:   callID,
			Kind:     c.kind,
			Status:   c.status,
			Role:     seat.role,
			External: c.orgID != orgID,
		}

		// Everything above decided that this person belongs in the call. This
		// decides whether the call is open yet.
		if c.status != CallScheduled {
			uname, display, nerr := s.cachedUserNames(ctx, tx, orgID, userID)
			if nerr != nil {
				return nerr
			}
			// username only as a last resort, and only because a member whose
			// user.created has not been consumed yet has no projected name at
			// all — an address fragment on a tile still beats a blank one.
			out.DisplayName = display
			if out.DisplayName == "" {
				out.DisplayName = uname
			}
			return nil
		}
		out.Waiting = true
		out.CanStart, err = canStartCallTx(ctx, tx, orgID, userID, seat.role, claimRoles, c)
		if err != nil {
			return err
		}
		// Someone who could start the call is not really waiting for anyone —
		// they are one request away from opening it — so they are shown the
		// lobby but never recorded as sitting in it. Recording them would put
		// the organiser in their own waiting-room list.
		if out.CanStart {
			return nil
		}
		// Already marked, which is the case on every poll after the first. The
		// UPDATE below would match no rows and change nothing, so skipping it
		// is not merely cheaper — it leaves the whole transaction read-only,
		// which is what a lobby full of people polling every few seconds needs
		// it to be.
		if seat.waiting {
			return nil
		}
		// COALESCE-free on purpose: the WHERE clause makes this a no-op if the
		// mark was set concurrently, so RowsAffected still distinguishes
		// arriving from polling even when the read above raced someone else.
		ct, err := tx.Exec(ctx, `
			UPDATE call_participants SET waiting_since = now()
			WHERE call_id = $1 AND user_id = $2 AND waiting_since IS NULL`, callID, userID)
		if err != nil {
			return err
		}
		out.NewlyWaiting = ct.RowsAffected() > 0
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RosterIDs lists everyone who has ever held a seat in a call, whether or not
// they are still in it — and live channel membership for a CHANNEL call, where
// the invite set is the channel and there is no other roster to have.
//
// The audience for "this is over", where LiveParticipantIDs is the audience for
// "this is happening". Both exist because ending a call closes out the roster,
// which makes the second set empty at exactly the moment the first is needed.
//
// Runs under bypass for the same reason LiveParticipantIDs does: a MEETING
// roster legitimately spans orgs, and this is the server fanning out to a list
// it computed itself.
func (s *Store) RosterIDs(ctx context.Context, callID string) ([]string, error) {
	var ids []string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		q := `SELECT user_id FROM call_participants WHERE call_id = $1`
		args := []any{callID}
		if c.kind == CallChannel && c.channelID != nil {
			q = `SELECT user_id FROM channel_members WHERE channel_id = $1`
			args = []any{*c.channelID}
		}
		ids, err = callIDsTx(ctx, tx, q, args...)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// LiveParticipantIDs lists who should be notified about a call in progress — the
// roster for MEETING and DIRECT, and live channel membership for CHANNEL calls,
// where the invite set is the channel itself.
//
// Runs under bypass because a MEETING roster legitimately spans orgs and this
// is trusted server code fanning out a notification, not a user read.
func (s *Store) LiveParticipantIDs(ctx context.Context, callID string) ([]string, error) {
	var ids []string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		q := `SELECT user_id FROM call_participants WHERE call_id = $1 AND left_at IS NULL`
		args := []any{callID}
		if c.kind == CallChannel && c.channelID != nil {
			q = `SELECT user_id FROM channel_members WHERE channel_id = $1`
			args = []any{*c.channelID}
		}
		ids, err = callIDsTx(ctx, tx, q, args...)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// OnCallUserIDs returns everyone in `orgID` who is in a LIVE call right now.
//
// This is what turns "Online" into "Busy": presence knows a socket is connected,
// which is a different question from whether the person can take an interruption.
// Someone sitting in a meeting showing as Available is worse than showing
// nothing at all, because a colleague acts on it.
//
// Derived from the call rows on every read rather than tracked as its own piece
// of state. A `busy` set maintained by join/leave events is one missed event
// away from marking somebody busy forever, with no traffic coming to correct it
// — and unlike presence there is no heartbeat here to reap against. Reading the
// truth is cheap: the row count is bounded by concurrent participants, not by
// the size of the org.
//
// Scoped to the CALL's org. A meeting roster may legitimately span orgs (see
// EmitCallLifecycle), and a guest from another company being in a call here does
// not make them busy to their OWN colleagues — that is their org's call state to
// report, not ours.
func (s *Store) OnCallUserIDs(ctx context.Context, orgID string) ([]string, error) {
	var ids []string
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		ids, err = callIDsTx(ctx, tx, `
			SELECT DISTINCT cp.user_id
			FROM call_participants cp
			JOIN calls c ON c.id = cp.call_id
			WHERE c.org_id = $1
			  AND c.status = 'LIVE'
			  AND cp.joined_at IS NOT NULL
			  AND cp.left_at IS NULL`, orgID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// CallNotice describes one call notification to fan out.
//
// A struct rather than a widening parameter list because the optional parts —
// who to send it to, and what is being shared — vary independently and are both
// empty for most events.
type CallNotice struct {
	// Type is one of the events.TypeCall* discriminants.
	Type string
	// ActorID is who caused it.
	ActorID string
	// ShareSource is set on the screen-share events only.
	ShareSource string
	// Recipients narrows delivery. nil means the call's own roster, which is
	// the right answer for everything except call.waiting — that goes to the
	// people who can start the call and to nobody else.
	Recipients []string
}

// EmitCallLifecycle publishes a call notification through the transactional
// outbox, so it travels the same durable Kafka → ws-gateway path as every other
// event in this service rather than a side channel that loses on restart.
//
// Runs under bypass because a MEETING roster legitimately spans orgs: this is
// trusted server code fanning out a notification to a list the SERVER computed,
// never one the caller supplied.
func (s *Store) EmitCallLifecycle(ctx context.Context, c *CallDTO, n CallNotice) error {
	if c == nil {
		return nil
	}
	recipients := n.Recipients
	if recipients == nil {
		var err error
		// `call.ended` goes to the WHOLE roster, not the live part of it.
		//
		// Ending a call closes out every open participant row in the same
		// transaction (endCallTx), so by the time this runs there is no live
		// part left to read — resolving this event the ordinary way would send
		// it to nobody and leave every client showing a meeting that is over.
		// The distinction is right in its own terms too: everyone who was in
		// the call needs to be told it ended, including the host whose leaving
		// ended it, whose other devices are still showing the room.
		if n.Type == events.TypeCallEnded {
			recipients, err = s.RosterIDs(ctx, c.ID)
		} else {
			recipients, err = s.LiveParticipantIDs(ctx, c.ID)
		}
		if err != nil {
			return err
		}
	}
	if len(recipients) == 0 {
		return nil
	}
	evt := events.CallLifecycle{
		Type:        n.Type,
		EventID:     uuid.Must(uuid.NewV7()).String(),
		OrgID:       c.OrgID,
		OccurredAt:  nowISO(),
		CallID:      c.ID,
		Kind:        c.Kind,
		Title:       c.Title,
		Media:       c.Media,
		Status:      c.Status,
		ActorID:     n.ActorID,
		ShareSource: n.ShareSource,
		Members:     recipients,
	}
	if c.ChannelID != nil {
		evt.ChannelID = *c.ChannelID
	}
	if c.ScheduledAt != nil {
		evt.ScheduledAt = *c.ScheduledAt
	}
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		// Keyed by call id so every event for one call lands on the same Kafka
		// partition and therefore arrives in order — a client must never see
		// "ended" before the "ring" that preceded it.
		return insertOutbox(ctx, tx, c.ID, evt)
	})
}
