package api

// Call recordings: asking for one, playing it back, and hearing how it went.
//
// Three routes, and they live in three different security worlds — which is the
// reason this file exists rather than another block in calls.go:
//
//	GET  /api/v1/calls/{id}/recording   authed like every other call read.
//	GET  /recordings/{id}?t=…           NO JWT. A browser cannot put an
//	                                    Authorization header on <video src>, so
//	                                    the signed token authenticates and the
//	                                    store re-authorizes on every hit —
//	                                    exactly the attachment posture.
//	POST /livekit/webhook               NO JWT either, and not our user at all:
//	                                    this is the SFU reporting a finished
//	                                    file, authenticated by a signature over
//	                                    the body.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// recordingResp is the recording plus the one thing that is not stored: a link
// minted for THIS caller, valid for MEDIA_URL_TTL_SECONDS.
type recordingResp struct {
	store.CallRecordingDTO
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// getCallRecording serves GET /api/v1/calls/{id}/recording.
//
// 404 for a call with no recording is a STATE, not a failure: most calls are
// not recorded. It is also what a call the caller may not see returns, and
// deliberately so — a distinguishable answer would say whether a meeting they
// are not in was recorded.
func (s *Server) getCallRecording(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid call id")
		return
	}
	rec, err := s.store.RecordingForCall(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	exp := time.Now().Add(s.mediaCfg.URLTTL)
	tok := s.signer.Sign(media.Grant{
		AttachmentID: rec.ID,
		Kind:         media.KindRecording,
		OrgID:        claims.OrgID,
		UserID:       claims.UserID,
		Exp:          exp,
	})
	writeJSON(w, http.StatusOK, recordingResp{
		CallRecordingDTO: *rec,
		URL:              "/recordings/" + rec.ID + "?t=" + tok,
		ExpiresAt:        exp.UTC().Format(time.RFC3339),
	})
}

// downloadRecording streams the recording's bytes.
//
// Same shape as downloadMedia, and for the same reasons: the token
// authenticates, the store AUTHORIZES on every hit — so someone who loses their
// seat in the call's org stops being able to play it back at their next
// request, not at token expiry — and http.ServeContent supplies Range, which is
// what makes an hour-long video seekable instead of a single 400 MB read.
func (s *Server) downloadRecording(w http.ResponseWriter, r *http.Request) {
	grant, err := s.signer.Verify(r.URL.Query().Get("t"))
	if err != nil {
		// Uniform on purpose: expired, forged and malformed are one answer.
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}
	id := chi.URLParam(r, "id")
	if id != grant.AttachmentID || grant.Kind != media.KindRecording {
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}
	rec, err := s.store.RecordingForPlayback(r.Context(), grant.OrgID, grant.UserID, id)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	f, err := s.blobs.OpenKey(rec.StorageKey)
	if err != nil {
		// The row says READY and the bytes are not there. That is an operator
		// problem — a half-migrated volume, a bucket lifecycle rule — and the
		// viewer can only be told there is nothing to play.
		s.log.Error("recording blob missing", "recording_id", id,
			"request_id", mw.RequestIDFromContext(r.Context()), "err", err)
		writeAPIError(w, r, http.StatusNotFound, CodeNotFound, "recording not found")
		return
	}
	defer f.Close()

	h := w.Header()
	h.Set("Content-Type", rec.Mime)
	h.Set("Content-Disposition", media.ContentDisposition(true, "recording."+livekit.Extension))
	h.Set("X-Content-Type-Options", "nosniff")
	// Private: the bytes never change, but the LINK is per-user and short-lived.
	h.Set("Cache-Control", "private, max-age=600, immutable")
	h.Set("ETag", `"`+rec.ID+`"`)
	h.Set("Content-Security-Policy",
		"default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	http.ServeContent(w, r, "", f.ModTime(), f)
}

// livekitWebhook serves POST /livekit/webhook — the SFU telling us what
// happened in a room, and how a recording ended.
//
// Unauthenticated in the JWT sense and public by necessity: the sender is
// LiveKit, which holds no BlissWork account. What makes it safe is the
// signature over the body, checked before a byte of the payload is trusted.
//
// TWO readers, on one route because LiveKit posts every event to one URL:
//
//   - the ROOM reader (handleRoomEvent) is the authoritative answer to "who is
//     actually still in this call". Tried first, and on the Minter rather than
//     the Recorder, because it must work on a deployment with no recording at
//     all — otherwise whether somebody shows as "Busy" forever would depend on
//     whether calls happen to be recorded.
//   - the RECORDING reader settles call_recordings, unchanged.
//
// It answers 200 to everything it can authenticate, including events neither
// reader acts on. The SFU retries a non-2xx, and there is nothing to retry for
// an event about a room or a recording this deployment has no row for.
func (s *Server) livekitWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, smallBody))
	if err != nil {
		writeErrR(w, r, http.StatusBadRequest, "unreadable body")
		return
	}
	auth := r.Header.Get("Authorization")

	// Room lifecycle first. A signature this accepts is the same signature the
	// recorder would check — one key pair, one check (livekit.verifyWebhook) —
	// so an event that is not about a room falls through to the recording path
	// without being re-authenticated against a different rule.
	// Whether the body's signature has already been checked. Tracked rather
	// than assumed: it is what decides, below, whether "recording is switched
	// off" means an authenticated event with nothing to settle (200) or a
	// deployment that cannot authenticate this POST at all (401).
	verified := false
	if s.livekit.Configured() {
		ev, err := s.livekit.ParseRoomWebhook(auth, body)
		if err != nil {
			s.log.Warn("livekit webhook rejected", "err", err,
				"request_id", mw.RequestIDFromContext(r.Context()))
			writeAPIError(w, r, http.StatusUnauthorized, CodeForbidden, "invalid webhook signature")
			return
		}
		verified = true
		if ev.Event != "" {
			s.handleRoomEvent(r.Context(), ev)
			w.WriteHeader(http.StatusOK)
			return
		}
	}

	ev, err := s.recorder.ParseWebhook(auth, body)
	if err != nil {
		// An event whose signature the room reader ALREADY accepted, on a
		// deployment that records nothing. There is no row to settle and
		// nothing to retry, so it is a 200 rather than a refusal.
		//
		// Only when `verified`. Without that check, an SFU-less deployment —
		// where nothing holds a key and nothing can be authenticated — would
		// answer 200 to an unsigned POST from anywhere, which is precisely the
		// probe this route's signature check exists to refuse.
		if verified && errors.Is(err, livekit.ErrEgressNotConfigured) {
			w.WriteHeader(http.StatusOK)
			return
		}
		// Logged at warn, not error: an unsigned POST here is somebody probing,
		// and the honest response is to refuse it without noise.
		s.log.Warn("livekit webhook rejected", "err", err,
			"request_id", mw.RequestIDFromContext(r.Context()))
		writeAPIError(w, r, http.StatusUnauthorized, CodeForbidden, "invalid webhook signature")
		return
	}
	if !ev.Ended || ev.EgressID == "" {
		w.WriteHeader(http.StatusOK)
		return
	}
	res := store.RecordingResult{
		EgressID:   ev.EgressID,
		Mime:       livekit.MimeType,
		SizeBytes:  ev.SizeBytes,
		DurationMs: ev.DurationMs,
		Error:      ev.Error,
	}
	// Egress reports where it actually wrote. Accepted only if it is still a
	// key this service would have produced — a filename from the wire becomes a
	// path on the fs backend, and validating it here is cheaper than trusting
	// the sender because the sender is usually right.
	if ev.Filename != "" && blob.ParseRecordingKey(ev.Filename) == nil {
		res.StorageKey = ev.Filename
	}
	if err := s.store.CompleteRecording(r.Context(), res); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// ── Lifecycle, called from the call handlers ─────────────────────────────────

