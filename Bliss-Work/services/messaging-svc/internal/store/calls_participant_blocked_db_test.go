package store

// AddParticipant's and ScheduleMeeting's block enforcement (P0-A's group-call
// gap), against a real Postgres with RLS actually enforcing.
//
// ── Why a roster check, not a caller check ──────────────────────────────────
// CallInviteAllowed / CreateDirectCall close the direct-ring door: a blocked
// pair can never ring each other. But nothing stopped a THIRD party — who has
// no block relationship with anyone — from widening an existing call's roster
// to include both halves of a blocked pair, seating them in the same LiveKit
// room by a door that never asked "does this conflict with anyone already
// here." The scenario these tests pin down: A blocks B; A and C are already
// in a live call; C (not blocked by anyone) adds B. Checking only the CALLER
// (C) against the invitee (B) would miss this entirely, because C is not one
// of the two people at risk — see participantBlockConflict's doc comment in
// calls.go.
//
// ── Running it ───────────────────────────────────────────────────────────────
// Opt-in, same harness as calls_blocked_db_test.go and calls_lifecycle_db_test.go:
//
//	MESSAGING_TEST_DATABASE_URL='postgres://messaging_user:pw@127.0.0.1:5599/postgres' \
//	  go test ./internal/store/ -run 'TestAddParticipant|TestScheduleMeeting' -v

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

// seedThree seeds three org-mates in user_projection for the roster tests.
func seedThree(t *testing.T, s *Store, orgID string) (a, b, c string) {
	t.Helper()
	a = uuid.Must(uuid.NewV7()).String()
	b = uuid.Must(uuid.NewV7()).String()
	c = uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, a, "user-a", "A")
	seedUser(t, s, orgID, b, "user-b", "B")
	seedUser(t, s, orgID, c, "user-c", "C")
	return a, b, c
}

// ── AddParticipant ───────────────────────────────────────────────────────────

// The exact scenario from the P0-A follow-up: A blocks B, A and C are already
// in a live call, and C — who has no block relationship with anyone — tries
// to add B. Must be refused even though the caller (C) is not one of the
// blocked pair.
func TestAddParticipant_RefusedWhenInviteeBlockedByAnExistingParticipant(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.Block(ctx, orgID, a, b); err != nil {
		t.Fatalf("a blocks b: %v", err)
	}

	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("C adding B while A (already in the call) has blocked B = %v, want ErrForbidden", err)
	}
}

// The reverse direction: B blocks A instead of A blocking B. bool_or(blocked)
// must catch it the same way CreateDirectCall's check already does.
func TestAddParticipant_RefusedWhenExistingParticipantBlockedByInvitee(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.Block(ctx, orgID, b, a); err != nil {
		t.Fatalf("b blocks a: %v", err)
	}

	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("C adding B while B has blocked A (already in the call) = %v, want ErrForbidden", err)
	}
}

// A block between the CALLER and the invitee must also refuse — the roster
// check subsumes the caller as one of the participants it examines.
func TestAddParticipant_RefusedWhenInviteeBlockedByCaller(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.Block(ctx, orgID, c, b); err != nil {
		t.Fatalf("c blocks b: %v", err)
	}

	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("C adding B after C blocked B = %v, want ErrForbidden", err)
	}
}

// Control: no block anywhere in the roster, the add must succeed.
func TestAddParticipant_SucceedsWithNoBlock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); err != nil {
		t.Fatalf("AddParticipant with no block relationship: %v, want success", err)
	}
}

// An unblock must actually restore the ability to widen the roster, not just
// the ability to ring directly.
func TestAddParticipant_SucceedsAfterUnblock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.Block(ctx, orgID, a, b); err != nil {
		t.Fatalf("a blocks b: %v", err)
	}
	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("add while blocked = %v, want ErrForbidden", err)
	}

	if err := s.Unblock(ctx, orgID, a, b); err != nil {
		t.Fatalf("unblock: %v", err)
	}
	if err := s.AddParticipant(ctx, orgID, c, call.ID, b); err != nil {
		t.Fatalf("add after unblock: %v, want success", err)
	}
}

