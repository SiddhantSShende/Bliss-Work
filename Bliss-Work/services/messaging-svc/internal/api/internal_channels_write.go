package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/store"
)

type internalCreateChannelReq struct {
	OrgID     string   `json:"orgId"`
	Name      string   `json:"name"`
	IsLocked  bool     `json:"isLocked"`
	CreatorID string   `json:"creatorId"`
	MemberIDs []string `json:"memberIds"`
}

type internalAddChannelMembersReq struct {
	OrgID     string   `json:"orgId"`
	MemberIDs []string `json:"memberIds"`
	ActorID   string   `json:"actorId"`
}

func (s *Server) internalCreateChannel(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	var req internalCreateChannelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !validUUID(req.OrgID) || !validUUID(req.CreatorID) {
		writeErr(w, http.StatusBadRequest, "orgId and creatorId must be uuids")
		return
	}
	if req.Name == "" || utf8.RuneCountInString(req.Name) > 200 {
		writeErr(w, http.StatusBadRequest, "name must be between 1 and 200 characters")
		return
	}
	if len(req.MemberIDs) > maxCreateChannelMembers {
		writeErr(w, http.StatusBadRequest, "too many initial channel members")
		return
	}
	for _, id := range req.MemberIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "memberIds must be uuids")
			return
		}
	}

	channel, err := s.store.CreateChannel(
		r.Context(), req.OrgID, req.CreatorID, req.Name, req.IsLocked, req.MemberIDs,
	)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"channelId": channel.ID})
}

func (s *Server) internalAddChannelMembers(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var req internalAddChannelMembersReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.OrgID) || !validUUID(req.ActorID) {
		writeErr(w, http.StatusBadRequest, "orgId and actorId must be uuids")
		return
	}
	if len(req.MemberIDs) > maxAddChannelMembersPerRequest {
		writeErr(w, http.StatusBadRequest, "too many channel members")
		return
	}
	for _, id := range req.MemberIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "memberIds must be uuids")
			return
		}
	}

	// task-svc calls this only with a project channel it resolved itself; it
	// must never forward a client-supplied channel id. Its task permissions are
	// the authorization boundary for adding these assignees.
	if err := s.store.AddChannelMembersInternal(
		r.Context(), req.OrgID, channelID, req.ActorID, req.MemberIDs,
	); err != nil {
		if errors.Is(err, store.ErrForbidden) {
			writeErr(w, http.StatusNotFound, "channel not found")
			return
		}
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
