package api

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/store"
	"github.com/task-board/shared-internalauth"
)

// internalToken is sourced once at startup; mounted on the internal-only
// route via internalAuthMiddleware. THIS SERVICE'S OWN secret — not shared
// with any other service's callees — via the MESSAGING_INTERNAL_TOKEN env
// var. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 2: every service now
// has a distinct per-callee secret rather than one token shared
// platform-wide (previously TB_INTERNAL_TOKEN).
var internalToken = os.Getenv("MESSAGING_INTERNAL_TOKEN")

// internalAuthOK validates the X-Internal-Token header. FAIL CLOSED: if the
// shared secret is not configured the endpoint rejects every caller (rather than
// accepting all). Constant-time compare (via the shared internalauth package,
// so every service's /internal/* check is byte-for-byte the same comparison)
// avoids leaking the token via timing.
func internalAuthOK(r *http.Request) bool {
	got := r.Header.Get("X-Internal-Token")
	return internalauth.Matches(got, internalToken)
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
// Auth: shared X-Internal-Token, same as markDelivered, PLUS an explicit
// orgId + callerId (the end user who is creating the task) so this endpoint
// can verify that user is actually a member of the channel — task-svc has no
// channel_members table of its own to check that against. Without this,
// any org member could pass ANY channel id, including a private/locked one
// they never joined, and get a task fanned out to its whole membership; see
// docs/AUTH_AUTHZ_REMEDIATION_PLAN.md.
type internalChannelMembersResp struct {
	OrgID     string   `json:"orgId"`
	ChannelID string   `json:"channelId"`
	Name      string   `json:"name"`
	IsLocked  bool     `json:"isLocked"`
	MemberIDs []string `json:"memberIds"`
}

func (s *Server) internalChannelMembers(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	channelID := chi.URLParam(r, "id")
	orgID := r.URL.Query().Get("orgId")
	callerID := r.URL.Query().Get("callerId")
	if !validUUID(channelID) || !validUUID(orgID) || !validUUID(callerID) {
		writeErr(w, http.StatusBadRequest, "channel id, orgId and callerId are required")
		return
	}
	resp, err := s.store.InternalChannelMembership(r.Context(), orgID, channelID, callerID)
	if err != nil {
		if err == store.ErrForbidden {
			// Same response whether the channel doesn't exist, belongs to a
			// different org, or callerId isn't a member of it — a caller
			// with a valid internal token still shouldn't learn which case.
			writeErr(w, http.StatusNotFound, "channel not found")
			return
		}
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, internalChannelMembersResp{
		OrgID:     resp.OrgID,
		ChannelID: channelID,
		Name:      resp.Name,
		IsLocked:  resp.IsLocked,
		MemberIDs: resp.MemberIDs,
	})
}
