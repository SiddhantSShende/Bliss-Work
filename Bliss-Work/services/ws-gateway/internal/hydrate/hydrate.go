// Package hydrate reconstructs full message.created events from the compact
// {eventId, messageId} reference contract.TryCompact may store in the Redis
// replay outbox instead of the full JSON payload — see
// docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md sections H/R/S. The client wire
// contract is unchanged: every entry Hydrate returns is full JSON, identical
// in shape to what live delivery already sends.
package hydrate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/task-board/shared-backoff"
	"github.com/task-board/ws-gateway/internal/contract"
)

// httpTimeout bounds the one hydrate call a reconnect's replay burst may
// make. Mirrors internal/delivery's per-attempt timeout — this is a
// best-effort reconstruction step, not worth blocking a hello over.
const httpTimeout = 5 * time.Second

// maxBatch mirrors messaging-svc's own cap on this endpoint
// (internal_hydrate.go's maxHydrateBatch) and the existing 256-id convention
// used elsewhere in this codebase (delivery.go, internal_delivery.go).
const maxBatch = 256

// fetchMaxAttempts is how many times one hydrate call is tried (1 initial + 2
// retries) before the failure is reported to the caller. Bounded, because the
// caller is a websocket handshake: a client is waiting on `replay.done`.
const fetchMaxAttempts = 3

// fetchRetryPolicy paces those attempts. Short and capped: it sits inside a
// reconnect, and a reconnect storm (exactly when this endpoint is most likely
// to fail) must not be turned into a longer one. Jittered by shared/backoff so
// the storm does not retry in lockstep. A var so tests can shrink it.
var fetchRetryPolicy = backoff.Policy{Base: 100 * time.Millisecond, Max: time.Second}

// Hydrator calls messaging-svc's internal hydrate endpoint.
type Hydrator struct {
	baseURL string
	token   string
	client  *http.Client
	log     *slog.Logger
}

// New constructs a Hydrator. baseURL/token are the same messaging-svc
// internal base URL and shared secret ws-gateway already uses for its
// delivery-ack dispatcher (cfg.MessagingBaseInternal / MessagingInternalToken).
func New(baseURL, token string, log *slog.Logger) *Hydrator {
	return &Hydrator{
		baseURL: baseURL,
		token:   token,
		client:  &http.Client{Timeout: httpTimeout},
		log:     log,
	}
}

type hydrateReq struct {
	MessageIDs []string `json:"messageIds"`
}

// wireMessageCreated mirrors messaging-svc's hydrateMessageResp field-for-
// field (internal_hydrate.go), plus the type/eventId this package re-embeds
// itself — eventId comes from the Redis reference, NEVER from messaging-svc,
// since it must be preserved verbatim for the client's existing eventId
// dedup (see docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md section H).
type wireMessageCreated struct {
	Type    string `json:"type"`
	EventID string `json:"eventId"`
	// OrgID and ClientMsgID are REQUIRED by the client's ServerEvent schema
	// (the envelope's orgId, and MessageCreated's clientMsgId): a frame missing
	// either fails validation and is dropped, so this replay entry would vanish.
	OrgID           string `json:"orgId"`
	ClientMsgID     string `json:"clientMsgId"`
	ConversationID  string `json:"conversationId"`
	MessageID       string `json:"messageId"`
	ThreadID        string `json:"threadId,omitempty"`
	ParentMessageID string `json:"parentMessageId,omitempty"`
	IsThreadRoot    bool   `json:"isThreadRoot"`
	Seq             int64  `json:"seq"`
	SenderID        string `json:"senderId"`
	RecipientID     string `json:"recipientId"`
	Body            string `json:"body"`
	OccurredAt      string `json:"occurredAt"`
	Kind            string `json:"kind,omitempty"`
	Origin          string `json:"origin,omitempty"`
	ReplyToID       string `json:"replyToId,omitempty"`
	IsForward       bool   `json:"isForward,omitempty"`
	ForwardPlatform string `json:"forwardPlatform,omitempty"`
}

