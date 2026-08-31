package api

// leaveCall must close the SFU room when it ends the call, the same way
// endCall does.
//
// ── Why a source check ────────────────────────────────────────────────────────
// internal/api has no harness that exercises a handler end to end: the auth
// context key jwtauth attaches claims under is unexported, so nothing outside
// a real Verifier.Middleware pass over a real JWT can populate
// auth.FromContext for a handler test (see routes_test.go's testRouter — every
// existing test in this package is structural for exactly this reason). What
// IS already covered, independently: internal/livekit's
// TestDeleteRoomPostsTwirpRequest proves closeRoom's DeleteRoom call actually
// reaches LiveKit, and internal/store's calls_lifecycle_db_test.go plus this
// fix's own store-layer siblings prove LeaveCall's database side is correct.
// The one link neither proves is this: that leaveCall's HTTP handler actually
// calls closeRoom (via endedCallSideEffects) AT ALL when a leave ends the
// call — before this fix, it did not, and both layers below it (the store
// call and the LiveKit call) working correctly in isolation gave neither of
// those tests anything to catch: leaveCall simply never made the second call.
// Same shape as store/calls_rls_test.go's AST-based check, one package over.
//
// See calls_lifecycle.go's endedCallSideEffects doc comment: "the four ways a
// call can now end ... cannot drift into telling different people, or leaving
// the room open on some of them." This test is what keeps that true for the
// leave path specifically.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

func TestLeaveCall_EndsTheCall_ViaEndedCallSideEffects(t *testing.T) {
	src, err := os.ReadFile("calls.go")
	if err != nil {
		t.Fatalf("read calls.go: %v", err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "calls.go", src, 0)
	if err != nil {
		t.Fatalf("parse calls.go: %v", err)
	}

	var body string
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "leaveCall" || fn.Body == nil {
			continue
		}
		start := fset.Position(fn.Body.Pos()).Offset
		end := fset.Position(fn.Body.End()).Offset
		body = string(src[start:end])
	}
	if body == "" {
		t.Fatal("leaveCall is gone from calls.go; if it moved, update this test rather than deleting the case")
	}

	if !strings.Contains(body, "s.endedCallSideEffects(") {
		t.Error("leaveCall no longer calls endedCallSideEffects — a host who closes their laptop " +
			"mid-meeting (rather than pressing End) would end the call in the database and never " +
			"tell the SFU to close the room, leaving media flowing for any client slow to react " +
			"to call.ended")
	}
	// The specific regression this guards against: reverting to the manual,
	// pre-fix pair that quietly dropped closeRoom.
	if strings.Contains(body, "s.notifyCall(") && strings.Contains(body, "s.stopRecording(") &&
		!strings.Contains(body, "s.endedCallSideEffects(") {
		t.Error("leaveCall calls notifyCall/stopRecording directly again instead of through " +
			"endedCallSideEffects — this is the exact shape of the original bug, missing only closeRoom")
	}
}
