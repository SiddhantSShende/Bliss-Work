package api

import (
	"net/http"
	"strings"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/store"
)

// startConferenceCall serves POST /api/v1/calls/direct with `peerIds` — the
// multi-select "Call": ONE ad-hoc DIRECT call, every selected person rung.
//
// Not a Meeting and not several calls: it is the same row a 1:1 that was later
// widened would be, so everything that applies to a widened call (the room, the
// roster, leaving) applies here, and nothing about scheduling, invite links or
// the calendar does. Hence no scheduledAt, title or duration — those belong to
// the endpoints that make Meetings and scheduled chat calls.
//
// Authorization is the store's: same org as the caller, no block between the
// caller and a peer or between two peers, and at most MaxAdhocCallParticipants.
// A single entry is just a 1:1 and is refused here — that ring travels the
// signaling path, not this one.
func (s *Server) startConferenceCall(w http.ResponseWriter, r *http.Request, req directCallReq) {
	claims, _ := auth.FromContext(r.Context())
	if len(req.PeerIDs) < 2 || req.PeerID != "" || req.ScheduledAt != "" ||
		req.Title != "" || req.DurationMinutes != nil {
		writeErr(w, http.StatusBadRequest, "peerIds starts a conference of two or more people, and nothing else")
		return
	}
	if len(req.PeerIDs)+1 > store.MaxAdhocCallParticipants {
		writeErr(w, http.StatusConflict, "too many people for one call")
		return
	}
	seen := make(map[string]struct{}, len(req.PeerIDs))
	for _, id := range req.PeerIDs {
		if !validUUID(id) {
			writeErr(w, http.StatusBadRequest, "invalid peerIds")
			return
		}
		if _, dup := seen[id]; dup {
			writeErr(w, http.StatusBadRequest, "duplicate peerIds")
			return
		}
		seen[id] = struct{}{}
	}
	media := strings.ToLower(strings.TrimSpace(req.Media))
	if media == "" {
		media = "video"
	}
	if media != "audio" && media != "video" {
		writeErr(w, http.StatusBadRequest, badScheduleMsg)
		return
	}
	c, err := s.store.CreateConferenceCall(r.Context(), claims.OrgID, claims.UserID, req.PeerIDs, "", media)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// The caller is already in it; everyone else is rung, one event each way the
	// add-participant path rings a newcomer.
	s.ringUsers(r.Context(), c, req.PeerIDs, events.TypeCallRing, claims.UserID)
	writeJSON(w, http.StatusCreated, c)
}
