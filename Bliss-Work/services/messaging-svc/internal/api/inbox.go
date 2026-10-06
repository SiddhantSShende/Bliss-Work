package api

import (
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// inboxKinds parses the optional `?kinds=MAIL,THREAD` filter.
//
// Absent means every kind, which is what keeps the endpoint's existing contract
// intact for any caller that predates the filter. An unrecognised kind is
// dropped rather than rejected: the enum can only grow, and a client asking for
// a kind this build has never heard of should get the kinds it does know, not a
// 400. A list that names ONLY unknown kinds does 400 — that is a caller asking
// for nothing, and silently answering "everything" would be the opposite.
func inboxKinds(raw string) ([]string, bool) {
	if raw == "" {
		return nil, true
	}
	known := map[string]bool{"THREAD": true, "TASK": true, "MAIL": true}
	out := make([]string, 0, 3)
	for _, part := range strings.Split(raw, ",") {
		k := strings.ToUpper(strings.TrimSpace(part))
		if known[k] {
			out = append(out, k)
		}
	}
	return out, len(out) > 0
}

// listInbox serves GET /api/v1/inbox?cursor=&limit=&peerId=&kinds=&deleted=.
//
// Returns the caller's unified inbox feed (mail, message threads and tasks
// intermixed, newest first) with a keyset cursor. Default limit 25; cap 100.
// An optional peerId narrows the feed to one counterparty (the People-sidebar
// drill-down); an optional kinds list narrows it to those item kinds.
//
// `deleted=1` returns the rows the caller has HIDDEN instead of the rows they
// have not — the Deleted Items folder. A parameter rather than a second
// endpoint because it is the same feed, the same cursor and the same page
// shape; only the predicate differs. Pair it with kinds=MAIL: hidden is Delete
// on a mail row but Ignore on a thread or a task, and a wastebasket that also
// lists everything you ever ignored is not the folder anybody opened.
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
	kinds, ok := inboxKinds(r.URL.Query().Get("kinds"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "kinds must name at least one of THREAD, TASK, MAIL")
		return
	}
	// Any of the usual truthy spellings; anything else (including absent) is
	// the ordinary feed, which is what every caller that predates this expects.
	deleted := isTruthyParam(r.URL.Query(), "deleted")
	page, err := s.store.ListInbox(
		r.Context(), claims.OrgID, claims.UserID, peerID, cursor, limit, kinds, deleted)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// listInboxPeers serves GET /api/v1/inbox/peers?kinds=.
//
// Returns the distinct counterparties in the caller's visible inbox (newest
// activity first) with per-peer unread + item rollups. Powers the People
// sidebar of the inbox.
//
// Callers should pass the SAME kinds they pass to /inbox: this is the badge
// over that list, and counting rows the list does not show produces a "3" the
// user cannot find.
func (s *Server) listInboxPeers(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	kinds, ok := inboxKinds(r.URL.Query().Get("kinds"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "kinds must name at least one of THREAD, TASK, MAIL")
		return
	}
	peers, err := s.store.ListInboxPeers(r.Context(), claims.OrgID, claims.UserID, kinds)
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
	case "MAIL":
		// One-sided, unlike THREAD. Deleting a mail out of your own Inbox says
		// nothing about the sender's Sent copy or anyone else's — a mail is
		// several people's, and removing it for all of them is not one
		// recipient's call. The mail itself and its attachments stay.
		if err := s.store.MarkInboxItemHidden(r.Context(), claims.OrgID, claims.UserID, "MAIL", refID); err != nil {
			s.mapErr(w, err)
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "kind must be THREAD, TASK or MAIL")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// isTruthyParam reads a boolean query parameter the way a URL actually carries
// one: `?deleted`, `?deleted=1` and `?deleted=true` all mean the same thing.
//
// Takes the whole Values because a bare `?deleted` and an absent `deleted` are
// both the empty string to Get(), and they mean opposite things.
func isTruthyParam(q url.Values, key string) bool {
	vs, present := q[key]
	if !present {
		return false
	}
	if len(vs) == 0 || vs[0] == "" {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(vs[0])) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// restoreInboxItem serves POST /api/v1/inbox/items/{kind}/{refId}/restore.
//
// Undoes a Delete: the row goes back into the feed it was removed from. MAIL
// only, and deliberately so — hidden_for_owner means "deleted" on a mail row,
// but on a THREAD it means Ignore (which revives on the next reply, from the
// thread's own path) and on a TASK it is the projector's to own. Restore is a
// mailbox action, so it answers only for the mailbox's rows.
//
// The mail itself was never touched by the delete, so there is nothing to
// recover beyond the flag: the same row, with the same read state, reappears
// where it was.
func (s *Server) restoreInboxItem(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	kind := chi.URLParam(r, "kind")
	refID := chi.URLParam(r, "refId")
	if !validUUID(refID) {
		writeErr(w, http.StatusBadRequest, "invalid refId")
		return
	}
	if kind != "MAIL" {
		writeErr(w, http.StatusBadRequest, "only MAIL rows can be restored")
		return
	}
	if err := s.store.SetInboxItemHidden(
		r.Context(), claims.OrgID, claims.UserID, "MAIL", refID, false); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// markInboxItemRead serves POST /api/v1/inbox/items/{kind}/{refId}/read.
//
// Marks a unified-inbox row "seen" when the user opens it. THREAD rows have a
// seq-based read model, so we delegate to MarkReadThread (advances last_read_seq,
// stamps receipts, emits MessageRead) with an unbounded upToSeq meaning "read
// everything I can see". MarkReadThread clamps that to the newest seq that
// exists, so the cursor and the MessageRead event never carry MaxInt64. TASK rows have no seq — "seen" is a straight
// unread_count reset via MarkInboxItemRead. MAIL rows carry their own read_at
// on the delivery row, so they go through MarkMailRead. This is the path that finally clears
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
	case "MAIL":
		// Routed to MarkMailRead rather than the generic unread reset because a
		// mail has a read_at of its own: the badge and "when did you open it"
		// are two facts, and clearing only the first would lose the second.
		if err := s.store.MarkMailRead(r.Context(), claims.OrgID, claims.UserID, refID); err != nil {
			s.mapErr(w, err)
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "kind must be THREAD, TASK or MAIL")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
