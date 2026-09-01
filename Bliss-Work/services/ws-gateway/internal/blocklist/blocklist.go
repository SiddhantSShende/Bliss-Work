// Package blocklist answers one question for the signaling dispatcher: has
// either side of a 1:1 call blocked the other. It is the actual authorization
// boundary for a call.invite — messaging-svc's CreateDirectCall enforces the
// same rule too, but only on its own best-effort, unawaited call-history
// write, which does not gate delivery of the WebSocket ring itself.
//
// Transport follows the repository's one internal-service convention (see
// push.Client's doc comment): a synchronous GET carrying an X-Internal-Token
// header, against messaging-svc's /internal/calls/blocked.
//
// ── Why synchronous and not batched like delivery.Dispatcher ────────────────
// delivery.Dispatcher exists to turn many small acks into few HTTP calls; a
// block check is the opposite shape. It gates exactly one frame type
// (call.invite), which happens once per call attempt — not once per ICE
// candidate — so there is nothing to batch and the caller (handleCallFrame)
// needs the answer before it can decide whether to forward the frame at all.
package blocklist

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// requestTimeout bounds one lookup. Short and inline on the call.invite path —
// a slow messaging-svc must not hang the gateway's per-connection frame loop
// for long, and the caller (CallInviteAllowed) treats a timeout as "blocked"
// (fail closed), the same convention peerAllowed already uses for a presence
// check that errors.
const requestTimeout = 2 * time.Second

// Client asks messaging-svc whether a pair of org-mates has a block between
// them.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewClient builds a blocklist client. baseURL and token are the same
// TB_MESSAGING_INTERNAL_BASE / MESSAGING_INTERNAL_TOKEN config values
// delivery.Dispatcher already uses to reach messaging-svc — no new
// configuration surface.
func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: requestTimeout},
	}
}

type blockedResp struct {
	Blocked bool `json:"blocked"`
}

// IsBlocked reports whether either userA or userB has blocked the other
// within orgID. Satisfies signal.BlockChecker.
func (c *Client) IsBlocked(ctx context.Context, orgID, userA, userB string) (bool, error) {
	q := url.Values{"orgId": {orgID}, "userA": {userA}, "userB": {userB}}
	reqURL := fmt.Sprintf("%s/internal/calls/blocked?%s", c.baseURL, q.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return false, err
	}
	if c.token != "" {
		req.Header.Set("X-Internal-Token", c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("blocklist check: status %d", resp.StatusCode)
	}

	var body blockedResp
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, err
	}
	return body.Blocked, nil
}