// Hydrate returns entries with every compact reference swapped for its full
// JSON reconstruction, in the SAME order, with non-reference entries passed
// through untouched.
//
// An id messaging-svc answered for but did not return (the message no longer
// exists) is dropped from the result: that is a permanent fact about the
// message, and the same posture as an entry the outbox trim/TTL already drops.
//
// A FAILURE OF THE HYDRATE CALL ITSELF (timeout, 5xx, network error — after
// bounded retries) is different, and is returned as an error with nil entries.
// It used to drop every compact entry from the burst and carry on, which looked
// like an empty catch-up: the caller sent `replay.done`, and the client — whose
// cursor advances to the newest event it sees, replayed or live — never asked
// for those messages again. That happens exactly during a reconnect storm, when
// this endpoint is most likely to be struggling. The caller must not complete the
// replay on error; the entries are still in the Redis outbox for the next
// attempt.
func (h *Hydrator) Hydrate(ctx context.Context, entries [][]byte) ([][]byte, error) {
	var refIDs []string
	for _, e := range entries {
		if _, mid, ok := contract.DecodeCompactRef(e); ok {
			refIDs = append(refIDs, mid)
		}
	}
	if len(refIDs) == 0 {
		return entries, nil
	}

	resolved := make(map[string]wireMessageCreated, len(refIDs))
	// Chunked to messaging-svc's cap. A single reconnect's burst is already
	// bounded by maxReplayHard (100), so this is one call in practice; chunking
	// rather than truncating means a larger burst can never silently lose its tail.
	for start := 0; start < len(refIDs); start += maxBatch {
		end := min(start+maxBatch, len(refIDs))
		got, err := h.fetchWithRetry(ctx, refIDs[start:end])
		if err != nil {
			return nil, err
		}
		for id, m := range got {
			resolved[id] = m
		}
	}

	out := make([][]byte, 0, len(entries))
	for _, e := range entries {
		eid, mid, ok := contract.DecodeCompactRef(e)
		if !ok {
			out = append(out, e)
			continue
		}
		m, ok := resolved[mid]
		if !ok {
			// messaging-svc answered but has no such message (deleted/purged):
			// nothing to replay, REST backfill remains available.
			continue
		}
		m.Type = "message.created"
		m.EventID = eid
		raw, err := json.Marshal(m)
		if err != nil {
			continue
		}
		out = append(out, raw)
	}
	return out, nil
}

// fetchWithRetry is fetch with up to fetchMaxAttempts tries and jittered
// backoff between them. It gives up early, with the context's error, when ctx
// is cancelled (the socket went away), so a closing connection never sits in a
// retry loop.
func (h *Hydrator) fetchWithRetry(ctx context.Context, ids []string) (map[string]wireMessageCreated, error) {
	var err error
	for attempt := 1; attempt <= fetchMaxAttempts; attempt++ {
		var got map[string]wireMessageCreated
		if got, err = h.fetch(ctx, ids); err == nil {
			return got, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		h.log.Warn("hydrate call failed", "attempt", attempt, "of", fetchMaxAttempts, "count", len(ids), "err", err)
		if attempt == fetchMaxAttempts || !fetchRetryPolicy.Sleep(ctx.Done(), attempt) {
			break
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return nil, fmt.Errorf("hydrate failed after %d attempts: %w", fetchMaxAttempts, err)
}

func (h *Hydrator) fetch(ctx context.Context, messageIDs []string) (map[string]wireMessageCreated, error) {
	payload, err := json.Marshal(hydrateReq{MessageIDs: messageIDs})
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("%s/internal/messages/hydrate", h.baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.token != "" {
		req.Header.Set("X-Internal-Token", h.token)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("hydrate non-2xx: status %d", resp.StatusCode)
	}
	var out map[string]wireMessageCreated
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}
