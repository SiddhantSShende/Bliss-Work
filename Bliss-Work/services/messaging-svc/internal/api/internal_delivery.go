package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/store"
)

// internalToken is sourced once at startup; mounted on the internal-only
// route via internalAuthMiddleware. Pre-shared with ws-gateway via the
// TB_INTERNAL_TOKEN env var so neither side has to depend on JWKS for this
// purely service-to-service path.
var internalToken = os.Getenv("TB_INTERNAL_TOKEN")

// internalAuthOK validates the X-Internal-Token header. FAIL CLOSED: if the
// shared secret is not configured the endpoint rejects every caller (rather than
// accepting all). Constant-time compare avoids leaking the token via timing.
func internalAuthOK(r *http.Request) bool {
	if internalToken == "" {
		return false
	}
	got := r.Header.Get("X-Internal-Token")
	return subtle.ConstantTimeCompare([]byte(got), []byte(internalToken)) == 1
}

type internalDeliveredReq struct {
	RecipientID string   `json:"recipientId"`
	MessageIDs  []string `json:"messageIds"`
}

// markDelivered is the gateway-facing endpoint that records delivery acks.
// Calls Store.MarkDelivered which idempotently upserts message_delivery and
// emits MessageDelivered through the outbox.
//
// Auth: shared-secret header (X-Internal-Token). NOT exposed under /api/v1 —
// the route is `/internal/messages/delivered` which is unreachable through
// the public CORS/JWT-gated chi group.
func (s *Server) markDelivered(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	var req internalDeliveredReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.RecipientID) || len(req.MessageIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "recipientId + messageIds required")
		return
	}
	// Defense-in-depth: cap the batch size at the same number ws-gateway
	// uses for outbound flushes.
	if len(req.MessageIDs) > 256 {
		req.MessageIDs = req.MessageIDs[:256]
	}
	for _, id := range req.MessageIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "invalid messageId in batch")
			return
		}
	}
	if err := s.store.MarkDelivered(r.Context(), req.RecipientID, req.MessageIDs); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// internalChannelMembers serves GET /internal/channels/{id}/members for
// task-svc. It returns the channel's current member user ids + the org id
// so task-svc can fan out a new "task to channel" allocation server-side
// without needing the caller's JWT (the call is service-to-service).
//
// Auth: shared X-Internal-Token, same as markDelivered.
type internalChannelMembersResp struct {
	OrgID     string   `json:"orgId"`
	ChannelID string   `json:"channelId"`
	IsLocked  bool     `json:"isLocked"`
	MemberIDs []string `json:"memberIds"`
}

func (s *Server) internalChannelMembers(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	resp, err := s.store.InternalChannelMembership(r.Context(), channelID)
	if err != nil {
		if err == store.ErrForbidden {
			writeErr(w, http.StatusNotFound, "channel not found")
			return
		}
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, internalChannelMembersResp{
		OrgID:     resp.OrgID,
		ChannelID: channelID,
		IsLocked:  resp.IsLocked,
		MemberIDs: resp.MemberIDs,
	})
}
