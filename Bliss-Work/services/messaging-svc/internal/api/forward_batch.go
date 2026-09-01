package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/store"
)

// Batch forward: N source messages, delivered in their canonical
// chronological order, to M destinations in one request. The extension a
// multi-select UI needs over forwardMessage (forward_internal.go's
// single-pair sibling, left untouched — this is a genuinely separate route,
// not a replacement). See store.ForwardMessages's own doc comment for the
// atomicity/idempotency contract this handler is a thin shell around.

const (
	// maxForwardSources / maxForwardTargets bound one batch. 50 × 20 is 1,000
	// message inserts spread across at most 20 transactions — generous for a
	// selection UI, and still bounded.
	maxForwardSources = 50
	maxForwardTargets = 20
)

type forwardTargetReq struct {
	TargetKind string `json:"targetKind"`
	TargetID   string `json:"targetId"`
}

type forwardBatchReq struct {
	MessageIDs    []string           `json:"messageIds"`
	Targets       []forwardTargetReq `json:"targets"`
	ClientBatchID string             `json:"clientBatchId"`
}

type forwardDestinationResp struct {
	TargetKind string `json:"targetKind"`
	TargetID   string `json:"targetId"`
	OK         bool   `json:"ok"`
	// Error is a coarse code ("forbidden" | "internal"), never the raw error
	// text — see forwardErrCode.
	Error          string   `json:"error,omitempty"`
	ConversationID string   `json:"conversationId,omitempty"`
	ChannelID      string   `json:"channelId,omitempty"`
	MessageIDs     []string `json:"messageIds"`
}

type forwardBatchResp struct {
	Results []forwardDestinationResp `json:"results"`
}

// forwardErrCode maps a per-destination error to the coarse code the client
// sees. Never the raw error text: an internal failure's message could name
// something about the deployment a client has no business seeing.
func forwardErrCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, store.ErrForbidden):
		return "forbidden"
	default:
		return "internal"
	}
}

// forwardMessages serves POST /api/v1/forwards.
func (s *Server) forwardMessages(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req forwardBatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.MessageIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "messageIds required")
		return
	}
	if len(req.MessageIDs) > maxForwardSources {
		writeErr(w, http.StatusBadRequest, "at most 50 messages per request")
		return
	}
	for _, id := range req.MessageIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "invalid messageId in batch")
			return
		}
	}
	if len(req.Targets) == 0 {
		writeErr(w, http.StatusBadRequest, "targets required")
		return
	}
	if len(req.Targets) > maxForwardTargets {
		writeErr(w, http.StatusBadRequest, "at most 20 destinations per request")
		return
	}
	targets := make([]store.ForwardTarget, 0, len(req.Targets))
	for _, t := range req.Targets {
		if t.TargetKind != store.ForwardTargetUser && t.TargetKind != store.ForwardTargetChannel {
			writeErr(w, http.StatusBadRequest, `targetKind must be "user" or "channel"`)
			return
		}
		if !validUUID(t.TargetID) {
			writeErr(w, http.StatusBadRequest, "invalid targetId in batch")
			return
		}
		targets = append(targets, store.ForwardTarget{Kind: t.TargetKind, ID: t.TargetID})
	}
	// Required, not server-minted: same reasoning as the single-forward
	// endpoint's required clientMsgId. Minting one here would deliver every
	// message in the batch a second time to anyone whose connection dropped
	// mid-request.
	if !validUUID(req.ClientBatchID) {
		writeErr(w, http.StatusBadRequest, "clientBatchId required")
		return
	}

	results, err := s.store.ForwardMessages(
		r.Context(), claims.OrgID, claims.UserID, req.MessageIDs, targets, req.ClientBatchID,
	)
	if err != nil {
		// A whole-request failure: an unreadable source, or a selection
		// spanning more than one conversation/channel. No destination was
		// attempted.
		s.mapErr(w, err)
		return
	}

	resp := forwardBatchResp{Results: make([]forwardDestinationResp, 0, len(results))}
	for _, res := range results {
		resp.Results = append(resp.Results, forwardDestinationResp{
			TargetKind:     res.Target.Kind,
			TargetID:       res.Target.ID,
			OK:             res.Err == nil,
			Error:          forwardErrCode(res.Err),
			ConversationID: res.ConversationID,
			ChannelID:      res.ChannelID,
			MessageIDs:     res.MessageIDs,
		})
	}
	// 200, not 201: partial success is the normal case here, and there is no
	// single created resource — every destination's own outcome is in the body.
	writeJSON(w, http.StatusOK, resp)
}
