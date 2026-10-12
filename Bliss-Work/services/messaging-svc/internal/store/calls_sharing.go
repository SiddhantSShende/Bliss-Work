package store

// Screen sharing.
//
// ── What the backend is actually for here ────────────────────────────────────
// The pixels never come through this service. A screen is published to the SFU
// as an ordinary track, on the connection the room token already authorises, and
// LiveKit fans it out. So it is worth being precise about what these tables and
// endpoints do and do not guarantee.
//
// They are the COORDINATION record, not the media path:
//
//	they answer   "is anyone sharing, who, and is that a tab, a window or their
//	              whole screen" — for someone who joined after the share began,
//	              for a client that has not yet received the track, and for the
//	              call row that lists it.
//	they own      the stop authority. See below.
//	they are not  the thing that physically permits publishing. That is
//	              livekit.Grant.CanShareScreen, decided when the token is minted.
//
// A client that published a screen track without calling StartScreenShare would
// still be seen by the room, and this table would not know about it. That is a
// deliberate limit rather than an oversight: making the record authoritative
// would mean gating the capability per-share and reissuing a token to turn
// sharing on, which costs a reconnect in the middle of a call. The capability is
// granted with the token; this is how the room agrees on what is happening.
//
// ── Stop authority ───────────────────────────────────────────────────────────
// The product rule is that the stop-sharing control belongs to the person
// sharing and is shown to nobody else. That is not something a backend can
// enforce by wishing — it has to be true of the API. So:
//
//   - StopScreenShare takes NO target. It stops the caller's own share and
//     there is no argument with which to name somebody else's.
//   - the RLS write policy on call_screenshares is scoped to your own row
//     (0016_call_sharing_and_lobby.sql), so this holds even for a caller
//     reaching the database by some other route.
//   - the two exceptions are both departures rather than interventions: leaving
//     the call stops your own share, and ending the call stops everyone's.
//
// There is deliberately no host force-stop endpoint. A host who needs a share
// to end can end the call; anything finer would be exactly the control the
// requirement says other participants must not have.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Screen share sources — the three things a user can pick, and the three things
// a browser will report back.
const (
	// ShareScreen is an entire display.
	ShareScreen = "SCREEN"
	// ShareWindow is a single application window.
	ShareWindow = "WINDOW"
	// ShareTab is one browser tab.
	ShareTab = "TAB"
)

// ErrShareSourceInvalid is returned for a source that is none of the three.
var ErrShareSourceInvalid = errors.New("screen share source must be screen, window or tab")

// ErrCallNotStarted is returned when an action needs a call that is under way
// and the call is still sitting in front of its waiting room. Distinct from
// ErrCallEnded: one means "not yet", the other means "never again".
var ErrCallNotStarted = errors.New("call has not started yet")

// ErrShareAlreadyActive is returned when someone tries to start sharing while
// another participant's share is already live in the same call. Exactly one
// share may be live per call — see idx_call_screenshares_live_per_call
// (0037_call_screenshare_one_per_call.sql) — and this is that invariant's
// error, not a generic conflict, so the client can tell "someone else is
// presenting" apart from every other 409 without matching on the message.
var ErrShareAlreadyActive = errors.New("another participant is already sharing their screen")

// NormalizeShareSource maps what a client sends to what the column accepts.
//
// Browsers do not report these three names. MediaTrackSettings.displaySurface —
// the only reliable way to learn what the user actually picked, since the picker
// itself is chrome the page cannot see — says "monitor", "window" or "browser".
// Accepting both spellings means the client can forward what it was given
// without translating, and one canonical spelling reaches the database.
func NormalizeShareSource(src string) (string, error) {
	switch strings.ToUpper(strings.TrimSpace(src)) {
	case "SCREEN", "MONITOR":
		return ShareScreen, nil
	case "WINDOW":
		return ShareWindow, nil
	case "TAB", "BROWSER":
		return ShareTab, nil
	default:
		return "", ErrShareSourceInvalid
	}
}

