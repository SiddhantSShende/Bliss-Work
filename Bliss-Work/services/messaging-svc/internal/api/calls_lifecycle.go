package api

// Ending calls that nobody ended.
//
// Two inputs — the SFU's webhooks and a periodic sweep — and one outcome. See
// store/calls_lifecycle.go for why both are needed and what each covers; this
// file is the side of it that talks: the roster fan-out, the SFU room deletion
// and the recording stop that a call ending has always done, reused verbatim so
// a call that ends by itself ends by exactly the same amount as one a host
// ended.

import (
	"context"
	"time"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/store"
)

// roomEventTimeout bounds the database work one webhook can do. The SFU retries
// a non-2xx, so the honest failure here is to answer slowly rather than to hang
// a connection the SFU is holding open.
const roomEventTimeout = 8 * time.Second

// handleRoomEvent applies what the SFU said about a room.
//
// Best-effort and silent to the sender: every outcome is a 200, because there
// is nothing the SFU could usefully do differently. A room it reports that this
// service has no call for is ordinary — the id is not a call id at all, or the
// call ended minutes ago — and is not logged as a failure.
//
// Runs on a context of its own rather than the request's. The work outlives the
// response by design: LiveKit closes the connection as soon as it has its 200,
// and a cancelled context there would abandon a half-applied end.
func (s *Server) handleRoomEvent(ctx context.Context, ev *livekit.RoomEvent) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), roomEventTimeout)
	defer cancel()

	switch ev.Event {
	case livekit.EventParticipantJoined:
		// Records WHICH connection is now current for this identity — nothing
		// else. See MarkJoinedFromSFU and, for why this matters,
		// MarkLeftFromSFU's own doc comment on session_id: a fast reconnect can
		// leave a stale participant_left for the OLD connection in flight, and
		// this is what lets that be recognised as stale instead of closing the
		// roster row on somebody who is still in the call.
		if err := s.store.MarkJoinedFromSFU(ctx, ev.Room, ev.Identity, ev.SID); err != nil {
			s.log.Warn("could not record an SFU connection",
				"call_id", ev.Room, "user_id", ev.Identity, "err", err)
		}

	case livekit.EventParticipantLeft:
		// Records the departure and nothing more, even when the person who
		// disconnected is the host — see MarkLeftFromSFU for why ending the
		// call here would take a meeting away from everyone in it because its
		// organiser reloaded the page. A host who really has gone is closed by
		// the sweeper a grace period later.
		//
		// The one thing this DOES tell people in real time is that this
		// participant left (see notifyParticipantLeft) — guarded on `recorded`
		// so a reload's eventual reconnect-or-not doesn't matter here: this
		// only fires for a genuinely new departure, never for an explicit
		// /leave request that already closed the same row moments earlier.
		// LiveKit cannot distinguish a reload from a real departure either
		// way, so on a reload this is one harmless, self-correcting refetch on
		// the person's other sessions, not a lasting wrong state.
		recorded, wasSharing, err := s.store.MarkLeftFromSFU(ctx, ev.Room, ev.Identity, ev.SID)
		if err != nil {
			s.log.Warn("could not record an SFU departure",
				"call_id", ev.Room, "user_id", ev.Identity, "err", err)
			return
		}
		if !recorded {
			// Not on this roster, a stale echo, or the explicit /leave request
			// already landed on this same row. Either way, nothing new to tell.
			return
		}
		if wasSharing {
			s.notifyShare(ctx, ev.Room, events.TypeCallShareStopped, ev.Identity, "")
		}
		s.notifyParticipantLeft(ctx, ev.Room, ev.Identity)

	case livekit.EventRoomFinished:
		ended, err := s.store.EndCallFromSFU(ctx, ev.Room)
		if err != nil {
			s.log.Warn("could not end a call whose room finished",
				"call_id", ev.Room, "err", err)
			return
		}
		if ended == nil {
			return // already over — usually the room WE deleted on End
		}
		// No DeleteRoom here: the room is what just finished.
		s.notifyCall(ctx, ended, events.TypeCallEnded, "")
		s.stopRecording(ctx, ended.ID)
		s.log.Info("call ended: its room is empty", "call_id", ev.Room)
	}
}