// A participant who already LEFT the call must not veto a re-add of someone
// else — only CURRENTLY active participants (left_at IS NULL) count toward
// the roster conflict, the same as the roster a LiveKit room admission would
// actually reflect. c (a non-host participant, so leaving does not end the
// call) blocks b and then leaves; a (the still-active host) can then add b.
func TestAddParticipant_LeftParticipantsBlockDoesNotBlockNewAdd(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	a, b, c := seedThree(t, s, orgID)

	call, err := s.CreateDirectCall(ctx, orgID, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.Block(ctx, orgID, c, b); err != nil {
		t.Fatalf("c blocks b: %v", err)
	}
	if _, _, _, err := s.LeaveCall(ctx, orgID, c, call.ID); err != nil {
		t.Fatalf("c (non-host) leaves: %v", err)
	}

	if err := s.AddParticipant(ctx, orgID, a, call.ID, b); err != nil {
		t.Fatalf("add after the blocking participant left: %v, want success", err)
	}
}

// Cross-org refusal (pre-existing behavior) must survive unchanged: it is
// checked before the block conflict, so a cross-org invitee is refused for
// that reason regardless of any block state.
func TestAddParticipant_CrossOrgStillRefused(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgA := uuid.Must(uuid.NewV7()).String()
	orgB := uuid.Must(uuid.NewV7()).String()
	a := uuid.Must(uuid.NewV7()).String()
	c := uuid.Must(uuid.NewV7()).String()
	outsider := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgA, a, "a", "A")
	seedUser(t, s, orgA, c, "c", "C")
	seedUser(t, s, orgB, outsider, "outsider", "Outsider")

	call, err := s.CreateDirectCall(ctx, orgA, a, c, "", "video", nil, nil)
	if err != nil {
		t.Fatalf("CreateDirectCall(a,c): %v", err)
	}
	if err := s.AddParticipant(ctx, orgA, c, call.ID, outsider); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-org AddParticipant = %v, want ErrForbidden (unchanged pre-existing behavior)", err)
	}
}

// ── ScheduleMeeting ──────────────────────────────────────────────────────────

// An up-front invitee list is AddParticipant called in a loop — a block
// between two NAMED INVITEES (neither of which is the host) must refuse the
// whole schedule, not just skip the conflicting pair.
func TestScheduleMeeting_RefusedWhenTwoInviteesAreBlocked(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, x, y := seedThree(t, s, orgID)

	if err := s.Block(ctx, orgID, x, y); err != nil {
		t.Fatalf("x blocks y: %v", err)
	}

	_, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, []string{x, y})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("ScheduleMeeting with two blocked invitees = %v, want ErrForbidden", err)
	}
}

// A block between the HOST and a named invitee must refuse too — the host is
// seated as HOST before the loop runs, so it is already an active participant
// by the time each invitee is checked.
func TestScheduleMeeting_RefusedWhenHostBlockedInvitee(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, invitee, _ := seedThree(t, s, orgID)

	if err := s.Block(ctx, orgID, host, invitee); err != nil {
		t.Fatalf("host blocks invitee: %v", err)
	}

	_, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, []string{invitee})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("ScheduleMeeting inviting someone the host blocked = %v, want ErrForbidden", err)
	}
}

// Control: an unrelated roster with no block anywhere succeeds.
func TestScheduleMeeting_SucceedsWithNoBlock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, x, y := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, []string{x, y})
	if err != nil {
		t.Fatalf("ScheduleMeeting with no block relationship: %v, want success", err)
	}
	if call == nil || call.ID == "" {
		t.Fatalf("ScheduleMeeting returned no call: %+v", call)
	}
}

// ── RedeemInvite ─────────────────────────────────────────────────────────────
//
// The join-by-link path is the ONLY cross-org way to widen a call's roster
// (see RedeemInvite's doc comment in calls.go), which made it exactly as able
// to seat two blocked users in the same room as AddParticipant and
// ScheduleMeeting — until it ran no check at all. These pin down the fix.

