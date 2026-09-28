package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/metrics"
	"github.com/task-board/messaging-svc/internal/store"
)

// Call surface. Three shapes, one entity — see store/calls.go and
// migrations/0015_calls.sql for why they share a table.
//
//	CHANNEL  POST /channels/{id}/calls          schedule; no link exists
//	         GET  /channels/{id}/calls          what is scheduled or live
//	MEETING  POST /meetings                     schedule with a roster
//	         POST /calls/{id}/invites           mint a join link (host only)
//	         POST /calls/join                   redeem one — CROSS-ORG entry
//	DIRECT   POST /calls/direct                 a 1:1 call, now or scheduled
//	any      POST /calls/{id}/participants      add someone from YOUR org
//	         POST /calls/{id}/token             the SFU room token, or the lobby
//	         POST /calls/{id}/start             open it, admitting everyone
//	         POST /calls/{id}/share, /share/stop
//	         POST /calls/{id}/leave, /end
//
// Only two of these can widen who is in a room: /calls/{id}/participants, which
// is same-org by construction in the store, and /calls/join, which is the sole
// cross-org path in this service and is gated entirely by possession of a token.
//
// ── All three kinds do all three things ──────────────────────────────────────
// Scheduling, the waiting room and screen sharing are properties of a CALL, not
// of one of its three shapes, so every route below that takes a {id} serves a
// chat, a channel call and a meeting identically. Where they differ is only ever
// the question 0015 already answered — where the roster comes from — and that is
// resolved in the store, once, rather than by branching per kind out here.

// maxInviteTTL bounds how long a join link can outlive its meeting. A link that
// works for a month is a credential nobody remembers issuing.
const maxInviteTTL = 7 * 24 * time.Hour

// defaultInviteTTL applies when the caller does not ask for one.
const defaultInviteTTL = 24 * time.Hour

// maxMeetingInvitees caps the up-front roster on a scheduled meeting. Past this
// it is a broadcast, not a meeting, and it should not be built by looping
// INSERTs on a request thread.
const maxMeetingInvitees = 200

// maxCallTitleBytes bounds a call title. Bytes rather than runes because the
// limit exists to bound what is stored and shipped in every event, and a rune
// budget lets one emoji-heavy title cost four times another of the same length.
const maxCallTitleBytes = 200

// truncateTitle cuts a title to maxCallTitleBytes WITHOUT splitting a rune.
//
// A plain title[:200] cuts wherever byte 200 falls, and in any non-ASCII title
// that is usually the middle of a multi-byte character: the result is invalid
// UTF-8, which Postgres rejects outright for a text column (so a Hindi or
// Japanese meeting title of the wrong length fails to schedule at all), and
// which encoding/json would ship to clients as a replacement character.
//
// Walking back over continuation bytes drops at most three bytes and always
// lands on a boundary.
func truncateTitle(title string) string {
	if len(title) <= maxCallTitleBytes {
		return title
	}
	cut := maxCallTitleBytes
	for cut > 0 && !utf8.RuneStart(title[cut]) {
		cut--
	}
	return title[:cut]
}

// defaultCallMinutes is how long a SCHEDULED call runs when the organiser does
// not say.
//
// Applied to scheduled calls only, never to "meet now". A call put in the diary
// has an implied length — an hour is what every calendar in the world defaults
// to — and giving it one is what lets the sweeper close a meeting whose
// organiser never turned up to end it. An ad-hoc call has no such implication,
// and cutting one off at an hour because nobody named a duration would be the
// product inventing a rule the user never asked for; those end when the SFU
// reports the room empty instead.
const defaultCallMinutes = 60

// maxCallMinutes bounds what a caller may ask for. Twelve hours is far past any
// real meeting and exists to keep a typo'd duration from writing an `ends_at`
// years out, which is the same as having none at all.
const maxCallMinutes = 12 * 60

// scheduleGraceWindow is how far into the past a scheduledAt may still fall
// and be accepted rather than rejected as a stale request — ordinary clock
// skew and the gap between a client picking a time and the request actually
// arriving, nothing more. A genuinely past date (yesterday, last week) is
// never a real schedule request; the client's own "start now" (an omitted
// scheduledAt, handled separately) is the only intended way to mean "now".
const scheduleGraceWindow = time.Minute

type scheduleCallReq struct {
	Title string `json:"title"`
	Media string `json:"media"`
	// RFC3339. Omit or leave empty to start immediately ("meet now").
	ScheduledAt string `json:"scheduledAt"`
	// How long the call is expected to run. Omit (nil) for defaultCallMinutes
	// on a scheduled call, or for no scheduled end at all on a "meet now". A
	// POINTER because an EXPLICIT 0 is a real, distinct choice — "No end
	// time" (ScheduleCallDialog's own option) — that must not collapse into
	// omitted's different default. A bare int could not tell the two apart,
	// which silently gave every scheduled "No end time" meeting a 60-minute
	// end anyway (see parseSchedule).
	DurationMinutes *int `json:"durationMinutes"`
	// Meetings only: same-org users placed on the roster at creation.
	InviteeIDs []string `json:"inviteeIds"`
}

