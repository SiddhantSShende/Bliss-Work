package api

import (
	"math"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// listInbox serves GET /api/v1/inbox?cursor=&limit=&peerId=.
//
// Returns the caller's unified inbox feed (messages + tasks intermixed,
// newest first) with a keyset cursor. Default limit 25; cap 100. An optional
// peerId narrows the feed to one counterparty (the People-sidebar drill-down).
func (s *Server) listInbox(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	cursor := r.URL.Query().Get("cursor")
	limit := 25
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	peerID := r.URL.Query().Get("peerId")
	if peerID != "" && !validUUID(peerID) {
		writeErr(w, http.StatusBadRequest, "invalid peerId")
		return
	}
	page, err := s.store.ListInbox(r.Context(), claims.OrgID, claims.UserID, peerID, cursor, limit)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// listInboxPeers serves GET /api/v1/inbox/peers.
//
// Returns the distinct counterparties in the caller's visible inbox (newest
// activity first) with per-peer unread + item rollups. Powers the People
// sidebar of the inbox.
func (s *Server) listInboxPeers(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	peers, err := s.store.ListInboxPeers(r.Context(), claims.OrgID, claims.UserID)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, peers)
}

// ignoreInboxItem serves POST /api/v1/inbox/items/{kind}/{refId}/ignore.
//
// Used by the renderer for the generic "Ignore" inbox-row action. For THREAD
// kind we delegate to IgnoreThread (which emits ConversationIgnored to
// flip both sides); for TASK kind we hide the projection row only — the
// canonical task ignore flow lives in task-svc and the projector handles
// task.ignored when it eventually fires.
func (s *Server) ignoreInboxItem(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	kind := chi.URLParam(r, "kind")
	refID := chi.URLParam(r, "refId")
	if !validUUID(refID) {
		writeErr(w, http.StatusBadRequest, "invalid refId")
		return
	}
	switch kind {
	case "THREAD":
		if err := s.store.IgnoreThread(r.Context(), claims.OrgID, claims.UserID, refID); err != nil {
			s.mapErr(w, err)
			return
		}
	case "TASK":
		// Soft-hide only — the user must still call task-svc to register
		// the canonical IGNORE transition. The projector will overwrite our
		// hidden_for_owner when task.ignored arrives anyway.
		if err := s.store.MarkInboxItemHidden(r.Context(), claims.OrgID, claims.UserID, "TASK", refID); err != nil {
			s.mapErr(w, err)
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "kind must be THREAD or TASK")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// markInboxItemRead serves POST /api/v1/inbox/items/{kind}/{refId}/read.
//
// Marks a unified-inbox row "seen" when the user opens it. THREAD rows have a
// seq-based read model, so we delegate to MarkReadThread (advances last_read_seq,
// stamps receipts, emits MessageRead) with an unbounded upToSeq meaning "read
// everything I can see". TASK rows have no seq — "seen" is a straight
// unread_count reset via MarkInboxItemRead. This is the path that finally clears
// the task-inbox badge, which was seeded unread_count=1 with no way to clear it.
func (s *Server) markInboxItemRead(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	kind := chi.URLParam(r, "kind")
	refID := chi.URLParam(r, "refId")
	if !validUUID(refID) {
		writeErr(w, http.StatusBadRequest, "invalid refId")
		return
	}
	switch kind {
	case "THREAD":
		if err := s.store.MarkReadThread(r.Context(), claims.OrgID, claims.UserID, refID, math.MaxInt64); err != nil {
			s.mapErr(w, err)
			return
		}
	case "TASK":
		if err := s.store.MarkInboxItemRead(r.Context(), claims.OrgID, claims.UserID, "TASK", refID); err != nil {
			s.mapErr(w, err)
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "kind must be THREAD or TASK")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
