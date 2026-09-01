package api

// leaveCall must tell the leaver's OTHER open sessions/devices they are not on
// this call anymore, for the ordinary (non-host) case where the call keeps
// going — see notifyParticipantLeft's own doc comment for why LiveParticipantIDs
// alone is not enough (the leaver's own row already has left_at set by the time
// this runs).
//
// Structural, same shape and for the same reason as
// calls_leave_closes_room_test.go: internal/api has no harness that exercises
// leaveCall end to end (see that file's comment), so this checks the source
// directly. What IS already covered, independently: internal/store's
// calls_lifecycle_db_test.go / calls_stale_participant_left_db_test.go prove
// LeaveCall/MarkLeftFromSFU's `recorded` bool is correct against a real
// database, and ws-gateway's contract tests prove call.participant_left routes
// to the right recipients once emitted. The one link neither proves is that
// the HTTP handler and the SFU webhook handler actually call
// notifyParticipantLeft at all, and only on the branch that does NOT already
// emit call.ended.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// funcBody returns the source text of one top-level function's body in a file
// in this package, or "" if no such function exists.
func funcBody(t *testing.T, filename, fnName string) string {
	t.Helper()
	src, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("read %s: %v", filename, err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", filename, err)
	}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != fnName || fn.Body == nil {
			continue
		}
		start := fset.Position(fn.Body.Pos()).Offset
		end := fset.Position(fn.Body.End()).Offset
		return string(src[start:end])
	}
	return ""
}

func TestLeaveCall_NotifiesParticipantLeft_OnTheOrdinaryLeavePath(t *testing.T) {
	body := funcBody(t, "calls.go", "leaveCall")
	if body == "" {
		t.Fatal("leaveCall is gone from calls.go; if it moved, update this test rather than deleting the case")
	}
	if !strings.Contains(body, "s.notifyParticipantLeft(") {
		t.Error("leaveCall no longer calls notifyParticipantLeft — an ordinary participant leaving a " +
			"call that keeps going would no longer tell that user's other open sessions/devices they " +
			"left, leaving them to find out from the 20s poll instead of in real time")
	}
	// The call must sit AFTER the `ended != nil` branch's early return, so a
	// host-ends-the-call leave (which already emits call.ended) never also
	// fires call.participant_left for the same departure.
	if idx := strings.Index(body, "s.notifyParticipantLeft("); idx >= 0 {
		endedIdx := strings.Index(body, "if ended != nil")
		if endedIdx < 0 || endedIdx > idx {
			t.Error("notifyParticipantLeft is not clearly ordered after the `ended != nil` early return — " +
				"a host-ends-the-call leave must emit only call.ended, never also call.participant_left")
		}
	}
}

func TestHandleRoomEvent_NotifiesParticipantLeft_OnAGenuineSFUDeparture(t *testing.T) {
	body := funcBody(t, "calls_lifecycle.go", "handleRoomEvent")
	if body == "" {
		t.Fatal("handleRoomEvent is gone from calls_lifecycle.go; if it moved, update this test rather than deleting the case")
	}
	if !strings.Contains(body, "s.notifyParticipantLeft(") {
		t.Error("handleRoomEvent no longer calls notifyParticipantLeft — a participant who disconnects " +
			"without clicking Leave (network drop, crash, force-quit) would no longer tell that user's " +
			"other sessions/devices they left this call")
	}
	// Must be guarded on `recorded`, so a stale echo or an already-landed
	// explicit /leave for the same row does not fire a duplicate notification.
	if !strings.Contains(body, "!recorded") {
		t.Error("handleRoomEvent's EventParticipantLeft case no longer guards on `recorded` — without " +
			"it, an explicit /leave and the SFU webhook for the same departure would both notify, " +
			"double-firing call.participant_left for one departure")
	}
}