// schedule is the normalised form of the knobs every scheduling endpoint
// shares. A struct rather than a widening return tuple: there are four values
// now, they are read positionally at three call sites, and a fifth `bool, bool,
// *time.Time` return is where two of them get swapped without the compiler
// noticing.
// badScheduleMsg is the single 400 all three scheduling endpoints answer with.
// One string because they run the same validation: three copies is three places
// for the wording to drift from what parseSchedule actually enforces.
const badScheduleMsg = "media must be audio or video, scheduledAt must be RFC3339 and not in the past, " +
	"durationMinutes must be between 0 and 720"

type schedule struct {
	// At is when the call starts, or nil for "start now".
	At *time.Time
	// EndsAt is when it is scheduled to be over, or nil for no scheduled end.
	EndsAt *time.Time
	Title  string
	Media  string
}

// parseSchedule normalises the request knobs every scheduling endpoint shares.
// Reports false for a media or time this service will not accept, which every
// caller turns into one 400.
func parseSchedule(req scheduleCallReq) (schedule, bool) {
	media := strings.ToLower(strings.TrimSpace(req.Media))
	if media == "" {
		media = "video"
	}
	if media != "audio" && media != "video" {
		return schedule{}, false
	}
	if req.DurationMinutes != nil && (*req.DurationMinutes < 0 || *req.DurationMinutes > maxCallMinutes) {
		return schedule{}, false
	}
	out := schedule{Title: truncateTitle(strings.TrimSpace(req.Title)), Media: media}
	if s := strings.TrimSpace(req.ScheduledAt); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return schedule{}, false
		}
		utc := t.UTC()
		// A meeting cannot be scheduled in the past — "start now" is what an
		// omitted scheduledAt already means, handled above this block. The
		// grace window absorbs clock skew and request latency, not a stale
		// date.
		if utc.Before(time.Now().UTC().Add(-scheduleGraceWindow)) {
			return schedule{}, false
		}
		out.At = &utc
	}
	// Omitted (nil): defaultCallMinutes when scheduled, no scheduled end at
	// all on a "meet now" (EndsAtFor(_, 0) already returns nil for that).
	// An EXPLICIT value — including 0, "No end time" — always wins, whether
	// the call is scheduled or immediate: that is the one case the old bare
	// `int` version of this field could not represent.
	mins := defaultCallMinutes
	switch {
	case req.DurationMinutes != nil:
		mins = *req.DurationMinutes
	case out.At == nil:
		mins = 0
	}
	out.EndsAt = store.EndsAtFor(out.At, time.Duration(mins)*time.Minute)
	return out, true
}

// startRecordingAndReflect starts recording for a call that just went LIVE —
// a "meet now" channel call or meeting, or a scheduled one that was just
// explicitly started — and reflects the outcome onto c so the response the
// caller gets back already carries recordingStatus instead of it arriving a
// refetch later.
//
// Best-effort, matching startRecording's own contract: a deployment with no
// recorder configured, or a DIRECT call, simply does nothing here. Shared by
// every path that can move a call to LIVE, which used to repeat this same
// four-line snippet at each one.
func (s *Server) startRecordingAndReflect(ctx context.Context, c *store.CallDTO) {
	if started, _ := s.startRecording(ctx, c.ID, c.OrgID, c.Kind); started {
		st := store.RecordingInProgress
		c.RecordingStatus = &st
	}
}

// scheduleChannelCall serves POST /api/v1/channels/{id}/calls.
//
// Feature 1. The roster is the channel's membership and is never copied, so
// there is nothing to invite and no link to mint — leaving the channel leaves
// the call, at the next token refresh at the latest.
func (s *Server) scheduleChannelCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var req scheduleCallReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sc, ok := parseSchedule(req)
	if !ok {
		writeErr(w, http.StatusBadRequest, badScheduleMsg)
		return
	}
	c, err := s.store.ScheduleChannelCall(r.Context(), claims.OrgID, claims.UserID,
		channelID, sc.Title, sc.Media, sc.At, sc.EndsAt)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	s.notifyCall(r.Context(), c, events.TypeCallScheduled, claims.UserID)
	// A channel call with no time on it is live already — there is no later
	// "start" to hang the recording off.
	if c.Status == "LIVE" {
		s.startRecordingAndReflect(r.Context(), c)
	}
	writeJSON(w, http.StatusCreated, c)
}

