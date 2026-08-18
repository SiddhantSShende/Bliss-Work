package api

import (
	"net/http"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// Deleting and reacting.
//
// Three routes, all keyed on a message id the store re-authorizes against
// conversation membership — the id alone proves nothing, and a handler that
// trusted it would let anyone probe whether a message exists.

// hideMessage serves POST /api/v1/messages/{id}/hide — "delete for me".
func (s *Server) hideMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if err := s.store.HideMessage(r.Context(), claims.OrgID, claims.UserID, msgID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteMessage serves DELETE /api/v1/messages/{id} — "delete for everyone".
// Sender-only; the store enforces it.
func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if err := s.store.DeleteMessageForAll(r.Context(), claims.OrgID, claims.UserID, msgID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// maxEmojiBytes bounds the reaction column so it stays an EMOJI field rather
// than becoming free text by accident. Generous enough for a family sequence
// with skin-tone and ZWJ joiners (👨‍👩‍👧‍👦 is 25 bytes), far short of a message.
const maxEmojiBytes = 64

// validEmoji bounds and sanitizes a reaction value.
//
// Shared by the DM and channel reaction endpoints rather than duplicated: it is
// the only thing standing between a URL path segment and a string rendered
// verbatim into every member's chip row, and two copies of a check like that
// drift. Rejects control characters and bidi overrides for that reason — a
// newline or an RLO in a "reaction" is a display attack, not an emoji.
func validEmoji(emoji string) bool {
	if emoji == "" || len(emoji) > maxEmojiBytes || !utf8.ValidString(emoji) {
		return false
	}
	for _, ru := range emoji {
		if ru < 0x20 || (ru >= 0x7f && ru <= 0x9f) || (ru >= 0x202a && ru <= 0x202e) {
			return false
		}
	}
	return true
}

// setReaction serves PUT/DELETE /api/v1/messages/{id}/reactions/{emoji}.
//
// The emoji rides in the PATH rather than a body so the two directions are the
// same URL under different verbs, which is what makes a double-tap idempotent
// at the HTTP layer instead of only at the SQL layer.
func (s *Server) setReaction(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	emoji := chi.URLParam(r, "emoji")
	if !validEmoji(emoji) {
		writeErr(w, http.StatusBadRequest, "invalid emoji")
		return
	}

	on := r.Method == http.MethodPut
	out, err := s.store.SetReaction(r.Context(), claims.OrgID, claims.UserID, msgID, emoji, on)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// listConversationReactions serves
// GET /api/v1/conversations/{id}/reactions?beforeSeq=&limit= — the reactions for
// one page of messages, in one query, so the bubbles and their chips render
// together instead of the chips popping in a beat later.
//
// Pass the SAME beforeSeq and limit used for the matching /messages call; the
// window is what keeps this bounded.
func (s *Server) listConversationReactions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	convID := chi.URLParam(r, "id")
	if !validUUID(convID) {
		writeErr(w, http.StatusBadRequest, "invalid conversation id")
		return
	}
	beforeSeq, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	out, err := s.store.ReactionsForConversation(r.Context(), claims.OrgID, claims.UserID, convID, beforeSeq, limit)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
