// Package push carries fan-out deliveries from the delivery service to the one
// gateway node that actually holds the recipient's socket.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Today every gateway pod subscribes to Kafka under its own consumer group, so
// every pod receives every event on every fan-out topic and throws away the
// ones not addressed to one of its sockets. That is a broadcast: Kafka egress
// and replay-outbox writes both scale with POD COUNT rather than with traffic,
// so adding a pod adds load to every other component instead of relieving it.
//
// Routed delivery inverts it. One consumer group reads the stream once, works
// out the recipients once, writes the outbox once, looks up which nodes hold
// those users, and sends each node only its own share.
//
// ── Why HTTP and not gRPC ────────────────────────────────────────────────────
// The plan called for gRPC, and gRPC would be the better transport at the far
// end of this — binary framing, one long-lived multiplexed stream per node
// rather than a request per batch. It also needs protobuf definitions, a code
// generator in the build, and a second wire format in a repository that already
// has exactly one internal-service convention: POST JSON with an
// X-Internal-Token header, which delivery.Dispatcher already uses to reach
// messaging-svc.
//
// Following the existing convention makes this reviewable and lets the batching
// below recover most of what gRPC would have given. The transport is an
// implementation detail behind Client.Push and can be swapped without touching
// the routing logic, which is the part that matters.
package push

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Path is the endpoint gateway nodes expose to receive pushes.
const Path = "/internal/push"

// TokenHeader is the shared-secret header, matching the convention the delivery
// ack path already uses against messaging-svc.
const TokenHeader = "X-Internal-Token" //nolint:gosec // G101: header name, not a credential

// CallerHeader names the caller presenting the shared secret above.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// WS_GATEWAY_INTERNAL_TOKEN is held by TWO distinct roles today: delivery-svc,
// which posts `Deliveries` (one payload per recipient, computed once from the
// Kafka fan-out), and every OTHER ws-gateway node, which posts `Broadcast` (one
// payload to many recipients, for RTC signalling and presence — see
// push.Fanout). Both share the same secret because both already ran inside the
// same trust boundary the secret was meant to gate, but the secret alone
// cannot tell them apart: it is "yes, an internal caller" with no notion of
// WHICH one. Possession of it has always implied full push authority to any
// connected user — see security-review.md S1/D3.
//
// This header does not mint a second secret or a token per caller; it names
// the role the caller is already acting under, which handlePush then uses to
// enforce the one authorization rule that is actually knowable at this layer:
// a caller claiming to be delivery-svc may only post addressed `Deliveries`,
// and a caller claiming to be a gateway peer may only post a `Broadcast`. That
// does not make the shared secret any less sensitive — a holder of the token
// can still forge either header value — but it closes the gap where a caller
// that should only ever send one shape is accepted sending the other, and it
// gives the server-side log/metric for "wrong role" something to say.
const CallerHeader = "X-Internal-Caller"

// Known caller identities. handlePush accepts only these two values; anything
// else (missing, misspelled, or a role that does not exist) is rejected.
const (
	CallerDeliverySvc = "delivery-svc"
	CallerGatewayPeer = "ws-gateway-peer"
)

// MaxBodyBytes caps a push request. Generous next to a realistic batch — a
// thousand recipients of a chat message is well under this — but finite, so a
// malformed or hostile caller cannot make a gateway buffer without bound.
const MaxBodyBytes = 8 << 20 // 8 MiB

// requestTimeout bounds one push. Short on purpose: a delivery is worth very
// little by the time it is seconds late, and the replay outbox is already the
// durable copy, so waiting is worse than giving up and moving on.
const requestTimeout = 5 * time.Second

// Delivery is one event addressed to one user.
type Delivery struct {
	UserID string `json:"userId"`
	// Payload is the event JSON, forwarded to the socket verbatim. RawMessage
	// rather than []byte so it rides the wire as embedded JSON instead of a
	// base64 blob — the gateway does not parse it, and a readable body is worth
	// a great deal when debugging a delivery that did not arrive.
	Payload json.RawMessage `json:"payload"`
}

// Batch is the request body: everything bound for one node.
//
// Two shapes, because the traffic has two shapes. `Deliveries` pairs a distinct
// payload with each recipient, which is what fan-out and RTC signalling need.
// `Broadcast` sends ONE payload to many recipients, which is what a presence
// transition is — and expressing it as N deliveries would put N copies of the
// same forty-byte event on the wire. For an organisation of ten thousand that
// is the difference between a megabyte and a few hundred kilobytes per node.
//
// Exactly one should be set. A batch carrying both is honoured rather than
// rejected — the receiver applies each in turn — because a partially-populated
// request is a caller bug worth tolerating, not worth dropping deliveries over.
type Batch struct {
	Deliveries []Delivery `json:"deliveries,omitempty"`
	Broadcast  *Broadcast `json:"broadcast,omitempty"`
}

// Broadcast is one payload addressed to several users on the same node.
type Broadcast struct {
	UserIDs []string        `json:"userIds"`
	Payload json.RawMessage `json:"payload"`
}

// Result is the response body.
type Result struct {
	// Accepted is how many deliveries were enqueued to a live local socket.
	// Fewer than were sent is normal and not an error — a user can disconnect
	// between the presence lookup and the push landing.
	Accepted int `json:"accepted"`
	// Missing is how many named a user this node no longer holds. A steady
	// non-zero here means the routing table is lagging reality, which is worth
	// knowing; an occasional one is just a client that closed its laptop.
	Missing int `json:"missing"`
}

