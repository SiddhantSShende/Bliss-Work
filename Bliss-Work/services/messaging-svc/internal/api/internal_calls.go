package api

import (
	"net/http"
)

// internalCallBlockedResp is the response for GET /internal/calls/blocked.
type internalCallBlockedResp struct {
	Blocked bool `json:"blocked"`
}

// internalCallBlocked serves GET /internal/calls/blocked for ws-gateway. It
// answers whether a 1:1 call between two org-mates must be refused because
// either has blocked the other — the same bool_or(blocked) rule that already
// gates SendMessage/Reply (see store.blockedPairTx).
//
// This is the actual authorization boundary for a 1:1 call ring: ws-gateway
// calls it once per call.invite, before forwarding the frame, never per
// rtc.offer/answer/ice (those ride the same signaling path but would turn one
// check into twenty or forty — see signal.Dispatcher's peer-cache comment for
// why that cost matters). CreateDirectCall applies the same rule separately,
// against its own open transaction, as defense in depth on the call-history
// write — but that write is best-effort and unawaited by the client's ring,
// so it does not, by itself, stop the invite from reaching a blocked peer.
//
// Auth: shared X-Internal-Token, same as markDelivered.
func (s *Server) internalCallBlocked(w http.ResponseWriter, r *http.Request) {
	if !internalAuthOK(r) {
		writeErr(w, http.StatusUnauthorized, "bad internal token")
		return
	}
	q := r.URL.Query()
	orgID, userA, userB := q.Get("orgId"), q.Get("userA"), q.Get("userB")
	if !validUUID(orgID) || !validUUID(userA) || !validUUID(userB) {
		writeErr(w, http.StatusBadRequest, "orgId, userA, userB required")
		return
	}
	blocked, err := s.store.IsBlockedPair(r.Context(), orgID, userA, userB)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, internalCallBlockedResp{Blocked: blocked})
}
