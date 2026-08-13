package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

type createChannelReq struct {
	Name      string   `json:"name"`
	IsLocked  bool     `json:"isLocked"`
	MemberIDs []string `json:"memberIds"`
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req createChannelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	for _, id := range req.MemberIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "memberIds must be uuids")
			return
		}
	}
	dto, err := s.store.CreateChannel(r.Context(), claims.OrgID, claims.UserID, req.Name, req.IsLocked, req.MemberIDs)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, dto)
}

// listOpenChannels serves GET /api/v1/channels/open — the directory of open
// channels in the caller's org they could join right now (and aren't already
// in). UI surface: a Browse Channels view in the sidebar.
func (s *Server) listOpenChannels(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	chans, err := s.store.ListOpenChannels(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chans)
}

// joinChannel serves POST /api/v1/channels/{id}/join. Open channels only;
// locked channels respond 403 (the caller needs an explicit invite via
// /channels/{id}/members from a current member).
func (s *Server) joinChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.store.JoinChannel(r.Context(), claims.OrgID, channelID, claims.UserID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listChannelMembers serves GET /api/v1/channels/{id}/members — the user ids
// of every current member. Used by the task creation dialog when the user
// chooses "Assign to a channel": the client expands the channel into the
// underlying assigneeIds list and submits a normal multi-assignee task.
func (s *Server) listChannelMembers(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	ids, err := s.store.ChannelMemberIDs(r.Context(), claims.OrgID, channelID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ids)
}

// leaveChannel serves POST /api/v1/channels/{id}/leave. Idempotent — leaving
// a channel the caller already left returns 204 (no audit row written).
func (s *Server) leaveChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.store.LeaveChannel(r.Context(), claims.OrgID, channelID, claims.UserID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	chans, err := s.store.ListChannels(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chans)
}

func (s *Server) listChannelMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	msgs, err := s.store.ChannelMessages(r.Context(), claims.OrgID, channelID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

type sendChannelMsgReq struct {
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
}

func (s *Server) sendChannelMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var req sendChannelMsgReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Body == "" || !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "body, clientMsgId required")
		return
	}
	res, err := s.store.SendChannelMessage(r.Context(), claims.OrgID, channelID, claims.UserID, req.Body, req.ClientMsgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

type addMembersReq struct {
	MemberIDs []string `json:"memberIds"`
}

func (s *Server) addChannelMembers(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var req addMembersReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	for _, id := range req.MemberIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "memberIds must be uuids")
			return
		}
	}
	if err := s.store.AddChannelMembers(r.Context(), claims.OrgID, channelID, claims.UserID, req.MemberIDs); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
