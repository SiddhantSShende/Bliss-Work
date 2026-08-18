package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
)

// Per-message actions inside a CHANNEL: hide, delete for everyone, pin, react.
//
// Separate from message_actions.go because the store functions they call are
// separate — channel messages live in `channel_messages`, not `messages`, and
// the authorization differs (see store/channels_message_actions.go). The URL
// shapes deliberately mirror the DM ones so the client's two code paths look
// like each other.
//
// Every one of these takes the message id alone rather than {channelId, msgId}:
// the message already knows its channel, and asking the client for it would
// invite a mismatched pair the server then has to reconcile.
//
// The prefix is `/channel-messages/`, NOT `/channels/messages/`. chi would in
// fact route the latter correctly — a static segment outranks a param one — but
// it puts a literal "messages" one typo away from being read as a channel id in
// `/channels/{id}/...`, and the roster route two blocks up already carries a
// comment about that exact hazard. A prefix that cannot collide is cheaper than
// a comment explaining why this one does not.

// hideChannelMessage serves POST /api/v1/channel-messages/{id}/hide —
// "delete for me". Any member; the store checks membership.
func (s *Server) hideChannelMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if err := s.store.HideChannelMessage(r.Context(), claims.OrgID, claims.UserID, msgID); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteChannelMessage serves DELETE /api/v1/channel-messages/{id} —
// "delete for everyone". Author OR channel moderator; the store enforces it and
// needs the JWT roles to recognise an org_admin.
func (s *Server) deleteChannelMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if err := s.store.DeleteChannelMessageForAll(
		r.Context(), claims.OrgID, claims.UserID, msgID, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pinChannelMessage serves PUT/DELETE /api/v1/channel-messages/{id}/pin.
//
// Same verb-pair-on-one-URL shape as reactions, for the same reason: it makes a
// double-tap idempotent at the HTTP layer, not just in SQL. Moderators only.
func (s *Server) pinChannelMessage(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	msgID := chi.URLParam(r, "id")
	if !validUUID(msgID) {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	on := r.Method == http.MethodPut
	if err := s.store.SetChannelMessagePin(
		r.Context(), claims.OrgID, claims.UserID, msgID, on, claims.Roles,
	); err != nil {
		s.mapErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// setChannelReaction serves
// PUT/DELETE /api/v1/channel-messages/{id}/reactions/{emoji}.
// Returns the message's fresh tally from the caller's point of view.
func (s *Server) setChannelReaction(w http.ResponseWriter, r *http.Request) {
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
	out, err := s.store.SetChannelReaction(
		r.Context(), claims.OrgID, claims.UserID, msgID, emoji, r.Method == http.MethodPut,
	)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// listChannelReactions serves GET /api/v1/channels/{id}/reactions.
//
// Takes the SAME (before, limit) window as GET /channels/{id}/messages and must
// be called with the same values — see store.ReactionsForChannel for why a
// whole-channel tally alongside a paginated message list is a bug rather than a
// convenience.
func (s *Server) listChannelReactions(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	beforeSeq, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	out, err := s.store.ReactionsForChannel(
		r.Context(), claims.OrgID, claims.UserID, channelID, beforeSeq, limit,
	)
	if err != nil {
		s.mapErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
