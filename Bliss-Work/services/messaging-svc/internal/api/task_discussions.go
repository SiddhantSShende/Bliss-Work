// task_discussions.go — HTTP handlers for the task "Chat" button: resolving
// a task to its DM or channel discussion, the bulk unread-count lookup the
// sticky widget/task list use to badge a whole task page in one call, and
// sending a message through that entry point.
package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/store"
)

type openTaskDiscussionReq struct {
	PeerID    string `json:"peerId"`
	ChannelID string `json:"channelId"`
}

// openTaskDiscussion serves POST /api/v1/tasks/{taskId}/discussion — opens
// (or re-opens) the chat target for a task without sending anything, exactly
// as openConversation does for an ordinary DM.
func (s *Server) openTaskDiscussion(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	taskID := chi.URLParam(r, "taskId")
	if !validUUID(taskID) {
		writeErr(w, http.StatusBadRequest, "invalid task id")
		return
	}
	var req openTaskDiscussionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if (req.PeerID == "") == (req.ChannelID == "") {
		writeErr(w, http.StatusBadRequest, "exactly one of peerId or channelId is required")
		return
	}
	var peerID, channelID *string
	if req.PeerID != "" {
		if !validUUID(req.PeerID) {
			writeErr(w, http.StatusBadRequest, "invalid peerId")
			return
		}
		if req.PeerID == claims.UserID {
			writeErr(w, http.StatusBadRequest, "cannot open a task discussion with yourself")
			return
		}
		peerID = &req.PeerID
	} else {
		if !validUUID(req.ChannelID) {
			writeErr(w, http.StatusBadRequest, "invalid channelId")
			return
		}
		channelID = &req.ChannelID
	}
	d, err := s.store.OpenTaskDiscussion(r.Context(), claims.OrgID, claims.UserID, taskID, peerID, channelID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	// 200, not 201: the discussion may well already exist, same reasoning as
	// openConversation.
	writeJSON(w, http.StatusOK, d)
}

// bulkTaskDiscussions serves GET /api/v1/tasks/discussions?taskIds=a,b,c — the
// per-task unread badge for every task on screen in one round trip.
func (s *Server) bulkTaskDiscussions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	raw := r.URL.Query().Get("taskIds")
	if raw == "" {
		writeJSON(w, http.StatusOK, []store.TaskDiscussionSummaryDTO{})
		return
	}
	var taskIDs []string
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "invalid taskIds")
			return
		}
		taskIDs = append(taskIDs, id)
	}
	out, err := s.store.BulkTaskDiscussions(r.Context(), claims.OrgID, claims.UserID, taskIDs)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type sendTaskDiscussionMsgReq struct {
	PeerID      string `json:"peerId"`
	ChannelID   string `json:"channelId"`
	Body        string `json:"body"`
	ClientMsgID string `json:"clientMsgId"`
	// ReplyToID quotes another message in the same conversation/channel ("" = none).
	ReplyToID string `json:"replyToId"`
}

// sendTaskDiscussionMessage serves POST /api/v1/tasks/{taskId}/discussion/messages.
func (s *Server) sendTaskDiscussionMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	taskID := chi.URLParam(r, "taskId")
	if !validUUID(taskID) {
		writeErr(w, http.StatusBadRequest, "invalid task id")
		return
	}
	var req sendTaskDiscussionMsgReq
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
	if (req.PeerID == "") == (req.ChannelID == "") {
		writeErr(w, http.StatusBadRequest, "exactly one of peerId or channelId is required")
		return
	}
	if req.ReplyToID != "" && !validUUID(req.ReplyToID) {
		writeErr(w, http.StatusBadRequest, "invalid replyToId")
		return
	}
	if req.PeerID != "" {
		if !validUUID(req.PeerID) {
			writeErr(w, http.StatusBadRequest, "invalid peerId")
			return
		}
		if req.PeerID == claims.UserID {
			writeErr(w, http.StatusBadRequest, "cannot message yourself")
			return
		}
		res, err := s.store.SendTaskDiscussionMessage(r.Context(), claims.OrgID, claims.UserID, taskID, req.PeerID, req.Body, req.ClientMsgID, req.ReplyToID)
		if err != nil {
			s.mapErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, res)
		return
	}
	if !validUUID(req.ChannelID) {
		writeErr(w, http.StatusBadRequest, "invalid channelId")
		return
	}
	res, err := s.store.SendChannelTaskMessage(r.Context(), claims.OrgID, claims.UserID, taskID, req.ChannelID, req.Body, req.ClientMsgID, req.ReplyToID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}
