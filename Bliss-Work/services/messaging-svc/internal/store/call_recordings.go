package store

// Call recordings.
//
// ── What this service does and does not do ───────────────────────────────────
// Exactly as with screen sharing, the media never passes through here. A
// recording is produced by LiveKit Egress: the SFU composites the room and
// writes ONE file to the blob store this service already owns. What lives here
// is the RECORD of that — which call it belongs to, whether the file landed,
// where it landed, and who may read it back.
//
// The split matters when something goes wrong. An egress that dies mid-call
// leaves a row saying FAILED rather than leaving nothing at all: people are told
// a call is being recorded, and silence afterwards is the one answer that
// misleads them.
//
// ── Two write paths, both server-only ────────────────────────────────────────
// Starting a recording is attributed to the caller who started the CALL, but
// the row is still written under bypass — as is the webhook that completes it,
// which arrives from LiveKit with no user at all. The RLS write policy
// (0024_call_recordings.sql) therefore admits nothing else: no request a
// participant can make writes to this table.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Recording states. RECORDING is the live one; the other two are terminal.
const (
	RecordingInProgress = "RECORDING"
	RecordingReady      = "READY"
	RecordingFailed     = "FAILED"
)

// ErrNoRecording is returned when a call has no recording to play back. It is a
// STATE, not a failure — most calls are not recorded — and the handler answers
// 404 with it rather than logging it as an error.
var ErrNoRecording = errors.New("no recording for this call")

// CallRecordingDTO is one recording as the API returns it.
//
// StorageKey and Error are deliberately NOT serialised. The key names the
// bucket layout and the error names paths and credentials-adjacent detail; both
// are for the operator, and neither is anything a participant needs in order to
// press play. The playable link is minted separately, per request, per user.
type CallRecordingDTO struct {
	ID         string  `json:"id"`
	CallID     string  `json:"callId"`
	Status     string  `json:"status"`
	Mime       string  `json:"mime"`
	SizeBytes  int64   `json:"sizeBytes"`
	DurationMs int64   `json:"durationMs"`
	StartedAt  string  `json:"startedAt"`
	EndedAt    *string `json:"endedAt,omitempty"`

	// StorageKey is the blob key, empty until the file has landed.
	StorageKey string `json:"-"`
	OrgID      string `json:"-"`
}

// StartRecording records that an egress has been requested for a call.
//
// Called immediately AFTER the SFU accepted the request, so `egressID` is
// LiveKit's own handle and the only thing the completion webhook will carry.
// The insert is idempotent on that handle: LiveKit retries, and a retry must
// not fork one recording into two rows.
//
// `id` and `storageKey` are both chosen by the CALLER, before the egress is
// asked for, because the key is part of that request: egress writes to the path
// it was given, and the row must name the same one. The key is written now,
// before the file exists — nothing can read it until the row is READY, so an
// in-progress key is not a promise of anything.
func (s *Store) StartRecording(ctx context.Context, id, callID, egressID, storageKey string) error {
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		// org_id is read from the CALL rather than taken from the requester:
		// the recording belongs to the meeting, and the webhook that completes
		// it has no org context of its own to check against.
		return tx.QueryRow(ctx, `
			INSERT INTO call_recordings (id, call_id, org_id, egress_id, status, storage_key)
			SELECT $1, c.id, c.org_id, $3, 'RECORDING', $4 FROM calls c WHERE c.id = $2
			ON CONFLICT (egress_id) DO UPDATE SET egress_id = EXCLUDED.egress_id
			RETURNING id`, id, callID, egressID, storageKey).Scan(&id)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// The call vanished between starting it and asking for the egress.
		return ErrForbidden
	}
	return err
}

// RecordingTarget is the little a recording needs to know about the call it
// belongs to: which room to record, whose org owns the file, and whether the
// call is a kind that may be recorded at all.
type RecordingTarget struct {
	CallID string
	OrgID  string
	Kind   string
}

