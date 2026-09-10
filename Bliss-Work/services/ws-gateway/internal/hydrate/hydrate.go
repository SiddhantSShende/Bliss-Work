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
	Type            string `json:"type"`
	EventID         string `json:"eventId"`
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
// through untouched. An id messaging-svc could not resolve, or any failure
// of the hydrate call itself (timeout, 5xx, network error), simply drops
// that one entry from the result rather than failing the whole replay burst
// — the same "at-least-once, tolerate a gap" posture the rest of this
// pipeline already has (a dropped entry here is no worse than one the
// existing maxReplayHard trim or TTL expiry already silently drops, and the
// same REST-backfill path remains available).
func (h *Hydrator) Hydrate(ctx context.Context, entries [][]byte) [][]byte {
	var refIDs []string
	for _, e := range entries {
		if _, mid, ok := contract.DecodeCompactRef(e); ok {
			refIDs = append(refIDs, mid)
		}
	}
	if len(refIDs) == 0 {
		return entries
	}
	if len(refIDs) > maxBatch {
		// A single reconnect's replay burst is already bounded by
		// maxReplayHard (100); this is defense-in-depth, not an expected path.
		refIDs = refIDs[:maxBatch]
	}

	resolved, err := h.fetch(ctx, refIDs)
	if err != nil {
		h.log.Warn("hydrate call failed; affected replay entries dropped", "count", len(refIDs), "err", err)
		resolved = nil
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
			// Not resolved (missing, or the fetch failed outright) — dropped,
			// same posture as an entry the trim/TTL already silently drops;
			// REST backfill remains available.
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
	return out
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