// endedCallSideEffects is everything that happens once a call is ENDED in the
// database, in the order the End button already did it.
//
// Extracted so the four ways a call can now end — a host pressing End, a host
// leaving, the sweeper reaching its scheduled end, and the sweeper finding it
// hostless — cannot drift into telling different people, or leaving the room
// open on some of them.
// Ordering is load-bearing: stopRecording first so egress finalises its file
// instead of being cut off mid-write by the room going away.
func (s *Server) endedCallSideEffects(ctx context.Context, c *store.CallDTO, actorID string) {
	s.notifyCall(ctx, c, events.TypeCallEnded, actorID)
	s.stopRecording(ctx, c.ID)
	s.closeRoom(c.ID)
}

// callSweepInterval is how often each replica looks for calls that should be
// over.
//
// Thirty seconds is the resolution of "ends at its scheduled time", and it is
// the granularity that matters: a meeting closing up to half a minute late is
// indistinguishable from one closing on time. Both queries behind it read
// partial indexes covering the OPEN calls alone, so the cost is set by how many
// calls are in progress rather than by how many there have ever been.
const callSweepInterval = 30 * time.Second

// RunCallSweeper ends calls that should be over — those past their scheduled
// end, and those whose organiser has gone — until ctx is cancelled.
//
// ── Why a plain ticker, in every replica ─────────────────────────────────────
// There is no leader election here and none is needed. Both sweeps take
// FOR UPDATE SKIP LOCKED, so two replicas never claim the same call, and
// endCallTx only reports a call it actually moved out of SCHEDULED/LIVE — so
// even in the race it cannot lose, the roster is told once. Duplicating the
// timer is what makes the feature survive one replica being down, which is the
// state this is most needed in.
//
// A failure is logged and the loop continues. The sweep is idempotent and runs
// again in thirty seconds, so a transient database error costs a late ending,
// never a missed one.
func (s *Server) RunCallSweeper(ctx context.Context) {
	t := time.NewTicker(callSweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweepOverdueCalls(ctx)
		}
	}
}

// sweepOverdueCalls runs one pass of all three rules. Separated from the loop
// so it is testable without a clock.
//
// All three run every tick, and none short-circuits another: a call can be
// overdue AND hostless (though not also due — activating requires SCHEDULED,
// which the other two never leave a call in), and whichever query claims a row
// first is the one that acts on it while the others simply find nothing. They
// are separate queries rather than one because they are separate reasons, and
// the log line has to be able to say which.
func (s *Server) sweepOverdueCalls(ctx context.Context) {
	due, err := s.store.ActivateDueCalls(ctx, store.DueSweepLimit)
	if err != nil {
		s.log.Warn("call sweep failed", "rule", "due", "err", err)
	}
	for _, c := range due {
		// No actor: nobody did this, the clock did — same convention the
		// ending rules below use for actorID, from the other end of a call's
		// life.
		s.notifyCall(ctx, c, events.TypeCallStarted, "")
		// A call the clock starts records with a deployment that records at
		// all, exactly like one a host starts by hand (startCall). No response
		// DTO to attach RecordingStatus to here, unlike startCall's own use of
		// this — just log a failure to start it.
		if _, err := s.startRecording(ctx, c.ID, c.OrgID, c.Kind); err != nil {
			s.log.Warn("call sweep: recording failed to start", "call_id", c.ID, "err", err)
		}
		s.log.Info("call started: it reached its scheduled start",
			"call_id", c.ID, "kind", c.Kind, "scheduled_at", c.ScheduledAt)
	}

	overdue, err := s.store.ExpireOverdueCalls(ctx, store.OverdueSweepLimit)
	if err != nil {
		s.log.Warn("call sweep failed", "rule", "overdue", "err", err)
	}
	for _, c := range overdue {
		// No actor: nobody did this, the clock did. The empty actorId is what
		// lets a client tell "the organiser ended it" from "it ran out of
		// time" without a second event type.
		s.endedCallSideEffects(ctx, c, "")
		s.log.Info("call ended: it reached its scheduled end",
			"call_id", c.ID, "kind", c.Kind, "ends_at", c.EndsAt)
	}

	hostless, err := s.store.ExpireHostlessCalls(ctx, store.HostGracePeriod, store.OverdueSweepLimit)
	if err != nil {
		s.log.Warn("call sweep failed", "rule", "hostless", "err", err)
		return
	}
	for _, c := range hostless {
		s.endedCallSideEffects(ctx, c, "")
		s.log.Info("call ended: its host has been gone longer than the grace period",
			"call_id", c.ID, "kind", c.Kind, "grace", store.HostGracePeriod)
	}
}
