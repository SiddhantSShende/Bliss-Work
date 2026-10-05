package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/recurrence"
	"github.com/task-board/messaging-svc/internal/store"
)

// Repeating meetings, and the channels a meeting is addressed to.
//
//	POST   /meetings              gains `channelIds` and `recurrence`
//	GET    /meeting-series/{id}   the series behind an occurrence — organiser only
//	PATCH  /meeting-series/{id}   change it; its upcoming occurrences are reconciled
//	DELETE /meeting-series/{id}   stop it; its upcoming occurrences are removed
//
// There is no edit of a single occurrence, because there is no edit of any
// meeting: the series is the smallest thing a repeating meeting can be changed
// as. Occurrences that have started or ended are never touched.

// recurrenceReq is a rule on the wire. Field names are task-svc's, so the two
// recurring features read alike; the one difference is `endDate`, a calendar date
// in `timeZone` rather than an instant.
type recurrenceReq struct {
	Frequency       string `json:"frequency"`
	Interval        int    `json:"interval"`
	Weekdays        []int  `json:"weekdays"`
	EndCondition    string `json:"endCondition"`
	EndDate         string `json:"endDate"`
	OccurrenceCount int    `json:"occurrenceCount"`
	// TimeZone is the IANA zone the schedule is read in. Required on create, and
	// optional on an edit (a series keeps the zone it began in).
	TimeZone string `json:"timeZone"`
}

func (r recurrenceReq) input() store.RecurrenceInput {
	return store.RecurrenceInput{
		Rule: recurrence.Rule{
			Frequency: r.Frequency, Interval: r.Interval, Weekdays: r.Weekdays,
			EndCondition: r.EndCondition, EndDate: r.EndDate, OccurrenceCount: r.OccurrenceCount,
		},
		TimeZone: r.TimeZone,
	}
}

// parseIDList checks a list of ids from the wire and returns them canonical.
// `what` names them in the message. A repeat is refused rather than collapsed: a
// client that sends one twice has a broken picker, and hiding that hides the bug.
func parseIDList(ids []string, max int, what string) ([]string, string) {
	if len(ids) > max {
		return nil, "too many " + what + "s"
	}
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		u, err := uuid.Parse(raw)
		if err != nil {
			return nil, "invalid " + what + " id"
		}
		id := u.String()
		if seen[id] {
			return nil, "duplicate " + what
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, ""
}

// meetingOptions validates the parts of POST /meetings beyond a one-off.
// Returns a non-empty message for a 400.
func meetingOptions(req scheduleMeetingReq, sc schedule) (store.MeetingOptions, string) {
	channels, msg := parseIDList(req.ChannelIDs, store.MaxMeetingChannels, "channel")
	if msg != "" {
		return store.MeetingOptions{}, msg
	}
	opts := store.MeetingOptions{ChannelIDs: channels}
	if req.Recurrence == nil {
		return opts, ""
	}
	if sc.At == nil {
		return opts, "a repeating meeting needs a start time"
	}
	in := req.Recurrence.input()
	// The store validates again against the same rule; doing it here first makes
	// a bad rule a plain 400 before any transaction is opened.
	if _, err := recurrence.New(in.Rule, *sc.At, in.TimeZone); err != nil {
		return opts, err.Error()
	}
	opts.Recurrence = &in
	return opts, ""
}

// getMeetingSeries serves GET /api/v1/meeting-series/{id}.
func (s *Server) getMeetingSeries(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	id := chi.URLParam(r, "id")
	if !validUUID(id) {
		writeErrR(w, r, http.StatusBadRequest, "invalid series id")
		return
	}
	out, err := s.store.GetSeries(r.Context(), claims.OrgID, claims.UserID, id)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type updateSeriesReq struct {
	Title      *string        `json:"title"`
	InviteeIDs *[]string      `json:"inviteeIds"`
	ChannelIDs *[]string      `json:"channelIds"`
	Recurrence *recurrenceReq `json:"recurrence"`
}

// updateMeetingSeries serves PATCH /api/v1/meeting-series/{id}.
//
// A field left out is left alone. Occurrences whose instant is still in the
// schedule keep their ids (and so their join links and guests); see
// store/meeting_series_edit.go.
func (s *Server) updateMeetingSeries(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	id := chi.URLParam(r, "id")
	if !validUUID(id) {
		writeErrR(w, r, http.StatusBadRequest, "invalid series id")
		return
	}
	var req updateSeriesReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	patch, msg := seriesPatch(req)
	if msg != "" {
		writeErrR(w, r, http.StatusBadRequest, msg)
		return
	}
	change, err := s.store.UpdateSeries(r.Context(), claims.OrgID, claims.UserID, id, patch)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// At most one announcement per edit, and only when somebody needs one: nothing
	// for an edit that changed nothing, only the newly invited when only people were
	// added, and everyone (once) when the schedule or title changed. Never one per
	// occurrence, which would be forty for a daily meeting.
	if change.Call != nil {
		if change.Recipients != nil {
			s.ringUsers(r.Context(), change.Call, change.Recipients, events.TypeCallScheduled, claims.UserID)
		} else {
			s.notifyCall(r.Context(), change.Call, events.TypeCallScheduled, claims.UserID)
		}
	}
	writeJSON(w, http.StatusOK, change.Series)
}

func seriesPatch(req updateSeriesReq) (store.SeriesPatch, string) {
	var p store.SeriesPatch
	if req.Title == nil && req.InviteeIDs == nil && req.ChannelIDs == nil && req.Recurrence == nil {
		return p, "nothing to change"
	}
	if req.Title != nil {
		t := truncateTitle(strings.TrimSpace(*req.Title))
		p.Title = &t
	}
	if req.InviteeIDs != nil {
		ids, msg := parseIDList(*req.InviteeIDs, maxMeetingInvitees, "invitee")
		if msg != "" {
			return p, msg
		}
		p.InviteeIDs = &ids
	}
	if req.ChannelIDs != nil {
		ids, msg := parseIDList(*req.ChannelIDs, store.MaxMeetingChannels, "channel")
		if msg != "" {
			return p, msg
		}
		p.ChannelIDs = &ids
	}
	if req.Recurrence != nil {
		in := req.Recurrence.input()
		p.Recurrence = &in
	}
	return p, ""
}

// cancelMeetingSeries serves DELETE /api/v1/meeting-series/{id}.
//
// Occurrences that have not started are removed and one call.ended tells the
// people who were on them (it invalidates their meeting lists — see the client's
// call-event handler); ones that started or ended stay as history. Cancelling
// twice is not an error.
func (s *Server) cancelMeetingSeries(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	id := chi.URLParam(r, "id")
	if !validUUID(id) {
		writeErrR(w, r, http.StatusBadRequest, "invalid series id")
		return
	}
	change, err := s.store.CancelSeries(r.Context(), claims.OrgID, claims.UserID, id)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	if change.Call != nil {
		s.ringUsers(r.Context(), change.Call, change.Recipients, events.TypeCallEnded, claims.UserID)
	}
	w.WriteHeader(http.StatusNoContent)
}
