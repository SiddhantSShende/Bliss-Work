package api

import (
	"net/http"
	"strings"

	"github.com/task-board/messaging-svc/internal/auth"
)

// maxChannelQueryLen bounds the search text (in characters): it is client-supplied and goes into
// a substring match, and no channel name is anywhere near this long.
const maxChannelQueryLen = 100

// listMyChannelsPage serves GET /api/v1/channels/mine?q=&limit=&offset= — one
// page of the caller's own channels, searchable by name. The picker's endpoint:
// GET /channels stays the sidebar's whole-list read, unchanged.
func (s *Server) listMyChannelsPage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	limit, offset := pageOffsetParams(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if r := []rune(q); len(r) > maxChannelQueryLen {
		q = string(r[:maxChannelQueryLen])
	}
	chans, err := s.store.ListMyChannelsPage(r.Context(), claims.OrgID, claims.UserID, q, limit, offset)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chans)
}
