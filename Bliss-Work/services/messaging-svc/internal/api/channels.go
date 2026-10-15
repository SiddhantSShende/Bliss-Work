package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// Per-request ceilings on memberIds, enforced as a 400 before any work is done.
//
// Adding is the expensive one: each newly-added member gets their own
// ChannelMessageCreated system message, and every one of those events carries
// the channel's whole roster (up to store.maxChannelFanout ids) so ws-gateway
// can route it. K added to an M-member channel therefore costs K x M ids in one
// transaction. 500 is the "add a whole department" case the store was built for
// (see AddChannelMembers) and keeps that product bounded; a larger group is
// added in several requests.
//
// Creating is cheaper — the initial members share ONE system message naming them
// all — so it takes more, bounded mainly by that message's body.
const (
	maxAddChannelMembersPerRequest = 500
	maxCreateChannelMembers        = 2000
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
	if len(req.MemberIDs) > maxCreateChannelMembers {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("memberIds: at most %d per request", maxCreateChannelMembers))
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
	unreferencedSHAs, err := s.store.DeleteChannel(r.Context(), claims.OrgID, channelID, claims.UserID, claims.Roles)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	for _, sha := range unreferencedSHAs {
		if rerr := s.blobs.Remove(claims.OrgID, sha); rerr != nil {
			// The rows are already gone, so the content is unreachable either way
			// and the channel deletion succeeded. Logged rather than surfaced —
			// see removeDraftAttachment's identical reasoning in mail.go.
			s.log.Error("channel attachment blob unlink failed", "channel_id", channelID,
				"sha256", sha, "err", rerr, "request_id", mw.RequestIDFromContext(r.Context()))
		}
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
	limit, offset := pageOffsetParams(r)
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
		// mapErrR, not mapErr: see reply()'s own comment on the same swap —
		// carries r so a 403 here logs its route/request_id too. No other
		// effect; the response is identical either way.
		s.mapErrR(w, r, err)
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
	// Message being quoted, if any. Mirrors sendReq/replyReq's ReplyToID.
	ReplyToID string `json:"replyToId"`
	// Required when Kind is "attachment_opened"/"attachment_downloaded".
	// Mirrors sendReq's AttachmentID — see its doc comment.
	AttachmentID string `json:"attachmentId"`
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
	if req.ReplyToID != "" && !validUUID(req.ReplyToID) {
		writeErr(w, http.StatusBadRequest, "invalid replyToId")
		return
	}
	isAttachmentActivity := req.Kind == store.MessageKindAttachmentOpened || req.Kind == store.MessageKindAttachmentDownloaded
	if isAttachmentActivity && !validUUID(req.AttachmentID) {
		writeErr(w, http.StatusBadRequest, "attachmentId required")
		return
	}
	res, err := s.store.SendChannelMessage(r.Context(), claims.OrgID, channelID, claims.UserID, req.Body, req.ClientMsgID, req.Kind, req.ReplyToID, req.AttachmentID)
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
	if len(req.MemberIDs) > maxAddChannelMembersPerRequest {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("memberIds: at most %d per request", maxAddChannelMembersPerRequest))
		return
	}
	for _, id := range req.MemberIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "memberIds must be uuids")
			return
		}
	}
	if err := s.store.AddChannelMembers(r.Context(), claims.OrgID, channelID, claims.UserID, claims.Roles, req.MemberIDs); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
