package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/store"
)

// The durable half of a meeting's chat and shared notes.
//
// Both still travel live over the SFU's data channel — that is what makes them
// appear instantly for everyone in the room, and none of it changed. These
// endpoints are the copy that outlives the room, so a meeting that is over
// still has something to read: see migration 0029 for what the absence of one
// cost.
//
// Authorization is entirely the store's, and it is the RLS policy rather than a
// check written here: reading needs the call to be visible to you (your org's
// meeting, or one you were on the roster of), and writing needs you to have
// actually been in it.

// Page bounds for a transcript read. Mirrors store.MaxTranscriptPage so the
// HTTP layer refuses nonsense before it becomes a query; the store enforces the
// real ceiling because it is reachable from more than one caller.
const (
	DefaultTranscriptPageSize = 100
	MaxTranscriptPageSize     = 200
)

// transcriptEntryReq is the body of both POSTs.
//
// `ID` is the id the sender's client already minted for the data-channel copy.
// Sending it is what makes the two copies the same entry, and what makes a
// retry — or the same message reaching us twice on a flaky connection — one row
// instead of two. Omitting it is allowed; the server mints one.
//
// `At` is the sender's own clock in unix ms, which is what orders the
// transcript so it reads the way the room experienced it. It is client input
// and treated as such: the store clamps anything more than a day out to the
// server's time rather than letting a wrong clock (or a deliberate one) pin an
// entry to the top or the bottom of the record.
type transcriptEntryReq struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// postCallChat serves POST /api/v1/calls/{id}/chat.
//
// ROOM-WIDE MESSAGES ONLY. A directed message is delivered by the SFU to one
// participant and nobody else, and there is deliberately no way to store one:
// this body has no recipient field and the table has no column for it, so the
// audience the sender chose cannot be widened by writing it down. The client
// only calls this for a message addressed to everyone.
func (s *Server) postCallChat(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req transcriptEntryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out, err := s.store.AppendCallChat(
		r.Context(), claims.OrgID, claims.UserID, callID, req.ID, req.Text, req.At)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// listCallChat serves GET /api/v1/calls/{id}/chat?cursor=&limit=.
// Oldest first — a transcript is read forwards.
func (s *Server) listCallChat(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	page, err := s.store.ListCallChat(
		r.Context(), claims.OrgID, claims.UserID, callID,
		r.URL.Query().Get("cursor"),
		limitParam(r, DefaultTranscriptPageSize, MaxTranscriptPageSize))
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// postCallNote serves POST /api/v1/calls/{id}/notes.
func (s *Server) postCallNote(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req transcriptEntryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	out, err := s.store.AppendCallNote(
		r.Context(), claims.OrgID, claims.UserID, callID, req.ID, req.Text, req.At)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// listCallNotes serves GET /api/v1/calls/{id}/notes?cursor=&limit=.
func (s *Server) listCallNotes(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	page, err := s.store.ListCallNotes(
		r.Context(), claims.OrgID, claims.UserID, callID,
		r.URL.Query().Get("cursor"),
		limitParam(r, DefaultTranscriptPageSize, MaxTranscriptPageSize))
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// listMyCallHistory serves GET /api/v1/calls/history?cursor=&limit=.
//
// Separate from GET /api/v1/calls rather than a mode of it, because the two
// answer different questions and want different shapes. /calls is "what am I
// expected at" — one bounded page covering the near past as well, which is
// exactly right for Upcoming and Live and is untouched by this. This is "every
// meeting I have ever been in", which has no natural end and therefore has to
// be a cursor.
func (s *Server) listMyCallHistory(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	page, err := s.store.ListMyCallHistory(
		r.Context(), claims.OrgID, claims.UserID,
		r.URL.Query().Get("cursor"),
		limitParam(r, store.DefaultCallHistoryPage, store.MaxCallHistoryPage))
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