// The redeemer is blocked by the HOST, who is already active in the meeting.
// The most direct case: nobody but the two blocked parties is involved.
func TestRedeemInvite_RefusedWhenRedeemerBlockedByHost(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, guest, _ := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, nil)
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	if err := s.Block(ctx, orgID, host, guest); err != nil {
		t.Fatalf("host blocks guest: %v", err)
	}
	invite, err := s.CreateInvite(ctx, orgID, host, call.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	if _, err := s.RedeemInvite(ctx, orgID, guest, invite.Token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest redeeming a link into a call whose host has blocked them = %v, want ErrForbidden", err)
	}
}

// The reverse direction: the redeemer blocked the host, not the other way
// round. bool_or(blocked) must catch it the same way AddParticipant's does.
func TestRedeemInvite_RefusedWhenRedeemerBlockedTheHost(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, guest, _ := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, nil)
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	if err := s.Block(ctx, orgID, guest, host); err != nil {
		t.Fatalf("guest blocks host: %v", err)
	}
	invite, err := s.CreateInvite(ctx, orgID, host, call.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	if _, err := s.RedeemInvite(ctx, orgID, guest, invite.Token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest redeeming a link into a call whose host they have blocked = %v, want ErrForbidden", err)
	}
}

// The blocked pair need not include the host: a THIRD party (the redeemer,
// via the host's own link) walks into a room that already holds someone who
// blocked them, even though the host — who minted the link — has no block
// relationship with either side. Same scenario TestAddParticipant's suite
// pins down for AddParticipant, replayed against the link path.
func TestRedeemInvite_RefusedWhenRedeemerBlockedByAnotherActiveParticipant(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, participant, guest := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, []string{participant})
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	if err := s.Block(ctx, orgID, participant, guest); err != nil {
		t.Fatalf("participant blocks guest: %v", err)
	}
	invite, err := s.CreateInvite(ctx, orgID, host, call.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	if _, err := s.RedeemInvite(ctx, orgID, guest, invite.Token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("guest redeeming a link into a call holding someone who blocked them = %v, want ErrForbidden", err)
	}
}

// Control: no block anywhere in the roster, the redemption must succeed and
// actually seat the redeemer.
func TestRedeemInvite_SucceedsWithNoBlock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, guest, _ := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, nil)
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	invite, err := s.CreateInvite(ctx, orgID, host, call.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	got, err := s.RedeemInvite(ctx, orgID, guest, invite.Token)
	if err != nil {
		t.Fatalf("RedeemInvite with no block relationship: %v, want success", err)
	}
	found := false
	for _, p := range got.Participants {
		if p.UserID == guest {
			found = true
		}
	}
	if !found {
		t.Errorf("redeemer is not on the returned roster: %+v", got.Participants)
	}
}

// An unblock must actually restore the ability to redeem the link, not just
// the ability to ring directly.
func TestRedeemInvite_SucceedsAfterUnblock(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	host, guest, _ := seedThree(t, s, orgID)

	call, err := s.ScheduleMeeting(ctx, orgID, host, "", "video", nil, nil, nil)
	if err != nil {
		t.Fatalf("ScheduleMeeting: %v", err)
	}
	if err := s.Block(ctx, orgID, host, guest); err != nil {
		t.Fatalf("host blocks guest: %v", err)
	}
	invite, err := s.CreateInvite(ctx, orgID, host, call.ID, time.Hour, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := s.RedeemInvite(ctx, orgID, guest, invite.Token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("redeem while blocked = %v, want ErrForbidden", err)
	}

	if err := s.Unblock(ctx, orgID, host, guest); err != nil {
		t.Fatalf("unblock: %v", err)
	}
	if _, err := s.RedeemInvite(ctx, orgID, guest, invite.Token); err != nil {
		t.Fatalf("redeem after unblock: %v, want success", err)
	}
}