// AuthorizeRecordingControl answers "may this caller start or stop the
// recording of this call".
//
// The same rule as minting an invite link, and for the same reason: recording
// is a power over the HOSTING org's meeting, exercised on behalf of everyone in
// the room. So it is hosts of the hosting org, and nobody else — not a
// cross-org guest who was let in by link, and not an ordinary participant.
//
// The call must be LIVE. There is nothing to record before it starts, and after
// it ends the egress is already gone.
func (s *Store) AuthorizeRecordingControl(
	ctx context.Context, orgID, callerID, callID string,
) (*RecordingTarget, error) {
	var out *RecordingTarget
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		var (
			callOrgID string
			kind      string
			status    string
		)
		err := tx.QueryRow(ctx,
			`SELECT org_id, kind, status FROM calls WHERE id = $1`, callID).
			Scan(&callOrgID, &kind, &status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if status == CallEnded || status == CallCancelled {
			return ErrCallEnded
		}
		if status != CallLive {
			return ErrCallNotStarted
		}
		if callOrgID != orgID {
			return ErrForbidden
		}
		var role string
		err = tx.QueryRow(ctx,
			`SELECT role FROM call_participants WHERE call_id = $1 AND user_id = $2`,
			callID, callerID).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && role != RoleHost) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		out = &RecordingTarget{CallID: callID, OrgID: callOrgID, Kind: kind}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RecordingResult is what the egress webhook learned about a finished file.
type RecordingResult struct {
	EgressID string
	// StorageKey overrides the key chosen when the recording started, for the
	// case where egress wrote somewhere else than it was asked to. Empty means
	// "where we said", which is the normal path.
	StorageKey string
	Mime       string
	SizeBytes  int64
	DurationMs int64
	// Error is non-empty when the egress failed. A result carrying one is
	// stored as FAILED whatever else it contains.
	Error string
}

// CompleteRecording settles a recording from the egress webhook.
//
// Runs under bypass and has to: the webhook is LiveKit talking to us, with no
// user and no org in the request. What bounds it is that it can only ever
// address a row by an egress id the SFU issued, and it can only move that row
// out of RECORDING — a redelivered webhook for an already-settled recording
// changes nothing.
//
// An unknown egress id is NOT an error. Egress can outlive a database restore,
// and a webhook for a recording we have no row for is noise to be dropped, not
// a reason to make LiveKit retry forever.
func (s *Store) CompleteRecording(ctx context.Context, res RecordingResult) error {
	status := RecordingReady
	if res.Error != "" {
		status = RecordingFailed
	}
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		// The key is CLEARED on failure rather than left behind: "READY with a
		// key" and "not playable" are the only two states a reader should ever
		// have to tell apart, and a dangling key pointing at a file that was
		// never written is the third one that causes 500s later.
		_, err := tx.Exec(ctx, `
			UPDATE call_recordings
			SET status      = $2,
			    storage_key = CASE WHEN $2 = 'READY'
			                       THEN COALESCE(NULLIF($3, ''), storage_key)
			                       ELSE NULL END,
			    mime        = COALESCE(NULLIF($4, ''), mime),
			    size_bytes  = $5,
			    duration_ms = $6,
			    error       = NULLIF($7, ''),
			    ended_at    = now()
			WHERE egress_id = $1 AND status = 'RECORDING'`,
			res.EgressID, status, res.StorageKey, res.Mime,
			res.SizeBytes, res.DurationMs, res.Error)
		return err
	})
}

// StopRecording marks a recording as failed because the call ended before the
// SFU ever reported a file. Used when stopping the egress itself errored — the
// alternative is a row stuck in RECORDING for ever.
func (s *Store) StopRecording(ctx context.Context, egressID, reason string) error {
	return s.CompleteRecording(ctx, RecordingResult{EgressID: egressID, Error: reason})
}

// LiveRecordingEgressID returns the egress handle still running for a call, or
// "" if there is none. Read under bypass because it feeds the server's own
// decision to stop an egress, not a user-facing read.
func (s *Store) LiveRecordingEgressID(ctx context.Context, callID string) (string, error) {
	var egressID string
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT egress_id FROM call_recordings
			WHERE call_id = $1 AND status = 'RECORDING'
			ORDER BY started_at DESC LIMIT 1`, callID).Scan(&egressID)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return egressID, nil
}

// RecordingForCall returns the playable recording of a call, for a caller who
// is allowed to see it.
//
// Authorization is the RLS policy and nothing else — the hosting org, or anyone
// on the roster, including a cross-org guest who attended the meeting. A
// recording that exists but is not READY is reported as ErrNoRecording: there
// is nothing to play, and "still recording" is not a distinction the player can
// act on.
func (s *Store) RecordingForCall(
	ctx context.Context, orgID, callerID, callID string,
) (*CallRecordingDTO, error) {
	var out *CallRecordingDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		d, err := readRecordingTx(ctx, tx, `
			SELECT id, call_id, org_id, status, mime, size_bytes, duration_ms,
			       COALESCE(storage_key, ''), started_at, ended_at
			FROM call_recordings
			WHERE call_id = $1 AND status = 'READY'
			ORDER BY started_at DESC LIMIT 1`, callID)
		if err != nil {
			return err
		}
		out = d
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// RecordingForPlayback re-authorizes a signed playback link on every hit.
//
// This is the same posture as attachment downloads: the token in the URL
// authenticates, and THIS re-checks that the holder may still read the
// recording — so losing the seat that granted it (being removed from the call's
// org, say) stops playback at the next request rather than at token expiry.
func (s *Store) RecordingForPlayback(
	ctx context.Context, orgID, callerID, recordingID string,
) (*CallRecordingDTO, error) {
	var out *CallRecordingDTO
	err := s.withCaller(ctx, orgID, callerID, func(tx pgx.Tx) error {
		d, err := readRecordingTx(ctx, tx, `
			SELECT id, call_id, org_id, status, mime, size_bytes, duration_ms,
			       COALESCE(storage_key, ''), started_at, ended_at
			FROM call_recordings
			WHERE id = $1 AND status = 'READY'`, recordingID)
		if err != nil {
			return err
		}
		out = d
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func readRecordingTx(
	ctx context.Context, tx pgx.Tx, sql string, arg any,
) (*CallRecordingDTO, error) {
	var (
		d         CallRecordingDTO
		startedAt time.Time
		endedAt   *time.Time
	)
	err := tx.QueryRow(ctx, sql, arg).Scan(&d.ID, &d.CallID, &d.OrgID, &d.Status, &d.Mime,
		&d.SizeBytes, &d.DurationMs, &d.StorageKey, &startedAt, &endedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Indistinguishable on purpose from "you may not see this call": both
		// mean there is nothing here for you, and telling them apart would say
		// whether a call you cannot read was recorded.
		return nil, ErrNoRecording
	}
	if err != nil {
		return nil, err
	}
	if d.StorageKey == "" {
		return nil, ErrNoRecording
	}
	d.StartedAt = startedAt.UTC().Format("2006-01-02T15:04:05.000Z")
	d.EndedAt = tsPtr(endedAt)
	return &d, nil
}