// Client sends pushes to gateway nodes.
type Client struct {
	token  string
	caller string
	http   *http.Client
	// signKey is this caller's Ed25519 private key, set only when a signed
	// credential has been configured for this process (see
	// NewSignedClient). Nil means the legacy shared-token+header-only path
	// is used — see svcjwt.go for why both paths exist.
	signKey ed25519.PrivateKey
}

// NewClient builds a push client that authenticates with the legacy shared
// token plus a self-asserted X-Internal-Caller header only.
//
// caller must be one of the CallerHeader constants above — it is stamped on
// every request this client sends, so the receiving handlePush can enforce
// which batch shape that caller is allowed to post. Passing anything else
// does not fail here (that would need every construction site to handle an
// error for what is, today, a fixed set of two in-repo callers); it simply
// means every push this client makes will be rejected server-side, which is
// the fail-closed behaviour the task calls for.
//
// Prefer NewSignedClient wherever a signing key has been provisioned for
// this process — see svcjwt.go. This constructor remains for processes that
// have not yet been given one, so the shared-token path keeps working
// unchanged during migration.
//
// The transport is tuned for a small set of long-lived peers — one entry per
// gateway pod — rather than for many short-lived ones. Without raising the
// per-host idle limit from Go's default of 2, a fleet of gateways would see
// connections opened and torn down constantly under exactly the load that most
// needs them kept warm.
func NewClient(token, caller string) *Client {
	return &Client{token: token, caller: caller, http: newPushHTTPClient()}
}

// NewSignedClient builds a push client that, in addition to the legacy
// shared token and caller header, signs every request with a short-lived JWT
// under signKey — the cryptographically verifiable credential handlePush
// treats as authoritative when present (see internal/server/push.go). caller
// is still sent (and still stamped into the token's `sub` as a hint for
// logs) but is no longer the thing authorization decisions are made on.
func NewSignedClient(token, caller string, signKey ed25519.PrivateKey) *Client {
	return &Client{token: token, caller: caller, http: newPushHTTPClient(), signKey: signKey}
}

// NewClientFromConfig builds the right kind of client for a signingKeyB64
// value straight from config.Config.PushSigningKey: NewSignedClient when
// it's set, NewClient (legacy) when it's empty. Centralizes the "is a key
// configured" branch so both cmd/delivery-svc and cmd/ws-gateway (separate
// `main` packages that cannot share an unexported helper) make the same
// decision the same way.
func NewClientFromConfig(token, caller, signingKeyB64 string) (*Client, error) {
	if signingKeyB64 == "" {
		return NewClient(token, caller), nil
	}
	priv, err := ParseEd25519PrivateKey(signingKeyB64)
	if err != nil {
		return nil, err
	}
	return NewSignedClient(token, caller, priv), nil
}

func newPushHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = 32
	tr.IdleConnTimeout = 90 * time.Second
	return &http.Client{Transport: tr, Timeout: requestTimeout}
}

// Push sends one batch to one node. addr is a base URL, e.g. http://10.1.2.3:8080.
//
// A failure here is reported but never fatal to the caller: every delivery has
// already been written to the recipient's replay outbox, so a push that does
// not land is recovered when the client reconnects. That is the same
// at-least-once contract the broadcast path has always had.
func (c *Client) Push(ctx context.Context, addr string, deliveries []Delivery) (Result, error) {
	if len(deliveries) == 0 {
		return Result{}, nil
	}
	return c.SendTo(ctx, addr, Batch{Deliveries: deliveries})
}

// SendTo posts one batch to one node, in whichever shape it carries.
//
// Named SendTo rather than Send so that *Client does NOT structurally satisfy
// Transport. The two signatures were once identical — (context, string, Batch)
// — differing only in what the string MEANS: an address here, a node id there.
// Go matched them anyway, so wiring a raw *Client in where an HTTPTransport
// belonged compiled cleanly and then posted every cross-node delivery to a URL
// built from a node id. That is exactly what cmd/ws-gateway/main.go did, and it
// silently broke RTC signalling and presence across a multi-node fleet. The
// name is the guard: that mistake is now a compile error.
func (c *Client) SendTo(ctx context.Context, addr string, batch Batch) (Result, error) {
	var out Result
	count := len(batch.Deliveries)
	if batch.Broadcast != nil {
		count += len(batch.Broadcast.UserIDs)
	}
	if count == 0 {
		return out, nil
	}
	body, err := json.Marshal(batch)
	if err != nil {
		return out, fmt.Errorf("push: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, addr+Path, bytes.NewReader(body))
	if err != nil {
		return out, fmt.Errorf("push: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(TokenHeader, c.token)
	req.Header.Set(CallerHeader, c.caller)
	if c.signKey != nil {
		// Minted fresh per request rather than cached — see pushJWTTTL's doc
		// comment. A signing failure here means a misconfigured key
		// (wrong length, etc.); fail this push rather than silently sending
		// it unsigned and falling back to the legacy path the server may no
		// longer fully trust.
		jwtStr, err := MintPushJWT(c.caller, c.signKey)
		if err != nil {
			return Result{}, fmt.Errorf("push: mint credential: %w", err)
		}
		req.Header.Set(PushJWTHeader, jwtStr)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return out, fmt.Errorf("push to %s: %w", addr, err)
	}
	defer func() {
		// Drain before closing so the connection returns to the idle pool
		// instead of being discarded — the whole point of keeping them warm.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("push to %s: status %d", addr, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		// The deliveries landed; only the accounting did not. Assume the whole
		// batch rather than turning a successful push into a failure — a
		// retry here would duplicate deliveries that already arrived.
		return Result{Accepted: count}, nil
	}
	return out, nil
}