// recordingStartTimeout bounds what starting a recording can add to the request
// that opened the call. The SFU only queues the egress and answers, so this is
// generous; what it really bounds is an SFU that cannot be reached at all,
// which must not become several seconds of "Start meeting" doing nothing.
const recordingStartTimeout = 5 * time.Second

// startRecording asks the SFU to record a call that has just been opened.
//
// Best-effort BY DESIGN. It is called on the path of somebody pressing "Start
// meeting", and a recording that cannot be started must not stop the meeting
// from starting — so every failure here is logged and swallowed. What is not
// swallowed is the fact of it: nothing is written to call_recordings, so the
// call simply has no recording rather than a phantom one, and the client is
// told nothing is being recorded because nothing is.
//
// ── What is and is not recorded ──────────────────────────────────────────────
// Meetings and channel calls, never a one-to-one. A 1:1 is the closest thing
// this product has to a phone call between two people, and silently recording
// those on a deployment-wide switch is not a default anyone should be able to
// set on someone else's behalf. Everything that IS recorded says so on the call
// itself, through CallDTO.RecordingStatus.
// Returns whether a recording is now running, so the caller can say so on the
// call it is about to write back without re-reading it.
func (s *Server) startRecording(ctx context.Context, callID, orgID, kind string) bool {
	if !s.recorder.Configured() || kind == "DIRECT" {
		return false
	}
	// WithoutCancel: a client that navigates away mid-request must not leave an
	// egress running that nothing has a row for. The timeout still applies.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordingStartTimeout)
	defer cancel()
	// The id is minted HERE, before anything starts, because the file name is
	// part of the request TO egress and the row has to agree with it. Naming the
	// file after the egress id instead would mean asking egress to write to a
	// path derived from an id it has not issued yet: the file lands in one place
	// and playback looks in another.
	id := uuid.Must(uuid.NewV7()).String()
	key, err := blob.RecordingKey(orgID, callID, id, livekit.Extension)
	if err != nil {
		s.log.Error("recording key", "call_id", callID, "err", err)
		return false
	}
	// The room name IS the call id (see livekit.Grant.Room), so there is no
	// mapping to get wrong here either.
	egressID, err := s.recorder.StartRoom(ctx, callID, key)
	if err != nil {
		s.log.Error("could not start recording", "call_id", callID, "err", err)
		return false
	}
	if err := s.store.StartRecording(ctx, id, callID, egressID, key); err != nil {
		// The egress is running and nothing knows about it. Stop it rather than
		// leave a recording nobody can reach writing to storage for an hour.
		s.log.Error("could not record that a recording started",
			"call_id", callID, "egress_id", egressID, "err", err)
		if serr := s.recorder.Stop(ctx, egressID); serr != nil {
			s.log.Error("could not stop an unrecorded egress",
				"egress_id", egressID, "err", serr)
		}
		return false
	}
	return true
}

