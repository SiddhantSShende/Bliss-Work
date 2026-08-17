package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// External is what tells a room that somebody in it is from another company.
func TestMarkExternalComparesAgainstTheCALLSOrg(t *testing.T) {
	const hostOrg = "org-a"
	roster := []CallParticipantDTO{
		{UserID: "host", OrgID: hostOrg},
		{UserID: "colleague", OrgID: hostOrg},
		{UserID: "guest", OrgID: "org-b"},
	}
	got := markExternal(hostOrg, roster)
	want := map[string]bool{"host": false, "colleague": false, "guest": true}
	for _, p := range got {
		if p.External != want[p.UserID] {
			t.Errorf("%s: External = %v, want %v", p.UserID, p.External, want[p.UserID])
		}
	}

	// Read from the guest's side the answer must be IDENTICAL: External is a
	// property of the participant against the call, not against whoever is
	// looking. Comparing it to the reader's own org instead would flip every
	// flag in the room the moment a guest opened the same meeting.
	for _, p := range markExternal(hostOrg, roster) {
		if p.External != want[p.UserID] {
			t.Errorf("%s: External depends on the reader, and must not", p.UserID)
		}
	}
}

// A function handed someone else's transaction must not leave RLS switched off
// in it.
//
// Two shapes of bypass live in this package and only one of them is safe by
// construction. A function that opens its OWN transaction and sets bypass at the
// head of it (MarkDelivered, InternalChannelMembership, the task projector) can
// never leak: the setting is transaction-local, and that transaction is entirely
// theirs. rostersTx and clearLobbyTx are the other shape — they widen a
// transaction the CALLER owns, for one statement, and every statement the caller
// runs afterwards is exposed if the reset is ever dropped in a later edit.
//
// The consequence would not look like a bug locally. It would look like the
// roster read working, and some unrelated query further down the same
// transaction quietly returning another organisation's rows.
func TestMidTransactionBypassIsAlwaysTurnedBackOff(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	fset := token.NewFileSet()
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		f, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			// Offsets via the FileSet, not raw Pos: a Pos is an index into the
			// whole FileSet, so slicing one file's bytes with it walks off the
			// end as soon as a second file is parsed.
			start := fset.Position(fn.Body.Pos()).Offset
			end := fset.Position(fn.Body.End()).Offset
			body := string(src[start:end])
			if !strings.Contains(body, "setBypassGUC(") {
				continue
			}
			// Opens its own transaction: the bypass dies with it, and there is
			// nothing of the caller's left to expose.
			if strings.Contains(body, "s.pool.Begin(") {
				continue
			}
			checked++
			if !strings.Contains(body, `set_config('app.bypass_rls', 'off', true)`) {
				t.Errorf("%s: %s turns RLS off inside a transaction it did not open and "+
					"never turns it back on.\n\n"+
					"Every statement the caller runs after this one in the same transaction "+
					"would then see every organisation's rows. Either reset it before "+
					"returning, or give this function its own transaction.",
					fset.Position(fn.Pos()), fn.Name.Name)
			}
		}
	}
	// If this drops to zero the guard has stopped guarding anything — most
	// likely because the helpers were renamed rather than because the pattern
	// went away.
	if checked == 0 {
		t.Fatal("no mid-transaction bypass found; this test no longer checks what it claims to")
	}
}