// listChannelCalls serves GET /api/v1/channels/{id}/calls.
func (s *Server) listChannelCalls(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	channelID := chi.URLParam(r, "id")
	if !validUUID(channelID) {
		writeErr(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	_, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	out, err := s.store.ListChannelCalls(r.Context(), claims.OrgID, claims.UserID, channelID, limit)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scheduleMeetingReq is a scheduleCallReq plus what only a meeting can carry.
type scheduleMeetingReq struct {
	scheduleCallReq
	// ChannelIDs are channels whose members are invited. The caller must be in
	// each of them.
	ChannelIDs []string `json:"channelIds"`
	// Recurrence, when set, makes this the first of a repeating series and
	// requires scheduledAt. See meeting_series.go.
	Recurrence *recurrenceReq `json:"recurrence"`
}

// scheduleMeeting serves POST /api/v1/meetings.
//
// Feature 2. Distinct from a channel call precisely because its roster is
// explicit: that is what makes a link meaningful, and what lets someone outside
// the org hold a seat. It may also be addressed to channels (whose members are
// invited) and may repeat; the response is the meeting written, which for a
// series is its first occurrence.
func (s *Server) scheduleMeeting(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req scheduleMeetingReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sc, ok := parseSchedule(req.scheduleCallReq)
	if !ok {
		writeErr(w, http.StatusBadRequest, badScheduleMsg)
		return
	}
	invitees, msg := parseIDList(req.InviteeIDs, maxMeetingInvitees, "invitee")
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	opts, msg := meetingOptions(req, sc)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	c, err := s.store.ScheduleMeetingWithOptions(r.Context(), claims.OrgID, claims.UserID,
		sc.Title, sc.Media, sc.At, sc.EndsAt, invitees, opts)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// One announcement, whether or not it repeats: the first occurrence is what
	// people are being told about. The rest are written quietly as they come
	// inside the horizon, and each one announces itself when it STARTS, exactly
	// as a one-off does.
	s.notifyCall(r.Context(), c, events.TypeCallScheduled, claims.UserID)
	// Same as a channel call: "meet now" has no start request to follow.
	if c.Status == "LIVE" {
		s.startRecordingAndReflect(r.Context(), c)
	}
	writeJSON(w, http.StatusCreated, c)
}

type directCallReq struct {
	PeerID string `json:"peerId"`
	Media  string `json:"media"`
	Title  string `json:"title"`
	// RFC3339. Omit to ring now; set it to schedule the call for later.
	ScheduledAt string `json:"scheduledAt"`
	// How long the call is expected to run; see scheduleCallReq — a pointer
	// for the same reason: an explicit 0 ("No end time") must not collapse
	// into the same case as omitting the field.
	DurationMinutes *int `json:"durationMinutes"`
}

// startDirectCall serves POST /api/v1/calls/direct — a call in a one-to-one
// chat, either now or in the diary.
//
// Channels and meetings could already be scheduled; chats could only ring
// immediately, which is the gap `scheduledAt` closes. It is the same knob, with
// the same RFC3339 parsing and the same "omit it to start now" default as the
// other two endpoints, so a scheduled call behaves identically whichever of the
// three places it was arranged in — including sitting behind the waiting room
// until whoever scheduled it starts it.
func (s *Server) startDirectCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req directCallReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.PeerID) {
		writeErr(w, http.StatusBadRequest, "invalid peerId")
		return
	}
	sc, ok := parseSchedule(scheduleCallReq{
		Title:           req.Title,
		Media:           req.Media,
		ScheduledAt:     req.ScheduledAt,
		DurationMinutes: req.DurationMinutes,
	})
	if !ok {
		writeErr(w, http.StatusBadRequest, badScheduleMsg)
		return
	}
	c, err := s.store.CreateDirectCall(r.Context(), claims.OrgID, claims.UserID,
		req.PeerID, sc.Title, sc.Media, sc.At, sc.EndsAt)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// A scheduled chat call is an appointment the peer needs to see coming; an
	// immediate one is announced by the ring that follows on the signaling
	// path, so it stays quiet here rather than arriving twice.
	if sc.At != nil {
		s.notifyCall(r.Context(), c, events.TypeCallScheduled, claims.UserID)
	}
	writeJSON(w, http.StatusCreated, c)
}

type addParticipantReq struct {
	UserID string `json:"userId"`
}

// addCallParticipant serves POST /api/v1/calls/{id}/participants.
//
// Feature 3. The store enforces that the invitee is in the CALLER's org, so
// this can never be used to bring an outsider into a channel call — cross-org
// entry exists on the link path alone.
func (s *Server) addCallParticipant(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req addParticipantReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !validUUID(req.UserID) {
		writeErr(w, http.StatusBadRequest, "invalid userId")
		return
	}
	if err := s.store.AddParticipant(r.Context(), claims.OrgID, claims.UserID, callID, req.UserID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	c, err := s.store.GetCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// Ring the newcomer specifically, then refresh the room for everyone else.
	s.ringUsers(r.Context(), c, []string{req.UserID}, events.TypeCallRing, claims.UserID)
	s.notifyCall(r.Context(), c, events.TypeCallParticipantAdded, claims.UserID)
	writeJSON(w, http.StatusOK, c)
}

type createInviteReq struct {
	// Seconds. Clamped to maxInviteTTL.
	TTLSeconds int  `json:"ttlSeconds"`
	MaxUses    *int `json:"maxUses"`
}

// createCallInvite serves POST /api/v1/calls/{id}/invites. MEETINGS ONLY.
func (s *Server) createCallInvite(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req createInviteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	ttl := defaultInviteTTL
	if req.TTLSeconds > 0 {
		ttl = time.Duration(req.TTLSeconds) * time.Second
		if ttl > maxInviteTTL {
			ttl = maxInviteTTL
		}
	}
	if req.MaxUses != nil && *req.MaxUses <= 0 {
		writeErr(w, http.StatusBadRequest, "maxUses must be positive when set")
		return
	}
	inv, err := s.store.CreateInvite(r.Context(), claims.OrgID, claims.UserID, callID, ttl, req.MaxUses)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// The token is in this response and nowhere else, ever again.
	writeJSON(w, http.StatusCreated, inv)
}

// revokeCallInvite serves DELETE /api/v1/calls/{id}/invites/{inviteId}.
func (s *Server) revokeCallInvite(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	inviteID := chi.URLParam(r, "inviteId")
	if !validUUID(callID) || !validUUID(inviteID) {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	if err := s.store.RevokeInvite(r.Context(), claims.OrgID, claims.UserID, callID, inviteID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type joinByTokenReq struct {
	Token string `json:"token"`
}

// joinCallByToken serves POST /api/v1/calls/join.
//
// THE cross-org entry point, and the only one. The caller is a fully
// authenticated BlissWork user — this is not an anonymous guest door — but
// their org is irrelevant to the decision, which rests entirely on holding a
// live token. On success they gain a participant row stamped with their OWN
// org, which is what the calls RLS policy reads to let them see the meeting.
func (s *Server) joinCallByToken(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req joinByTokenReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	tok := strings.TrimSpace(req.Token)
	if tok == "" || len(tok) > 128 {
		// Length-bound before hashing: the token is a fixed-size base64url
		// string, so anything else is not worth a database round trip.
		s.mapErrR(w, r, store.ErrInviteInvalid)
		return
	}
	c, err := s.store.RedeemInvite(r.Context(), claims.OrgID, claims.UserID, tok)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	s.notifyCall(r.Context(), c, events.TypeCallParticipantAdded, claims.UserID)
	writeJSON(w, http.StatusOK, c)
}

// getCall serves GET /api/v1/calls/{id}.
func (s *Server) getCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	c, err := s.store.GetCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// listMyCalls serves GET /api/v1/calls — everything the caller is expected at,
// including meetings hosted by another org.
// onCallUsers serves GET /api/v1/calls/on-call — everyone in this org who is in
// a live call right now.
//
// The client merges it with the presence set to render "Busy" instead of
// "Online". Deliberately UNBOUNDED, unlike /presence/query: presence scales with
// the size of the organisation, but this scales with concurrent call
// participants, which is small by physics — nobody has ten thousand people in
// calls at once, and if they do, the meeting is the problem.
func (s *Server) onCallUsers(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	ids, err := s.store.OnCallUserIDs(r.Context(), claims.OrgID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ids)
}

func (s *Server) listMyCalls(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	_, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
	out, err := s.store.ListMyCalls(r.Context(), claims.OrgID, claims.UserID, limit)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// callTokenResp carries everything the client needs to open the room.
type callTokenResp struct {
	// State is always "JOINED" here, and "WAITING" on callWaitingResp. The two
	// responses are told apart by status code as well, but a discriminant in
	// the body is what lets the client parse one union instead of branching on
	// the transport.
	State     string `json:"state"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	Room      string `json:"room"`
	Identity  string `json:"identity"`
	ExpiresAt string `json:"expiresAt"`
	Role      string `json:"role"`
}

// callWaitingResp is the waiting room: the caller belongs in this call, and the
// call has not started.
//
// It carries NO token, which is the entire enforcement. A client that ignores
// this response and tries to open the room anyway has nothing to open it with —
// the lobby is a fact about what the server issued, not a screen the client is
// trusted to display.
type callWaitingResp struct {
	State  string `json:"state"`
	CallID string `json:"callId"`
	Status string `json:"status"`
	// CanStart tells the organiser their button does something, and everyone
	// else that they are waiting on somebody. Answering it here saves the
	// client working out org and channel roles it cannot see.
	CanStart bool `json:"canStart"`
}

// callToken serves POST /api/v1/calls/{id}/token — the gate in front of media,
// and the door of the waiting room.
//
// Deliberately a POST and deliberately short-lived: it mints a credential, it
// is not a cacheable read. Access is re-decided from the database on every
// refresh, which is what makes removal from a channel actually take effect.
//
// That re-decision is not free, and the waiting room is what makes the cost
// visible: everyone held in a lobby calls this again whenever they want to know
// if the call has opened. So the transition is PUSHED — startCall fans
// `call.started` out to the whole roster — and the client's timer is only a
// backstop for a dropped socket. A five-hundred person meeting waiting on a
// late host should cost approximately nothing, not five hundred access
// decisions per poll interval.
//
// Two outcomes, and the status code distinguishes them:
//
//	200  a token. The call is under way and the caller is in it.
//	202  the waiting room. The caller belongs here, but the call has not been
//	     started by anyone entitled to start it, so no token exists yet.
func (s *Server) callToken(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	if !s.livekit.Configured() {
		s.mapErrR(w, r, livekit.ErrNotConfigured)
		return
	}
	access, err := s.store.AuthorizeCallAccess(
		r.Context(), claims.OrgID, claims.UserID, callID, claims.Roles)
	if err != nil {
		// Kind is unknown here — AuthorizeCallAccess failed before it could
		// resolve one — so this is the one place CallTypeUnknown is used.
		metrics.CallAttemptTotal.WithLabelValues(metrics.CallTypeUnknown).Inc()
		metrics.CallFailedTotal.WithLabelValues(metrics.CallTypeUnknown, callFailReason(err)).Inc()
		s.mapErrR(w, r, err)
		return
	}
	if access.Waiting {
		// Tell whoever could start the call that somebody is here for it —
		// once, on arrival, not on every poll that follows.
		if access.NewlyWaiting {
			s.notifyStarters(r.Context(), callID, claims.UserID)
		}
		// The only trace this endpoint left before: either outcome, so a stuck
		// client can be told apart from a client that never reached the server
		// at all without needing ad-hoc diagnostic logging re-added after the
		// fact.
		s.log.Info("call token request", "call", callID, "user", claims.UserID, "state", "WAITING")
		writeJSON(w, http.StatusAccepted, callWaitingResp{
			State:    "WAITING",
			CallID:   callID,
			Status:   access.Status,
			CanStart: access.CanStart,
		})
		return
	}
	// The room label is the member's DISPLAY NAME, not the JWT's `username` —
	// that field is the email local-part auth-svc derived at signup, so minting
	// with it put address fragments ("siddhant.shende", "mayank@example.com")
	// on the video tiles. The store resolved the real name under the caller's
	// own org scope; claims.Username remains only as the last resort for a
	// member with no projection row yet.
	callType := metrics.CallTypeFor(access.Kind)
	name := access.DisplayName
	if name == "" {
		name = claims.Username
	}
	tok, exp, err := s.livekit.Mint(livekit.Grant{
		Room:     access.CallID,
		Identity: claims.UserID,
		Name:     name,
		// Everyone on the roster may publish. A view-only role would be a
		// product decision this feature has not been asked for; the grant shape
		// already supports it when it is.
		CanPublish: true,
		// Screen sharing is granted with the room token rather than per-share:
		// LiveKit permissions are fixed for the life of a connection, so gating
		// it any later would mean reissuing a token and reconnecting in the
		// middle of a call. Who is ACTUALLY sharing, and who may stop them, is
		// tracked in call_screenshares — see store/calls_sharing.go.
		CanShareScreen: true,
		RoomAdmin:      access.Role == store.RoleHost,
	})
	if err != nil {
		metrics.CallAttemptTotal.WithLabelValues(callType).Inc()
		metrics.CallFailedTotal.WithLabelValues(callType, metrics.FailReasonLiveKitConnection).Inc()
		s.mapErrR(w, r, err)
		return
	}
	if err := s.store.MarkJoined(r.Context(), claims.OrgID, claims.UserID, callID); err != nil {
		metrics.CallAttemptTotal.WithLabelValues(callType).Inc()
		metrics.CallFailedTotal.WithLabelValues(callType, callFailReason(err)).Inc()
		s.mapErrR(w, r, err)
		return
	}
	metrics.CallAttemptTotal.WithLabelValues(callType).Inc()
	s.log.Info("call token request", "call", callID, "user", claims.UserID, "state", "JOINED")
	writeJSON(w, http.StatusOK, callTokenResp{
		State:     "JOINED",
		URL:       s.livekit.URL(),
		Token:     tok,
		Room:      access.CallID,
		Identity:  claims.UserID,
		ExpiresAt: exp.Format("2006-01-02T15:04:05.000Z"),
		Role:      access.Role,
	})
}

// callTelemetryReq bounds callTelemetry's accepted body to exactly two
// events. Anything else is a 400, not a new label some future client could
// invent unboundedly.
type callTelemetryReq struct {
	// Event is "reconnected" or "setup_complete" — see callTelemetry.
	Event string `json:"event"`
	// SetupMs is required for "setup_complete", ignored otherwise: the
	// client's own measured milliseconds from requesting this call's token to
	// its LiveKit Room reporting Connected.
	SetupMs *int `json:"setupMs,omitempty"`
}

// maxCallSetupMs bounds what callTelemetry will record into
// CallSetupDurationSeconds. Five minutes is already far past anything a real
// join could plausibly take (the histogram's own top bucket is 30s) — this
// exists only to keep a buggy or hostile client from writing an
// observation so large it would distort percentile math for everyone else's
// dashboards, not to model a real setup time.
const maxCallSetupMs = 5 * 60 * 1000

// callTelemetry serves POST /api/v1/calls/{id}/telemetry — see
// metrics/calls.go's package doc comment for why this endpoint exists and,
// just as importantly, why it accepts only these two events. It cannot
// report a call as "connected" or "dropped": those stay derived from
// LiveKit's own webhook, because a client is not a trustworthy witness to its
// own connection outcome, only to how long things took.
//
// The caller only needs to be ON the call, same bar as callToken; GetCall's
// existing RLS-scoped visibility is enough to resolve call_type without a new
// query, and this is not sensitive data — reusing it here does not need a
// bespoke roster check.
func (s *Server) callTelemetry(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req callTelemetryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	call, err := s.store.GetCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	callType := metrics.CallTypeFor(call.Kind)
	switch req.Event {
	case "reconnected":
		metrics.CallReconnectTotal.WithLabelValues(callType).Inc()
	case "setup_complete":
		if req.SetupMs == nil || *req.SetupMs < 0 || *req.SetupMs > maxCallSetupMs {
			writeErr(w, http.StatusBadRequest, "setupMs out of range")
			return
		}
		metrics.CallSetupDurationSeconds.WithLabelValues(callType).Observe(float64(*req.SetupMs) / 1000)
	default:
		writeErr(w, http.StatusBadRequest, "unknown event")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// startCall serves POST /api/v1/calls/{id}/start — the act the waiting room is
// waiting for.
//
// Restricted to the people canStartCallTx names: the organiser (and any host
// they appointed), an org admin of the hosting org, or an owner/admin of the
// channel a CHANNEL call belongs to. Everyone else on the roster may arrive at
// any time and will be held until one of them does this.
//
// Admission is collective and automatic. There is no per-person approval to
// make here, and deliberately no endpoint offering one: starting the call
// empties the lobby in a single statement and everyone in it is let in at once.
func (s *Server) startCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	c, admitted, err := s.store.StartCall(
		r.Context(), claims.OrgID, claims.UserID, callID, claims.Roles)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// To the WHOLE roster, not just the people who were waiting: the ones in
	// the lobby need to come in, and the ones who have not opened it yet need
	// to know it is under way. `admitted` is logged rather than used to narrow
	// this, because a client that arrives between the UPDATE and this fan-out
	// would otherwise never be told.
	s.notifyCall(r.Context(), c, events.TypeCallStarted, claims.UserID)
	// Recording begins with the call, on a deployment that records at all. The
	// response is written after it so `recordingStatus` on the call the starter
	// gets back is already true rather than arriving a refetch later.
	s.startRecordingAndReflect(r.Context(), c)
	s.log.Info("call started", "call", callID, "by", claims.UserID, "admitted", len(admitted))
	writeJSON(w, http.StatusOK, c)
}

type shareScreenReq struct {
	// One of screen / window / tab, or the displaySurface value a browser
	// reports for the same three things (monitor / window / browser).
	Source string `json:"source"`
}

// startScreenShare serves POST /api/v1/calls/{id}/share.
//
// Records what the caller has begun sharing and tells the room. The media
// itself goes to the SFU on the connection the room token already authorised —
// this is how the room AGREES on what is being shared, so that someone who
// joins mid-share is told about it instead of inferring it from whichever
// tracks happen to arrive first.
func (s *Server) startScreenShare(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	var req shareScreenReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	sh, err := s.store.StartScreenShare(
		r.Context(), claims.OrgID, claims.UserID, callID, req.Source)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	s.notifyShare(r.Context(), callID, events.TypeCallShareStarted, claims.UserID, sh.Source)
	writeJSON(w, http.StatusCreated, sh)
}

// stopScreenShare serves POST /api/v1/calls/{id}/share/stop.
//
// THE STOP CONTROL BELONGS TO THE SHARER. That requirement is met by the shape
// of this endpoint rather than by a permission check inside it: there is no
// target parameter, so it can only ever stop the caller's own share, and no
// request another participant can construct will end yours. The store and the
// RLS policy behind it hold the same line.
//
// The corresponding client rule — that the "you are sharing your screen / stop
// sharing" prompt is rendered for the sharer alone — is supported by the events
// this emits carrying `actorId`, so every other client learns a share started
// without being handed anything to stop it with.
func (s *Server) stopScreenShare(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	if err := s.store.StopScreenShare(r.Context(), claims.OrgID, claims.UserID, callID); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	s.notifyShare(r.Context(), callID, events.TypeCallShareStopped, claims.UserID, "")
	w.WriteHeader(http.StatusNoContent)
}

// leaveCall serves POST /api/v1/calls/{id}/leave. Also serves as "give up
// waiting" — someone who leaves the lobby is no longer in it.
//
// A HOST leaving ends the call, which is why this can emit `call.ended`: the
// meeting belongs to whoever is hosting it, and the ways they actually leave —
// the hang-up button, closing the tab, navigating away — all arrive here and
// none of them press End. See store.LeaveCall.
func (s *Server) leaveCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	recorded, wasSharing, ended, err := s.store.LeaveCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	// The whole roster is told the call is over — that is what drops everyone
	// else out of the room rather than leaving them in one nobody is hosting.
	// Announced BEFORE the share notice is skipped: `call.ended` already says
	// the room is gone, so a separate "their share stopped" is noise.
	//
	// endedCallSideEffects, not the notify+stopRecording pair inline: this is
	// one of the four ways a call ends its own doc comment names, and closing
	// the SFU room is what makes ending authoritative instead of a database
	// fact every client is trusted to act on — a host who closes their laptop
	// rather than pressing End must not leave the room open behind them either.
	if ended != nil {
		s.endedCallSideEffects(r.Context(), ended, claims.UserID)
		s.log.Info("call ended by host leaving", "call", callID, "by", claims.UserID)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Walking out ends your share. The SFU will drop the track by itself, but
	// the room's record of who is sharing comes from these events, so a leave
	// that skipped this would leave every client showing a share that stopped.
	if wasSharing {
		s.notifyShare(r.Context(), callID, events.TypeCallShareStopped, claims.UserID, "")
	}
	// `recorded` is false on a double-submitted/retried leave (the row was
	// already closed), which would otherwise announce the same departure
	// twice — once from this request, once from the one that actually closed
	// it (or from the SFU webhook racing it, see MarkLeftFromSFU).
	if recorded {
		s.notifyParticipantLeft(r.Context(), callID, claims.UserID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// endCall serves POST /api/v1/calls/{id}/end. Hosts only; also revokes every
// outstanding join link in the same transaction.
func (s *Server) endCall(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErr(w, http.StatusBadRequest, "invalid call id")
		return
	}
	// One call, and it is the one AFTER the end: EndCall returns the ended row,
	// so the event carries status ENDED and a real endedAt. Reading the call
	// first and announcing that instead described a call that was still live.
	//
	// Nil means this request did not end anything — the call was already over.
	// Still a 204, because the caller asked for a state that holds; announcing
	// it a second time would tell every client the same call ended twice.
	c, err := s.store.EndCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	if c != nil {
		// Announce, stop the recording, then CLOSE THE ROOM — see
		// endedCallSideEffects for the ordering and for why deleting the room
		// is what makes ending authoritative rather than a database fact every
		// client is trusted to act on. Shared with the two ways a call now ends
		// without anybody pressing this button.
		s.endedCallSideEffects(r.Context(), c, claims.UserID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// closeRoom disconnects everyone still in the SFU room for a call that has
// ended. Best-effort by design: the call is already committed and every client
// has been told, so a failure here is logged rather than returned — a 500 would
// tell the organiser their End button did not work when it did.
//
// WithoutCancel: an organiser who navigates away the instant they press End
// must not leave the room open behind them. The timeout inside DeleteRoom still
// bounds it.
func (s *Server) closeRoom(callID string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), roomCloseTimeout)
	defer cancel()
	if err := s.livekit.DeleteRoom(ctx, callID); err != nil {
		if errors.Is(err, livekit.ErrNotConfigured) {
			return // calling is not set up on this deployment; nothing to close
		}
		s.log.Error("could not close the room after ending the call",
			"call_id", callID, "err", err)
	}
}

// Bounds what closing the room can add to the end-call request.
const roomCloseTimeout = 6 * time.Second

// ── Notification helpers ─────────────────────────────────────────────────────
//
// Both go through the transactional outbox rather than talking to ws-gateway
// directly. That matters for the cross-org case: the gateway's Kafka fan-out
// routes purely by the event's `members` list and has never inspected orgs, so
// a meeting notification reaches an external participant with no change to the
// gateway at all. The same-org rule stays exactly where it was, on the RTC
// signaling path, which calls do not use now that media goes to the SFU.
//
// Failures are logged, not returned: the call itself is already committed, and
// refusing the request because a notification did not fan out would turn a
// cosmetic problem into a broken feature. Clients also refetch on reconnect.

// notifyCall tells the whole roster something happened.
func (s *Server) notifyCall(ctx context.Context, c *store.CallDTO, evtType, actorID string) {
	if err := s.store.EmitCallLifecycle(ctx, c, store.CallNotice{
		Type:    evtType,
		ActorID: actorID,
	}); err != nil {
		s.log.Warn("call notify failed", "call", c.ID, "type", evtType, "err", err)
	}
}

// ringUsers notifies a specific subset — the person just added, rather than
// everyone already in the room.
func (s *Server) ringUsers(ctx context.Context, c *store.CallDTO, users []string, evtType, actorID string) {
	if len(users) == 0 {
		return
	}
	if err := s.store.EmitCallLifecycle(ctx, c, store.CallNotice{
		Type:       evtType,
		ActorID:    actorID,
		Recipients: users,
	}); err != nil {
		s.log.Warn("call ring failed", "call", c.ID, "type", evtType, "err", err)
	}
}

// notifyStarters tells the people who could start this call that somebody has
// turned up for it.
//
// Addressed to them alone, and NOT an approval request — there is nothing to
// approve. It exists because the alternative is an organiser sitting in another
// window with no idea their meeting has an audience, while the audience waits
// on them.
//
// Re-reads the call rather than taking one, because the caller here is the
// token endpoint, which has no CallDTO in hand and should not pay for one on
// the polling path that does not need it.
func (s *Server) notifyStarters(ctx context.Context, callID, waiterID string) {
	starters, err := s.store.CallStarterIDs(ctx, callID)
	if err != nil {
		s.log.Warn("call waiting notify failed", "call", callID, "err", err)
		return
	}
	// Whoever arrived is not told they arrived, even if they could have
	// started it themselves — which they cannot, since a caller who CanStart is
	// never recorded as waiting in the first place.
	starters = withoutID(starters, waiterID)
	if len(starters) == 0 {
		return
	}
	c, err := s.store.CallForNotify(ctx, callID)
	if err != nil {
		s.log.Warn("call waiting notify failed", "call", callID, "err", err)
		return
	}
	if err := s.store.EmitCallLifecycle(ctx, c, store.CallNotice{
		Type:       events.TypeCallWaiting,
		ActorID:    waiterID,
		Recipients: starters,
	}); err != nil {
		s.log.Warn("call waiting notify failed", "call", callID, "err", err)
	}
}

// notifyShare tells the room that a screen share started or stopped.
//
// Everyone in the call is told, including the sharer — their own client needs
// the confirmation, and every other client needs to know a tile is coming. What
// distinguishes them is `actorId`: it names the one person whose screen this
// is, and therefore the only person whose UI should offer to stop it.
func (s *Server) notifyShare(ctx context.Context, callID, evtType, actorID, source string) {
	c, err := s.store.CallForNotify(ctx, callID)
	if err != nil {
		s.log.Warn("share notify failed", "call", callID, "type", evtType, "err", err)
		return
	}
	if err := s.store.EmitCallLifecycle(ctx, c, store.CallNotice{
		Type:        evtType,
		ActorID:     actorID,
		ShareSource: source,
	}); err != nil {
		s.log.Warn("share notify failed", "call", callID, "type", evtType, "err", err)
	}
}

// notifyParticipantLeft tells the room someone left it, without ending it.
//
// Addressed to the remaining roster (so a participant count updates promptly)
// AND the leaver themselves (so their OTHER open sessions/devices learn they
// are not on this call anymore) — LiveParticipantIDs alone would miss the
// leaver, since their own row's left_at is already set by the time this runs.
func (s *Server) notifyParticipantLeft(ctx context.Context, callID, leaverID string) {
	c, err := s.store.CallForNotify(ctx, callID)
	if err != nil {
		s.log.Warn("participant-left notify failed", "call", callID, "err", err)
		return
	}
	live, err := s.store.LiveParticipantIDs(ctx, callID)
	if err != nil {
		s.log.Warn("participant-left notify failed", "call", callID, "err", err)
		return
	}
	if err := s.store.EmitCallLifecycle(ctx, c, store.CallNotice{
		Type:       events.TypeCallParticipantLeft,
		ActorID:    leaverID,
		Recipients: append(live, leaverID),
	}); err != nil {
		s.log.Warn("participant-left notify failed", "call", callID, "err", err)
	}
}

// withoutID returns ids with one value removed.
func withoutID(ids []string, drop string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != drop {
			out = append(out, id)
		}
	}
	return out
}

// callRangeMaxSpan mirrors store.MaxCallRangeDays so a nonsense window is
// refused as a bad request here rather than being silently clamped into a
// smaller answer than the caller asked for — the store still clamps, because it
// is reachable from more than one caller.
const callRangeMaxSpan = store.MaxCallRangeDays * 24 * time.Hour

// listMyCallsInRange serves GET /api/v1/calls/range?from=&to= — the calendar
// read.
//
// Separate from GET /api/v1/calls rather than a mode of it, for the reason
// store/calls_range.go gives at length: /calls answers "what am I expected at"
// and caps finished calls at a month, which is right for Upcoming and Live and
// leaves a calendar navigated into last quarter looking empty. Both bounds are
// the window's own, so there is no cursor — a week is a week.
//
// `from` and `to` are RFC3339 instants, and the client sends the local
// boundaries of the grid it is about to draw. Half-open [from, to): a meeting
// starting exactly at `to` belongs to the next window, not to two.
func (s *Server) listMyCallsInRange(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())

	from, err := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "from must be an RFC3339 timestamp")
		return
	}
	to, err := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "to must be an RFC3339 timestamp")
		return
	}
	if !to.After(from) {
		writeErr(w, http.StatusBadRequest, "to must be after from")
		return
	}
	if to.Sub(from) > callRangeMaxSpan {
		writeErr(w, http.StatusBadRequest, "range is too wide")
		return
	}

	out, err := s.store.ListMyCallsInRange(r.Context(), claims.OrgID, claims.UserID, from, to)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
