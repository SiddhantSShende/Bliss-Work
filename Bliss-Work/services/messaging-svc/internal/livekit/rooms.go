package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// Room administration on the SFU.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Ending a call used to be a database fact and nothing more: the row went to
// ENDED and a call.ended event went out, but the SFU was never told. Everyone
// stayed connected to the room — cameras on, microphones live, media still
// flowing — because nothing had actually closed it. The organiser "ended" a
// meeting that carried on without them.
//
// Deleting the room server-side is what makes ending AUTHORITATIVE. It does not
// depend on every client receiving the event, honouring it, or even still being
// on a network: participants are disconnected by the SFU itself. Clients still
// react to call.ended so the UI closes promptly, but that is now the fast path
// rather than the only one.
//
// Lives on Minter because Minter already holds the API credentials and the URL;
// a second type would be a second lot of construction plumbing for one method.

// Bounds what ending a call can add to the request. Deliberately short: the
// call is already ended in the database by the time this runs, so a slow SFU
// must not hold the response open.
const roomAPITimeout = 5 * time.Second

var roomAPIClient = &http.Client{Timeout: roomAPITimeout}

// DeleteRoom disconnects every participant and removes the room from the SFU.
//
// Idempotent by LiveKit's own contract — deleting a room that does not exist
// (nobody ever joined, or it was already cleaned up) succeeds — so callers can
// run it unconditionally when a call ends.
func (m *Minter) DeleteRoom(ctx context.Context, room string) error {
	if !m.Configured() {
		return ErrNotConfigured
	}
	if strings.TrimSpace(room) == "" {
		return fmt.Errorf("livekit: DeleteRoom: empty room name")
	}

	tok, err := m.roomAdminToken(room)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]string{"room": room})
	if err != nil {
		return err
	}

	base := httpBase(m.url)
	if base == "" {
		return ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimSuffix(base, "/")+"/twirp/livekit.RoomService/DeleteRoom",
		bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+tok)

	resp, err := roomAPIClient.Do(req)
	if err != nil {
		return fmt.Errorf("livekit: DeleteRoom: %w", err)
	}
	defer resp.Body.Close()
	// Bounded: an error body from a misconfigured proxy can be a whole HTML
	// page, and none of it belongs in a log line.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("livekit: DeleteRoom: %s: %s",
			resp.Status, strings.TrimSpace(string(raw)))
	}
	return nil
}

// roomAdminToken mints the credential the room API requires: roomAdmin, scoped
// to the ONE room being closed, and valid for barely longer than the request.
// Scoping matters — a token that could administer any room would be a far more
// dangerous thing to leak from a log or a proxy than one that can close a
// meeting that is already over.
func (m *Minter) roomAdminToken(room string) (string, error) {
	now := time.Now().UTC()
	tok, err := jwt.NewBuilder().
		Issuer(m.apiKey).
		Subject(m.apiKey).
		IssuedAt(now).
		NotBefore(now).
		Expiration(now.Add(roomAPITimeout+time.Minute)).
		Claim("video", map[string]any{"roomAdmin": true, "room": room}).
		Build()
	if err != nil {
		return "", err
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.HS256, []byte(m.apiSecret)))
	if err != nil {
		return "", err
	}
	return string(signed), nil
}

// ── Room lifecycle, as the SFU reports it ────────────────────────────────────

// Room webhook events this service acts on. LiveKit sends several more
// (room_started, participant_joined, track_published…) and they are read as
// "nothing to do" rather than errors — the route answers 200 to everything it
// can authenticate, because a non-2xx makes the SFU retry an event we will
// ignore again.
const (
	// EventParticipantLeft fires when the SFU loses a participant, whether they
	// disconnected politely or their client simply stopped answering. The
	// second is the case this whole path exists for: it is the only signal
	// there is when a browser is closed, a laptop sleeps, or a network drops.
	EventParticipantLeft = "participant_left"
	// EventRoomFinished fires when the last participant leaves and the SFU
	// tears the room down.
	EventRoomFinished = "room_finished"
)

// RoomEvent is what a room-lifecycle webhook said, reduced to the three facts
// this service uses.
type RoomEvent struct {
	// Event is one of the constants above, or "" for an event to ignore.
	Event string
	// Room is the room name, which IS the call id — see Grant.Room. Empty on an
	// event that named no room.
	Room string
	// Identity is the participant's identity, which IS the BlissWork user id.
	// Set on participant events only.
	Identity string
}

// roomWebhookBody is the subset of LiveKit's WebhookEvent this reads.
//
// Both spellings of each nested object are accepted for the same reason
// egress.go accepts both: protojson emits camelCase, and a sender configured to
// emit proto names emits snake_case. Reading only one of them compiles, passes
// a hand-written test, and then silently ignores every real webhook.
type roomWebhookBody struct {
	Event       string           `json:"event"`
	Room        *roomInfo        `json:"room"`
	Participant *participantInfo `json:"participant"`
}

type roomInfo struct {
	Name string `json:"name"`
}

type participantInfo struct {
	Identity string `json:"identity"`
}

// ParseRoomWebhook authenticates a LiveKit webhook and extracts what it says
// about a room or one of its participants.
//
// Lives on Minter rather than Recorder because it must work on a deployment
// with no recording at all: an SFU is configured whenever calling is on, egress
// only when RECORDINGS_ENABLED is. Reading room events off the Recorder would
// have made "who is still in this call" depend on whether calls are recorded.
//
// An event this service does not act on returns a zero RoomEvent and no error,
// so the caller can treat "not for me" and "malformed" differently — only the
// second is worth logging.
func (m *Minter) ParseRoomWebhook(authHeader string, body []byte) (*RoomEvent, error) {
	if !m.Configured() {
		return nil, ErrNotConfigured
	}
	if err := verifyWebhook(m.apiKey, m.apiSecret, authHeader, body); err != nil {
		return nil, err
	}

	var wb roomWebhookBody
	if err := json.Unmarshal(body, &wb); err != nil {
		return nil, fmt.Errorf("livekit: webhook body: %w", err)
	}
	if wb.Event != EventParticipantLeft && wb.Event != EventRoomFinished {
		return &RoomEvent{}, nil
	}
	ev := &RoomEvent{Event: wb.Event}
	if wb.Room != nil {
		ev.Room = wb.Room.Name
	}
	if wb.Participant != nil {
		ev.Identity = wb.Participant.Identity
	}
	// A room event with no room names nothing to act on. Reported as an ignored
	// event rather than an error: it is the SFU being odd, not an attack, and
	// there is nothing to retry.
	if ev.Room == "" || (ev.Event == EventParticipantLeft && ev.Identity == "") {
		return &RoomEvent{}, nil
	}
	return ev, nil
}
