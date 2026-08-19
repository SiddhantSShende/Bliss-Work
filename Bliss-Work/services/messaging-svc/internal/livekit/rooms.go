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
