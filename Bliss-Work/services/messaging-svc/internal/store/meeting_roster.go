package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Who sits on a meeting, and how an occurrence is written.
//
// Shared by the two things that create meetings — a one-off (ScheduleMeeting)
// and the occurrences of a repeating one (meeting_series.go) — so they cannot
// disagree about who may be invited.

const (
	// MaxMeetingRoster caps everyone on a meeting besides its host. Past this it
	// is a broadcast, not a meeting, and it should not be built by looping
	// INSERTs on a request thread. Mirrors the API's maxMeetingInvitees.
	MaxMeetingRoster = 200
	// MaxMeetingChannels caps how many channels one meeting may be addressed to.
	MaxMeetingChannels = 20
	// rosterProbe is how many channel-derived users are read: enough to tell that
	// the roster is over the cap even when the host is among them.
	rosterProbe = MaxMeetingRoster + 2
)

// occurrenceSpec is everything needed to write ONE meeting row and its roster.
type occurrenceSpec struct {
	orgID, hostID string
	title, media  string
	// at is nil for "meet now" (the row lands LIVE). endsAt is nil for no end.
	at, endsAt *time.Time
	channelIDs []string
	seriesID   *string
	// roster is everyone besides the host, already validated.
	roster []string
}

// insertOccurrenceTx writes one MEETING and its roster in the caller's
// transaction, returning the new call's id. The host is a HOST from the outset so
// they can end the call even before anyone else joins.
func insertOccurrenceTx(ctx context.Context, tx pgx.Tx, o occurrenceSpec) (string, error) {
	id := uuid.Must(uuid.NewV7()).String()
	status := CallScheduled
	var startedAt *time.Time
	if o.at == nil {
		status = CallLive
		now := time.Now().UTC()
		startedAt = &now
	}
	channels := o.channelIDs
	if channels == nil {
		channels = []string{}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO calls (id, org_id, kind, title, media, created_by, scheduled_at,
		                   ends_at, started_at, status, series_id, channel_ids)
		VALUES ($1, $2, 'MEETING', $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[])`,
		id, o.orgID, o.title, o.media, o.hostID, o.at, o.endsAt, startedAt, status,
		o.seriesID, channels); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO call_participants (call_id, user_id, org_id, role, invited_by, series_seated)
		SELECT $1, u, $2, CASE WHEN u = $3::uuid THEN 'HOST' ELSE 'PARTICIPANT' END, $3,
		       ($5::boolean AND u <> $3::uuid)
		FROM unnest($4::uuid[]) AS u`,
		id, o.orgID, o.hostID, append([]string{o.hostID}, o.roster...), o.seriesID != nil); err != nil {
		return "", err
	}
	return id, nil
}

// requireCallerInChannelsTx refuses a channel the caller cannot see.
//
// A meeting addressed to a channel invites its members, so naming a private
// channel would let anyone pull its whole membership into a room — and learn who
// is in it from the roster. The caller must be a member, the same rule
// ScheduleChannelCall applies, and a channel that is gone or belongs to another
// org answers exactly like one the caller is not in (ErrForbidden).
func requireCallerInChannelsTx(ctx context.Context, tx pgx.Tx, orgID, callerID string, channelIDs []string) error {
	for _, ch := range channelIDs {
		if err := requireChannelMember(ctx, tx, orgID, ch, callerID); err != nil {
			return err
		}
	}
	return nil
}