// stopRecording ends the egress for a call that has ended.
//
// Also best-effort, and for a stronger reason: egress stops on its own when the
// room empties, so this is a prompt rather than the mechanism. What it does buy
// is the FAILED row when the SFU cannot be reached at all, which is the
// difference between "no recording" and a row stuck in RECORDING for ever.
func (s *Server) stopRecording(ctx context.Context, callID string) {
	if !s.recorder.Configured() {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), recordingStartTimeout)
	defer cancel()
	egressID, err := s.store.LiveRecordingEgressID(ctx, callID)
	if err != nil || egressID == "" {
		if err != nil {
			s.log.Error("could not look up a running recording", "call_id", callID, "err", err)
		}
		return
	}
	if err := s.recorder.Stop(ctx, egressID); err != nil {
		s.log.Error("could not stop recording", "call_id", callID,
			"egress_id", egressID, "err", err)
		if serr := s.store.StopRecording(ctx, egressID, "egress could not be stopped"); serr != nil {
			s.log.Error("could not mark a recording stopped", "egress_id", egressID, "err", serr)
		}
	}
}

// startCallRecording serves POST /api/v1/calls/{id}/recording/start.
//
// The manual half of the same mechanism the call lifecycle uses: a host who
// wants a record of the next twenty minutes should not have to have decided
// that before the meeting opened.
//
// Hosts only, and the store says so — see AuthorizeRecordingControl. A
// deployment with no egress answers 503 rather than pretending: "recording
// started" followed by no recording is the one outcome this feature must not
// have.
func (s *Server) startCallRecording(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid call id")
		return
	}
	if !s.recorder.Configured() {
		s.mapErrR(w, r, livekit.ErrEgressNotConfigured)
		return
	}
	target, err := s.store.AuthorizeRecordingControl(r.Context(), claims.OrgID, claims.UserID, callID)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	if target.Kind == "DIRECT" {
		// The same rule the automatic path enforces, stated where a request can
		// reach it: a one-to-one call is not recorded, by anybody.
		writeErrR(w, r, http.StatusBadRequest, "one-to-one calls are not recorded")
		return
	}
	if !s.startRecording(r.Context(), target.CallID, target.OrgID, target.Kind) {
		// startRecording has already logged why. To the caller this is one
		// thing: the SFU would not start it.
		writeAPIError(w, r, http.StatusServiceUnavailable, CodeServiceUnavailable,
			"couldn't start recording")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"recordingStatus": store.RecordingInProgress})
}

// stopCallRecording serves POST /api/v1/calls/{id}/recording/stop.
//
// POST rather than DELETE for the same reason the rest of this API prefers it:
// the edge WAF refuses bodyless write verbs on some deployments, and stopping a
// recording is not worth being the route that discovers it.
//
// Idempotent: stopping a call that is not being recorded is a no-op, not an
// error. The caller asked for a state that already holds.
func (s *Server) stopCallRecording(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	callID := chi.URLParam(r, "id")
	if !validUUID(callID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid call id")
		return
	}
	if _, err := s.store.AuthorizeRecordingControl(
		r.Context(), claims.OrgID, claims.UserID, callID,
	); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	s.stopRecording(r.Context(), callID)
	w.WriteHeader(http.StatusNoContent)
}
