package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/store"
)

type createChannelReq struct {
	Name      string   `json:"name"`
	IsLocked  bool     `json:"isLocked"`
	MemberIDs []string `json:"memberIds"`
}

type renameChannelReq struct {
	Name string `json:"name"`
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

func (s *Server) renameChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var req renameChannelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 120 {
		writeErr(w, http.StatusBadRequest, "name must be between 1 and 120 characters")
		return
	}
	dto, err := s.store.RenameChannel(r.Context(), claims.OrgID, channelID, claims.UserID, claims.Roles, name)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.store.DeleteChannel(r.Context(), claims.OrgID, channelID, claims.UserID, claims.Roles); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listOpenChannels serves GET /api/v1/channels/open — the directory of open
// channels in the caller's org they could join right now (and aren't already
// in). UI surface: a Browse Channels view in the sidebar.
//
// Paged via ?limit=&offset=. The population is every open channel in the
// organisation, so this is one of the few reads whose size is set by how big
// the customer is; an unpaged version returned all of them and decrypted each
// one. Both parameters are clamped again in the store — see ListOpenChannels.
func (s *Server) listOpenChannels(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	limit, offset := pageOffsetParams(r, DefaultChannelPageSize, MaxChannelPageSize)
	chans, err := s.store.ListOpenChannels(r.Context(), claims.OrgID, claims.UserID, limit, offset)
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

// clearChannel hides every message in the channel for this caller only.
func (s *Server) clearChannel(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.store.ClearChannel(r.Context(), claims.OrgID, channelID, claims.UserID); err != nil {
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

// listChannelMessages serves GET /api/v1/channels/{id}/messages?beforeSeq=&limit=.
//
// Same keyset contract as the conversation endpoint. This one mattered more:
// a conversation's history was re-read by two people, a channel's by every
// member on every open.
func (s *Server) listChannelMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	beforeSeq, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	msgs, err := s.store.ChannelMessages(r.Context(), claims.OrgID, channelID, claims.UserID, beforeSeq, limit)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

type sendChannelMsgReq struct {
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
	// Optional system kind (e.g. "screenshot_attempt"); absent means an
	// ordinary message. Whitelisted below, same as sendMessage's Kind.
	Kind string `json:"kind"`
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
	if !validMessageBody(req.Body) {
		writeErr(w, http.StatusBadRequest, errBodyTooLong)
		return
	}
	if req.Kind != "" && !store.ValidMessageKind(req.Kind) {
		writeErr(w, http.StatusBadRequest, "unknown message kind")
		return
	}
	res, err := s.store.SendChannelMessage(r.Context(), claims.OrgID, channelID, claims.UserID, req.Body, req.ClientMsgID, req.Kind)
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