// requireLiveParticipantTx is the gate in front of every sharing action: the
// call must be under way, and the caller must be in it.
//
// The channel re-check mirrors AuthorizeCallAccess. A participant row is not by
// itself a grant for a CHANNEL call — someone removed from the channel keeps a
// stale row — and sharing a screen into a room you have been removed from would
// be a worse outcome than merely watching one.
func requireLiveParticipantTx(
	ctx context.Context, tx pgx.Tx, orgID, userID string, c *callRow,
) error {
	switch c.status {
	case CallEnded, CallCancelled:
		return ErrCallEnded
	case CallScheduled:
		return ErrCallNotStarted
	}
	var present bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM call_participants
		               WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL)`,
		c.id, userID).Scan(&present); err != nil {
		return err
	}
	if !present {
		return ErrForbidden
	}
	if c.kind == CallChannel && c.channelID != nil {
		if err := requireChannelMember(ctx, tx, orgID, *c.channelID, userID); err != nil {
			return err
		}
	}
	return nil
}

// StartScreenShare records that the caller has begun sharing.
//
// Re-declaring the CALLER'S OWN existing share updates its source rather than
// failing, and keeps the original id and start time — a client that re-sends
// because a response was lost, or because the user swapped which window is
// being shared, is describing the SAME share session and should not produce a
// second one.
//
// At most one share may be live per call. The INSERT below targets
// idx_call_screenshares_live_per_call (0037_call_screenshare_one_per_call.sql),
// a partial unique index on call_id alone, so a second participant trying to
// start while another's share is live hits that conflict — and the `DO UPDATE
// ... WHERE` clause only actually performs the update (and so only returns a
// row) when the live row's user_id is the SAME caller re-declaring. A
// different user's attempt satisfies the ON CONFLICT target, skips the
// update because the WHERE is false, and returns no row, which this maps to
// ErrShareAlreadyActive. This is what makes the check atomic across
// concurrent requests: Postgres resolves the conflict and evaluates that
// WHERE clause under the row's own lock, so two simultaneous starts cannot
// both see "no live share yet" — exactly one INSERT wins, the other gets the
// zero-rows outcome.
func (s *Store) StartScreenShare(
	ctx context.Context, orgID, userID, callID, source string,
) (*CallShareDTO, error) {
	src, err := NormalizeShareSource(source)
	if err != nil {
		return nil, err
	}
	var out *CallShareDTO
	err = s.withCaller(ctx, orgID, userID, func(tx pgx.Tx) error {
		c, err := getCallRowTx(ctx, tx, callID)
		if err != nil {
			return err
		}
		if err := requireLiveParticipantTx(ctx, tx, orgID, userID, c); err != nil {
			return err
		}
		var (
			id        string
			startedAt time.Time
			stored    string
		)
		// org_id is the CALL's, not the sharer's — see the column note in
		// 0016. It is what lets ending the call close a guest's share.
		err = tx.QueryRow(ctx, `
			INSERT INTO call_screenshares (id, call_id, user_id, org_id, source)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (call_id) WHERE stopped_at IS NULL
			DO UPDATE SET source = EXCLUDED.source
			WHERE call_screenshares.user_id = EXCLUDED.user_id
			RETURNING id, source, started_at`,
			uuid.Must(uuid.NewV7()).String(), callID, userID, c.orgID, src).
			Scan(&id, &stored, &startedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrShareAlreadyActive
		}
		if err != nil {
			return err
		}
		out = &CallShareDTO{
			ID:        id,
			CallID:    callID,
			UserID:    userID,
			Source:    stored,
			StartedAt: startedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// StopScreenShare ends the CALLER'S OWN share, if one is live.
//
// Note the signature: there is no target user. That is the enforcement of "the
// stop-sharing control is the sharer's alone" — not a check that could be
// forgotten, but an argument that does not exist.
//
// Stopping is idempotent and never errors on "nothing to stop": a duplicate
// stop, a stop that lost a race with leave/end/the SFU-disconnect webhook
// closing the same row, or a stop for a share that never existed all ask for
// the same end state — this user not sharing — which already holds. Treating
// that as a conflict (as this used to, returning ErrNotSharing/409) is what
// produced the spurious 409s a retried or merely-late stop call would hit.
// The returned bool reports whether THIS call is the one that actually closed
// a row, so the handler can skip re-announcing a stop nothing changed.
func (s *Store) StopScreenShare(ctx context.Context, orgID, userID, callID string) (bool, error) {
	var stopped bool
	err := s.withCaller(ctx, orgID, userID, func(tx pgx.Tx) error {
		// No status check. A share must be stoppable even once the call has
		// ended or the caller has been removed from the channel — refusing
		// would strand a row marked live forever, and stopping is the safe
		// direction to allow.
		ct, err := tx.Exec(ctx, `
			UPDATE call_screenshares SET stopped_at = now()
			WHERE call_id = $1 AND user_id = $2 AND stopped_at IS NULL`, callID, userID)
		if err != nil {
			return err
		}
		stopped = ct.RowsAffected() > 0
		return nil
	})
	return stopped, err
}

// stopSharesTx closes live shares inside an existing transaction: one person's
// when userID is set, everyone's when it is nil. Reports whether anything was
// actually stopped, so a caller can skip announcing a share that had already
// ended.
//
// The nil form has exactly one caller — EndCall — and the RLS policy is written
// so that it is the only shape of "stop someone else's share" the database will
// accept, since it can only ever set stopped_at, never clear it.
func stopSharesTx(ctx context.Context, tx pgx.Tx, callID string, userID *string) (bool, error) {
	sql := `UPDATE call_screenshares SET stopped_at = now()
	        WHERE call_id = $1 AND stopped_at IS NULL`
	args := []any{callID}
	if userID != nil {
		sql += ` AND user_id = $2`
		args = append(args, *userID)
	}
	ct, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

// activeSharesTx lists what is on screen in a call right now.
func activeSharesTx(ctx context.Context, tx pgx.Tx, callID string) ([]CallShareDTO, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, user_id, source, started_at
		FROM call_screenshares
		WHERE call_id = $1 AND stopped_at IS NULL
		ORDER BY started_at ASC`, callID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CallShareDTO{}
	for rows.Next() {
		var (
			sh        CallShareDTO
			startedAt time.Time
		)
		if err := rows.Scan(&sh.ID, &sh.UserID, &sh.Source, &startedAt); err != nil {
			return nil, err
		}
		sh.CallID = callID
		sh.StartedAt = startedAt.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, sh)
	}
	return out, rows.Err()
}
