package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// channelRoster serves GET /channels/{id}/members/roster?limit=&offset= — the
// member list WITH roles, plus anyone blocked.
//
// A NEW endpoint rather than a change to GET /channels/{id}/members, which
// returns a bare []string and is consumed by the task dialog to expand a channel
// into assignee ids. Changing that response shape to add roles would break task
// allocation for a cosmetic gain; adding a route costs nothing.
//
// Paged via the same ?limit=&offset= pair as GET /channels/open — see
// pageOffsetParams. Both parameters are clamped again in the store; see
// ChannelRoster.
func (s *Server) channelRoster(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	limit, offset := pageOffsetParams(r)
	members, err := s.store.ChannelRoster(r.Context(), claims.OrgID, channelID, claims.UserID, claims.Roles, limit, offset)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// kickChannelMember serves DELETE /channels/{id}/members/{userId}.
func (s *Server) kickChannelMember(w http.ResponseWriter, r *http.Request) {
	claims, channelID, targetID, ok := s.moderationParams(w, r)
	if !ok {
		return
	}
	if err := s.store.KickChannelMember(
		r.Context(), claims.OrgID, channelID, claims.UserID, targetID, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type roleReq struct {
	Role string `json:"role"`
}

// setChannelRole serves PATCH /channels/{id}/members/{userId}.
func (s *Server) setChannelRole(w http.ResponseWriter, r *http.Request) {
	claims, channelID, targetID, ok := s.moderationParams(w, r)
	if !ok {
		return
	}
	var req roleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.store.SetChannelMemberRole(
		r.Context(), claims.OrgID, channelID, claims.UserID, targetID, req.Role, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type blockReq struct {
	Reason string `json:"reason"`
}

// blockChannelMember serves POST /channels/{id}/blocks/{userId}.
func (s *Server) blockChannelMember(w http.ResponseWriter, r *http.Request) {
	claims, channelID, targetID, ok := s.moderationParams(w, r)
	if !ok {
		return
	}
	var req blockReq
	// A body is optional here — a block with no stated reason is ordinary.
	_ = json.NewDecoder(r.Body).Decode(&req)
	if len(req.Reason) > 280 {
		req.Reason = req.Reason[:280]
	}
	if err := s.store.BlockFromChannel(
		r.Context(), claims.OrgID, channelID, claims.UserID, targetID, req.Reason, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unblockChannelMember serves DELETE /channels/{id}/blocks/{userId}.
func (s *Server) unblockChannelMember(w http.ResponseWriter, r *http.Request) {
	claims, channelID, targetID, ok := s.moderationParams(w, r)
	if !ok {
		return
	}
	if err := s.store.UnblockFromChannel(
		r.Context(), claims.OrgID, channelID, claims.UserID, targetID, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// moderationParams validates the two path ids every moderation route shares.
func (s *Server) moderationParams(
	w http.ResponseWriter, r *http.Request,
) (*auth.Claims, string, string, bool) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	targetID := chi.URLParam(r, "userId")
	if !validUUID(channelID) || !validUUID(targetID) {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return nil, "", "", false
	}
	return claims, channelID, targetID, true
}