// resolveRosterTx works out who to seat beside the host: the explicit invitees,
// then the members of the channels.
//
// strict is a request from a person who can be told "no": an invitee who is not
// an active member of the org, or who has a block with someone already seated,
// refuses the whole request (ErrForbidden — the same answer for unknown, other
// org and blocked, so the caller learns nothing about which), and so does a
// roster over the cap (ErrMeetingTooLarge). A channel's members are never a
// reason to refuse: the organiser did not choose them one by one, and one blocked
// pair in a large channel must not make the channel un-invitable. They are
// skipped, the earlier-seated side winning.
//
// Not strict is the background top-up of a series that already exists. There is
// nobody to refuse, and a member deactivated since the series was created must
// not stall every later occurrence, so anything that no longer qualifies is
// dropped and an oversized roster is truncated.
//
// Runs under either a caller or a bypass transaction, so every query names the
// org rather than leaning on RLS.
func resolveRosterTx(
	ctx context.Context, tx pgx.Tx, orgID, hostID string, invitees, channels []string, strict bool,
) ([]string, error) {
	hostID = canonicalUUID(hostID)
	explicit := uniqueExcept(invitees, hostID)
	active, err := activeOrgUsersTx(ctx, tx, orgID, explicit)
	if err != nil {
		return nil, err
	}
	if strict && len(active) != len(explicit) {
		return nil, ErrForbidden
	}
	derived, err := channelMembersTx(ctx, tx, orgID, channels)
	if err != nil {
		return nil, err
	}

	candidates := uniqueExcept(append(keep(explicit, active), derived...), hostID)
	blocked, err := blockedPairsTx(ctx, tx, orgID, append([]string{hostID}, candidates...))
	if err != nil {
		return nil, err
	}

	isExplicit := make(map[string]bool, len(explicit))
	for _, id := range explicit {
		isExplicit[id] = true
	}
	seated := []string{hostID}
	for _, id := range candidates {
		if conflicts(blocked, id, seated) {
			if strict && isExplicit[id] {
				return nil, ErrForbidden
			}
			continue
		}
		if len(seated)-1 >= MaxMeetingRoster {
			if strict {
				return nil, ErrMeetingTooLarge
			}
			break
		}
		seated = append(seated, id)
	}
	return seated[1:], nil
}

// activeOrgUsersTx returns the subset of ids that are ACTIVE members of orgID.
// Inactive means suspended or removed: user_projection keeps the row (history
// resolves names through it) and only flips a flag, so "exists" is not enough.
func activeOrgUsersTx(ctx context.Context, tx pgx.Tx, orgID string, ids []string) (map[string]bool, error) {
	out := make(map[string]bool, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT user_id::text FROM user_projection
		WHERE org_id = $1 AND active AND user_id = ANY($2::uuid[])`, orgID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// channelMembersTx returns the active members of the given channels, longest
// standing first, bounded to rosterProbe. Channels that no longer exist, or that
// belong to another org, contribute nobody: channel_members carries no foreign
// key, so its rows can outlive a deleted channel and must be joined to it.
func channelMembersTx(ctx context.Context, tx pgx.Tx, orgID string, channelIDs []string) ([]string, error) {
	if len(channelIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT cm.user_id::text
		FROM channel_members cm
		JOIN channels ch ON ch.id = cm.channel_id AND ch.org_id = $1
		JOIN user_projection up ON up.user_id = cm.user_id AND up.org_id = $1 AND up.active
		WHERE cm.channel_id = ANY($2::uuid[])
		GROUP BY cm.user_id
		ORDER BY min(cm.joined_at), cm.user_id
		LIMIT $3`, orgID, channelIDs, rosterProbe)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// blockedPairsTx returns every pair among ids with a block in either direction,
// keyed by orderedPair. It is blockedAgainstAnyTx's rule (a conversation whose
// members carry any `blocked` flag) read for the whole candidate set in ONE query
// rather than once per person — a channel can put a couple of hundred people
// through this, on every top-up of a series.
func blockedPairsTx(ctx context.Context, tx pgx.Tx, orgID string, ids []string) (map[[2]string]bool, error) {
	out := map[[2]string]bool{}
	if len(ids) < 2 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT c.user_low::text, c.user_high::text
		FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id = c.id
		WHERE c.org_id = $1 AND cm.blocked
		  AND c.user_low = ANY($2::uuid[]) AND c.user_high = ANY($2::uuid[])`, orgID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var low, high string
		if err := rows.Scan(&low, &high); err != nil {
			return nil, err
		}
		out[[2]string{low, high}] = true
	}
	return out, rows.Err()
}

func conflicts(blocked map[[2]string]bool, id string, seated []string) bool {
	for _, other := range seated {
		low, high := orderedPair(id, other)
		if blocked[[2]string{low, high}] {
			return true
		}
	}
	return false
}

// uniqueExcept returns ids in first-seen order, canonicalised, without repeats
// and without `drop` (the host, who is seated separately).
func uniqueExcept(ids []string, drop string) []string {
	seen := map[string]bool{canonicalUUID(drop): true}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = canonicalUUID(id)
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// keep filters ids to those present in ok, preserving order.
func keep(ids []string, ok map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if ok[id] {
			out = append(out, id)
		}
	}
	return out
}

// canonicalUUID is the lowercase hyphenated form Postgres returns, so ids from
// different sources compare equal. Anything unparseable is left alone — the
// query it reaches will reject it.
func canonicalUUID(s string) string {
	if u, err := uuid.Parse(s); err == nil {
		return u.String()
	}
	return s
}
