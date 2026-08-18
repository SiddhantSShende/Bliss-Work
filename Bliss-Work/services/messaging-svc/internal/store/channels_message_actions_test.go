package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// Every channel message action must authorize before it writes, and this is a
// source-level check because there is no database in this suite.
//
// The same shape as TestMidTransactionBypassIsAlwaysTurnedBackOff in
// calls_rls_test.go, and for the same reason: the property is "this call is
// present in this function", losing it is silent, and the cost of finding out
// in production is a member deleting other people's messages or pinning things
// for a channel they merely belong to.
//
// It asserts presence, not correctness — a test that a gate EXISTS cannot tell
// you it is right. What it catches is the refactor that removes one.
func TestChannelMessageActionsAuthorizeBeforeTheyWrite(t *testing.T) {
	// function name → the authorization helper it must not lose.
	//
	// Two different gates, because two different questions:
	//   channelForMessage      — "are you in this channel at all?" Enough for
	//                            acts that only affect the caller (hide) or that
	//                            any member may perform (react).
	//   requireChannelManager  — "may you moderate it?" Required for the two
	//                            that act on everyone: removing someone else's
	//                            message, and pinning one for the whole channel.
	required := map[string]string{
		"HideChannelMessage":         "channelForMessage",
		"SetChannelReaction":         "channelForMessage",
		"DeleteChannelMessageForAll": "requireChannelManager",
		"SetChannelMessagePin":       "requireChannelManager",
		"ReactionsForChannel":        "requireChannelMember",
	}

	const name = "channels_message_actions.go"
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
			t.Errorf("%s no longer calls %s — it can now be performed by "+
				"someone who should not be able to", fn.Name.Name, want)
		}
	}

	for fnName := range required {
		if !seen[fnName] {
			t.Errorf("%s is gone from %s; if it was renamed, update this test "+
				"rather than deleting the case", fnName, name)
		}
	}
}

// DeleteChannelMessageForAll must let the AUTHOR through without a moderator
// check, or an ordinary member could never retract their own message.
//
// Checked at the source level for the same reason as above: the author clause
// and the moderator clause are one `if` apart, and collapsing them in either
// direction is a plausible edit that nothing else would catch.
func TestDeletingYourOwnChannelMessageDoesNotRequireModeration(t *testing.T) {
	src, err := os.ReadFile("channels_message_actions.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body := string(src)

	// The moderator check must be guarded by "the caller is not the sender".
	idx := strings.Index(body, "if senderID != callerID {")
	if idx < 0 {
		t.Fatal("the author exemption is gone: requireChannelManager is no " +
			"longer guarded by `senderID != callerID`, so an ordinary member " +
			"can no longer delete their own message")
	}
	guarded := body[idx:]
	end := strings.Index(guarded, "\n\t}")
	if end < 0 || !strings.Contains(guarded[:end], "requireChannelManager") {
		t.Error("requireChannelManager is not inside the `senderID != callerID` " +
			"branch — either authors are being asked to moderate, or " +
			"non-authors are not")
	}
}
