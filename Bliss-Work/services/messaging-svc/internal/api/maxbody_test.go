package api

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// A message body used to be checked for emptiness and nothing else, so the only
// ceiling on it was the 1 MiB request cap. That one number then sized four
// different things — the row, the outbox payload, the Kafka message and a copy
// in every recipient's replay ZSET — and produced a total platform event outage
// (a body over the broker limit wedged the outbox queue permanently) and a
// Redis-fill path that took presence down with it.
//
// These tests are about the CAP, not about any one handler, because the failure
// mode was a handler that forgot it.

func TestBodyCapIsBelowTheBrokerLimit(t *testing.T) {
	// The invariant that makes the outbox wedge unreachable rather than merely
	// handled: a legitimate event must be nowhere near what Kafka will refuse.
	// maxPublishBytes in internal/kafka is 1 MiB.
	const brokerLimit = 1 << 20
	if MaxMessageBodyBytes >= brokerLimit {
		t.Fatalf("body cap %d is not below the broker limit %d — an ordinary "+
			"message could again produce an unpublishable event",
			MaxMessageBodyBytes, brokerLimit)
	}
	// Two orders of magnitude of headroom, so the envelope, member lists and
	// any field added later cannot close the gap by accident.
	if MaxMessageBodyBytes*100 > brokerLimit {
		t.Errorf("body cap %d leaves less than 100x headroom under %d; the "+
			"event envelope has to fit in the difference",
			MaxMessageBodyBytes, brokerLimit)
	}
}

func TestValidMessageBody(t *testing.T) {
	cases := []struct {
		name string
		body string
		ok   bool
	}{
		{"empty is still rejected", "", false},
		{"ordinary message", "hello everyone", true},
		{"exactly at the cap", strings.Repeat("a", MaxMessageBodyBytes), true},
		{"one byte over", strings.Repeat("a", MaxMessageBodyBytes+1), false},
		{"a megabyte, the old ceiling", strings.Repeat("a", 1<<20), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validMessageBody(c.body); got != c.ok {
				t.Errorf("validMessageBody(%d bytes) = %v, want %v", len(c.body), got, c.ok)
			}
		})
	}
}

func TestCapIsCountedInBytesNotRunes(t *testing.T) {
	// A rune limit would let a message of astral-plane characters cost four
	// times its stated size in Postgres, Kafka and Redis — which are the three
	// things this cap exists to protect, and all three count bytes.
	body := strings.Repeat("𝔘", MaxMessageBodyBytes/4+1) // 4 bytes per rune
	if len([]rune(body)) > MaxMessageBodyBytes {
		t.Fatal("test is not exercising the case: too many runes")
	}
	if validMessageBody(body) {
		t.Errorf("a %d-byte body of %d runes was accepted; the cap must count bytes",
			len(body), len([]rune(body)))
	}
}

// TestEverySendHandlerChecksTheBodyCap walks the AST for handlers that pass a
// `Body` field into the store and asserts each one calls validMessageBody.
//
// This is the test that actually matters. The cap is only as good as its least
// careful call site, and a new send route that forgets it fails NOTHING: it
// accepts the oversized body, writes the row, and the damage appears later in a
// different service. There is no runtime signal to catch that, so the check has
// to be structural.
func TestEverySendHandlerChecksTheBodyCap(t *testing.T) {
	// Handler name -> the store call it makes. Kept explicit so adding a send
	// route means adding a line here, which is the prompt to think about it.
	sendHandlers := map[string]string{
		"sendMessage":        "SendMessage",
		"reply":              "Reply",
		"replyToThread":      "ReplyToThread",
		"sendChannelMessage": "SendChannelMessage",
	}

	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", nil, 0)
	if err != nil {
		t.Fatalf("parse package: %v", err)
	}

	found := map[string]bool{}
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			if strings.HasSuffix(name, "_test.go") {
				continue
			}
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok {
					continue
				}
				if _, want := sendHandlers[fn.Name.Name]; !want {
					continue
				}
				found[fn.Name.Name] = true
				if !callsIdent(fn, "validMessageBody") {
					t.Errorf("%s does not call validMessageBody — an oversized "+
						"body reaching the outbox from here can wedge the "+
						"publisher for the whole platform", fn.Name.Name)
				}
			}
		}
	}
	for name := range sendHandlers {
		if !found[name] {
			t.Errorf("handler %q was not found; if it was renamed, update this "+
				"test rather than deleting the case", name)
		}
	}
}

func callsIdent(n ast.Node, name string) bool {
	hit := false
	ast.Inspect(n, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); ok && id.Name == name {
			hit = true
			return false
		}
		return true
	})
	return hit
}
