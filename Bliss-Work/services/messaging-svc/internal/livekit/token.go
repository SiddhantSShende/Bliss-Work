// Package livekit mints access tokens for the SFU that carries group call media.
//
// ── Why an SFU at all ────────────────────────────────────────────────────────
// Before this, a call was one RTCPeerConnection between two people. Extending
// that to N people peer-to-peer means a full mesh: every client encodes and
// uploads N-1 copies of its own camera. That is fine at 3, painful at 5, and
// unusable past 6 on the laptops and phones people actually own — the uplink,
// not the server, is what breaks. An SFU inverts it: each client publishes ONCE
// and subscribes to what it needs, so per-client cost is flat as the room grows
// and the server absorbs the fan-out.
//
// ── Why tokens are minted here and not by the client ─────────────────────────
// A LiveKit token IS the authorization — possessing one lets you publish into a
// room. So it is minted server-side, only after store.AuthorizeCallAccess has
// answered "may this user be in this room, and as what", and it is scoped to a
// single room with a short lifetime. The API secret never reaches a browser.
//
// The token is a plain HS256 JWT in LiveKit's documented claim shape, minted
// with the jwx library this service already depends on. That is deliberate: the
// official SDK would pull in a large dependency tree to produce these same
// dozen claims.
package livekit

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// ErrNotConfigured is returned when a call token is requested but no SFU is
// configured. Fail loudly: silently returning an empty token would surface as
// an unexplained media failure in the client.
var ErrNotConfigured = errors.New("livekit is not configured")

// DefaultTTL is how long a room token is good for. Short on purpose — a
// participant removed from a channel loses the room at their next refresh, so
// this bounds how long a revoked grant stays usable.
const DefaultTTL = 15 * time.Minute

// Minter issues room tokens. Zero value is unconfigured and returns
// ErrNotConfigured from every call.
type Minter struct {
	apiKey    string
	apiSecret string
	url       string
	// apiURL overrides the http(s) base derived from url, for a service that
	// cannot reach the SFU at the same address the browser uses. See
	// MinterOptions.APIURL and egress.go's identical apiURL, which this
	// mirrors — DeleteRoom needed the same override Recorder already had.
	apiURL string
}

// MinterOptions is what New needs beyond the SFU credentials.
type MinterOptions struct {
	// APIURL overrides the base derived from the wss:// URL. Set it when the
	// service reaches the SFU's HTTP API at a different address than the one
	// browsers connect to (an internal hostname behind the same edge, for
	// instance). Empty means "derive it from url", which is correct on most
	// deployments — see egress.go's RecorderOptions.APIURL, which this
	// deliberately matches so the two credentials stay configured the same way.
	APIURL string
}

// New builds a Minter. All three of apiKey/apiSecret/url empty is a valid "SFU
// disabled" state; a partially-filled config is a deployment mistake and is
// reported as one.
func New(apiKey, apiSecret, url string, o MinterOptions) (*Minter, error) {
	if apiKey == "" && apiSecret == "" && url == "" {
		return &Minter{}, nil
	}
	if apiKey == "" || apiSecret == "" || url == "" {
		return nil, fmt.Errorf(
			"livekit: set all of LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL, or none")
	}
	// LiveKit rejects short secrets, and a weak one here is equivalent to
	// letting anyone mint themselves into any room.
	if len(apiSecret) < 32 {
		return nil, errors.New("livekit: LIVEKIT_API_SECRET must be at least 32 characters")
	}
	apiURL := strings.TrimSuffix(o.APIURL, "/")
	return &Minter{apiKey: apiKey, apiSecret: apiSecret, url: url, apiURL: apiURL}, nil
}

// Configured reports whether an SFU is wired up.
func (m *Minter) Configured() bool { return m.apiSecret != "" }

// URL is the public wss:// endpoint the client connects to.
func (m *Minter) URL() string { return m.url }

// Grant describes what a participant may do in one room.
type Grant struct {
	// Room is the LiveKit room name. Always the call id — a room is a call, and
	// naming them the same thing means there is no mapping table to get wrong.
	Room string
	// Identity is the LiveKit participant identity. Always the BlissWork user
	// id, so the roster in the SFU and the roster in Postgres agree.
	Identity string
	// Name is the display name shown in the room.
	Name string
	// CanPublish is false for a listener. Hosts and participants publish.
	CanPublish bool
	// CanShareScreen adds the screen-share sources to the grant. Separate from
	// CanPublish because sharing a screen is a different act from turning a
	// camera on: it discloses whatever else is on that display, and a room may
	// well want to permit one and not the other.
	//
	// Ignored when CanPublish is false — a listener publishes nothing at all.
	CanShareScreen bool
	// RoomAdmin lets a host remove participants and end the room.
	RoomAdmin bool
	// TTL overrides DefaultTTL when non-zero.
	TTL time.Duration
}

