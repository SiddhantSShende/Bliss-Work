package api

import (
	"encoding/json"
	"net/http"
)

type internalHydrateReq struct {
	MessageIDs []string `json:"messageIds"`
}

// hydrateMessageResp is the wire shape ws-gateway rebuilds a message.created
// event from — everything EXCEPT eventId (which ws-gateway already holds
// from the compact Redis reference and must preserve verbatim for client
// dedup, not regenerate — see docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md
// section H).
//
// orgId and clientMsgId ARE needed: the client validates every frame against
// its ServerEvent schema, which requires both, and drops a frame that fails —
// so a rebuilt message.created without them never reached the app. (An earlier
// note here held that no client used them; the schema says otherwise.)
type hydrateMessageResp struct {
	OrgID           string `json:"orgId"`
	ClientMsgID     string `json:"clientMsgId"`
	MessageID       string `json:"messageId"`
	ConversationID  string `json:"conversationId"`
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

// maxHydrateBatch mirrors the existing 256-id cap on /internal/messages/delivered
// (internal_delivery.go) — the same batch-size ws-gateway already uses for its
// outbound flushes elsewhere.
const maxHydrateBatch = 256

// hydrateMessages serves POST /internal/messages/hydrate. ws-gateway calls
// this on a reconnecting client's replay batch to turn any compact
// {eventId, messageId} outbox references into full message.created content
// before anything reaches a socket — the client-facing wire contract never
// changes. An id that doesn't resolve (deleted, or simply stale) is absent
// from the response map; ws-gateway skips it rather than erroring the whole
// replay (the same "at-least-once, tolerate a gap" posture the outbox and
// REST-backfill paths already have).
//
// Auth: shared X-Internal-Token, same as markDelivered.
func (s *Server) hydrateMessages(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	var req internalHydrateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.MessageIDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]hydrateMessageResp{})
		return
	}
	if len(req.MessageIDs) > maxHydrateBatch {
		req.MessageIDs = req.MessageIDs[:maxHydrateBatch]
	}
	for _, id := range req.MessageIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "invalid messageId in batch")
			return
		}
	}

	hydrated, err := s.store.HydrateMessages(r.Context(), req.MessageIDs)
	if err != nil {
		s.mapErr(w, err)
		return
	}

	out := make(map[string]hydrateMessageResp, len(hydrated))
	for id, m := range hydrated {
		out[id] = hydrateMessageResp{
			OrgID:           m.OrgID,
			ClientMsgID:     m.ClientMsgID,
			MessageID:       m.MessageID,
			ConversationID:  m.ConversationID,
			ThreadID:        m.ThreadID,
			ParentMessageID: m.ParentMessageID,
			IsThreadRoot:    m.IsThreadRoot,
			Seq:             m.Seq,
			SenderID:        m.SenderID,
			RecipientID:     m.RecipientID,
			Body:            m.Body,
			OccurredAt:      m.OccurredAt,
			Kind:            m.Kind,
			Origin:          m.Origin,
			ReplyToID:       m.ReplyToID,
			IsForward:       m.IsForward,
			ForwardPlatform: m.ForwardPlatform,
		}
	}
	writeJSON(w, http.StatusOK, out)
}
