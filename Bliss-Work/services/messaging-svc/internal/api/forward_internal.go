package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/store"
)

type forwardReq struct {
	// TargetKind is "user" (their 1:1 chat) or "channel".
	TargetKind  string `json:"targetKind"`
	TargetID    string `json:"targetId"`
	ClientMsgID string `json:"clientMsgId"`
}

type forwardResp struct {
	MessageID      string `json:"messageId"`
	ConversationID string `json:"conversationId,omitempty"`
	ChannelID      string `json:"channelId,omitempty"`
	Delivery       string `json:"delivery"`
}

// forwardMessage serves POST /api/v1/messages/{id}/forward — deliver a message
// to another chat or channel in this workspace.
//
// Unlike its deep-link sibling this one actually SENDS: the clone is written to
// the destination, its files are re-scoped so the recipient can open them, and
// the provenance edge is written in the same transaction. Hence delivery
// "confirmed" — the message is in this database and we watched it land.
//
// Every gate is applied server-side by the store: the caller must be able to
// read the source, must be a member of the destination (and not blocked in it),
// and must be able to read each attachment being re-scoped. Nothing here trusts
// the client beyond the shape of these three fields.
func (s *Server) forwardMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid message id")
		return
	}
	var req forwardReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	if req.TargetKind != store.ForwardTargetUser && req.TargetKind != store.ForwardTargetChannel {
		writeErrR(w, r, http.StatusBadRequest, "targetKind must be 'user' or 'channel'")
		return
	}
	if !validUUID(req.TargetID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid targetId")
		return
	}
	// Required, not defaulted server-side: the client's id is what makes a
	// retried forward the same forward. Minting one here would deliver the
	// message twice to anyone whose connection dropped mid-request.
	if !validUUID(req.ClientMsgID) {
		writeErrR(w, r, http.StatusBadRequest, "clientMsgId required")
		return
	}

	res, err := s.store.ForwardMessage(r.Context(), claims.OrgID, claims.UserID, msgID,
		store.ForwardTarget{Kind: req.TargetKind, ID: req.TargetID}, req.ClientMsgID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, forwardResp{
		MessageID:      res.MessageID,
		ConversationID: res.ConversationID,
		ChannelID:      res.ChannelID,
		Delivery:       "confirmed",
	})
}