// LiveKit's track source names. Fixed by the server's parser; a typo here does
// not fail loudly, it silently narrows what the participant may publish.
const (
	sourceCamera           = "camera"
	sourceMicrophone       = "microphone"
	sourceScreenShare      = "screen_share"
	sourceScreenShareAudio = "screen_share_audio"
)

// publishSources returns the explicit source allowlist for a grant.
//
// LiveKit treats an ABSENT canPublishSources as "any source", so the only way
// to make screen sharing a real capability — one that can be granted or
// withheld — is to always send the list. Sending it always is also what keeps
// the two cases symmetrical: there is no state in which the field's absence
// silently re-permits something the caller asked to withhold.
func publishSources(g Grant) []string {
	if !g.CanPublish {
		return nil
	}
	src := []string{sourceCamera, sourceMicrophone}
	if g.CanShareScreen {
		// Both, together. A screen share without its audio track is a silent
		// video of an application the presenter can hear and nobody else can.
		src = append(src, sourceScreenShare, sourceScreenShareAudio)
	}
	return src
}

// videoGrant is LiveKit's claim shape. Field names are fixed by LiveKit's
// server-side parser and must not be renamed.
type videoGrant struct {
	Room       string `json:"room"`
	RoomJoin   bool   `json:"roomJoin"`
	RoomAdmin  bool   `json:"roomAdmin,omitempty"`
	CanPublish bool   `json:"canPublish"`
	// CanPublishSources narrows canPublish to named track sources. omitempty
	// matters: an empty list and an absent key mean the SAME thing to LiveKit
	// ("no restriction"), so a listener must rely on canPublish=false rather
	// than on an empty allowlist here.
	CanPublishSources []string `json:"canPublishSources,omitempty"`
	CanSubscribe      bool     `json:"canSubscribe"`
	CanPublishData    bool     `json:"canPublishData"`
}

// Mint returns a signed room token.
func (m *Minter) Mint(g Grant) (string, time.Time, error) {
	if !m.Configured() {
		return "", time.Time{}, ErrNotConfigured
	}
	if g.Room == "" || g.Identity == "" {
		return "", time.Time{}, errors.New("livekit: room and identity are required")
	}
	ttl := g.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	exp := time.Now().UTC().Add(ttl)

	signed, err := signVideoJWT(m.apiKey, m.apiSecret, g.Identity, exp, map[string]any{
		// LiveKit reads identity from `sub`, but also honours this claim and
		// uses it for the participant's display name.
		"name": g.Name,
		"video": videoGrant{
			Room:              g.Room,
			RoomJoin:          true,
			RoomAdmin:         g.RoomAdmin,
			CanPublish:        g.CanPublish,
			CanPublishSources: publishSources(g),
			// Everyone subscribes — a participant who cannot publish can still
			// watch, which is what makes a listener role possible later.
			CanSubscribe:   true,
			CanPublishData: g.CanPublish,
		},
	})
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, exp, nil
}

// signVideoJWT builds and signs the Issuer/Subject/IssuedAt/NotBefore/
// Expiration envelope every LiveKit credential in this package needs, plus
// whatever claims the caller supplies (always including "video" — LiveKit's
// authorization claim — and, for Mint alone, "name"). Shared by Mint (a
// participant's room token), roomManagementToken (server-to-server RoomService
// calls, in rooms.go) and recordToken (the egress API, in egress.go) — the
// three differ only in subject, lifetime, and what the video claim grants.
func signVideoJWT(apiKey, apiSecret, subject string, exp time.Time, claims map[string]any) (string, error) {
	now := time.Now().UTC()
	b := jwt.NewBuilder().
		Issuer(apiKey).
		Subject(subject).
		IssuedAt(now).
		NotBefore(now).
		Expiration(exp)
	for k, v := range claims {
		b = b.Claim(k, v)
	}
	tok, err := b.Build()
	if err != nil {
		return "", fmt.Errorf("livekit: build token: %w", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.HS256, []byte(apiSecret)))
	if err != nil {
		return "", fmt.Errorf("livekit: sign token: %w", err)
	}
	return string(signed), nil
}
