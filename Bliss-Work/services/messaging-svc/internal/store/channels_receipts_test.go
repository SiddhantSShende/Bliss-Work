package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// Both receipt paths must authorize before they touch anything, and this is a
// source-level check because there is no database in this suite — the same
// shape, and the same reasoning, as
// TestChannelMessageActionsAuthorizeBeforeTheyWrite next door.
//
// What is at stake is not only the write. ChannelReadReceipts answers "who is
// in this channel and how far have they read", so an ungated version hands a
// non-member the channel's roster and its members' reading habits in response
// to message ids they could guess at. Losing the gate is silent: the query
// still runs and still returns rows.
func TestChannelReceiptsAuthorizeBeforeTheyRun(t *testing.T) {
	required := map[string]string{
		"MarkChannelRead":     "requireChannelMember",
		"ChannelReadReceipts": "requireChannelMember",
	}

	const name = "channels_receipts.go"
	src, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	f, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}

	seen := map[string]bool{}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		want, tracked := required[fn.Name.Name]
		if !tracked {
			continue
		}
		seen[fn.Name.Name] = true

		var body strings.Builder
		ast.Inspect(fn, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok {
				body.WriteString(id.Name)
				body.WriteByte(' ')
			}
			return true
		})
		if !strings.Contains(body.String(), want) {
			t.Errorf("%s no longer calls %s — a non-member can now read or move "+
				"a channel's read cursors", fn.Name.Name, want)
		}
	}

	for fnName := range required {
		if !seen[fnName] {
			t.Errorf("%s is gone from %s; if it was renamed, update this test "+
				"rather than deleting the case", fnName, name)
		}
	}
}

// The receipts query must scope by channel_id as well as by the id list.
//
// Without it the id list alone decides what comes back, and `requireChannelMember`
// is checking a DIFFERENT channel from the one being read: a member of any one
// channel could pass message ids belonging to a channel they are not in and get
// its receipts. The clause is one line and its absence is invisible in Go, so
// it is asserted here rather than left to a reviewer to notice.
func TestChannelReadReceiptsScopesToTheRequestedChannel(t *testing.T) {
	src, err := os.ReadFile("channels_receipts.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body := string(src)

	if !strings.Contains(body, "WHERE m.channel_id = $1 AND m.id = ANY($2)") {
		t.Error("ChannelReadReceipts no longer restricts the message ids to the " +
			"channel being asked about — ids from another channel would be answered")
	}
}

// A read cursor only ever moves forward.
//
// GREATEST is what makes it safe to write from whichever of somebody's tabs
// scrolls first; a bare assignment would let a tab showing older history drag
// the cursor back and re-mark read messages as unread for everybody watching
// the receipts.
func TestMarkChannelReadOnlyMovesForward(t *testing.T) {
	src, err := os.ReadFile("channels_receipts.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(src), "GREATEST(last_read_seq, $3)") {
		t.Error("MarkChannelRead no longer clamps with GREATEST — a stale tab " +
			"can now drag the read cursor backwards")
	}
}
