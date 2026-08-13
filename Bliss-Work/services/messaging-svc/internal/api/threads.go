package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// getThread serves GET /api/v1/threads/{id} — the thread header used by
// /app/inbox/thread/:id.
func (s *Server) getThread(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	threadID := chi.URLParam(r, "id")
	if !validUUID(threadID) {
		writeErr(w, http.StatusBadRequest, "invalid thread id")
		return
	}
	t, err := s.store.GetThread(r.Context(), claims.OrgID, claims.UserID, threadID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// DefaultThreadPageSize is the server's default page size for the thread
// history endpoint. Small on purpose — at 1B DAU scale, the chattiest path is
// "open a thread"; serving fewer rows per request lets us page-cache more
// efficiently and lets the client render the visible window faster.
const DefaultThreadPageSize = 12

// MaxThreadPageSize caps client-supplied ?limit= values.
const MaxThreadPageSize = 50

// listThreadMessages serves GET /api/v1/threads/{id}/messages?beforeSeq=&limit=.
//
// Reverse-paginated (newest seq first, client reverses for ascending render).
// Default limit 12, cap 50. beforeSeq omitted = from the newest.
func (s *Server) listThreadMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	threadID := chi.URLParam(r, "id")
	if !validUUID(threadID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid thread id")
		return
	}
	beforeSeq := int64(0)
	if v := r.URL.Query().Get("beforeSeq"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			beforeSeq = n
		}
	}
	limit := DefaultThreadPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= MaxThreadPageSize {
			limit = n
		}
	}
	msgs, err := s.store.ListThreadMessages(r.Context(), claims.OrgID, claims.UserID, threadID, beforeSeq, limit)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// threadReplyReq is the request body for POST /threads/{id}/reply.
type threadReplyReq struct {
	Body            string  `json:"body"`
	ClientMsgID     string  `json:"clientMsgId"`
	ParentMessageID *string `json:"parentMessageId"`
}

// replyToThread serves POST /api/v1/threads/{id}/reply.
func (s *Server) replyToThread(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	threadID := chi.URLParam(r, "id")
	if !validUUID(threadID) {
		writeErr(w, http.StatusBadRequest, "invalid thread id")
		return
	}
	var req threadReplyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Body == "" || !validUUID(req.ClientMsgID) {
		writeErr(w, http.StatusBadRequest, "body, clientMsgId required")
		return
	}
	parent := ""
	if req.ParentMessageID != nil {
		if !validUUID(*req.ParentMessageID) {
			writeErr(w, http.StatusBadRequest, "invalid parentMessageId")
			return
		}
		parent = *req.ParentMessageID
	}
	res, err := s.store.ReplyToThread(r.Context(), claims.OrgID, claims.UserID, threadID, parent, req.Body, req.ClientMsgID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// ignoreThread serves POST /api/v1/threads/{id}/ignore. Hides for BOTH members.
func (s *Server) ignoreThread(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	threadID := chi.URLParam(r, "id")
	if !validUUID(threadID) {
		writeErr(w, http.StatusBadRequest, "invalid thread id")
		return
	}
	if err := s.store.IgnoreThread(r.Context(), claims.OrgID, claims.UserID, threadID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// readThread serves POST /api/v1/threads/{id}/read. Body: { upToSeq }.
func (s *Server) readThread(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	threadID := chi.URLParam(r, "id")
	if !validUUID(threadID) {
		writeErr(w, http.StatusBadRequest, "invalid thread id")
		return
	}
	var req readReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.UpToSeq < 0 {
		writeErr(w, http.StatusBadRequest, "upToSeq must be >= 0")
		return
	}
	if err := s.store.MarkReadThread(r.Context(), claims.OrgID, claims.UserID, threadID, req.UpToSeq); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// dismissMessage serves POST /api/v1/messages/{id}/dismiss. Sender-only soft
// hide. The recipient is unaffected. Server enforces sender_id == jwt.user_id.
func (s *Server) dismissMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	messageID := chi.URLParam(r, "id")
	if !validUUID(messageID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if err := s.store.DismissMessage(r.Context(), claims.OrgID, claims.UserID, messageID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
