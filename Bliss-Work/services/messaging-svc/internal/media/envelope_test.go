package media

import (
	"encoding/json"
	"testing"
)

// The client writes these bodies and the server now rewrites them. A drift
// between the two encodings does not fail loudly — it produces a forwarded
// message whose tiles all read "Not available to you", which is exactly the bug
// re-scoping exists to fix. So the fixtures here are written the way
// chatEnvelope.ts writes them, byte for byte.

const us = "\x1f"

func TestParseEnvelopePlainText(t *testing.T) {
	for _, body := range []string{
		"just a message",
		"", // empty body
		"a message that mentions U+001F but has no JSON after it" + us,
		us + "{not json",
		us + `{"noKind":true}`,
	} {
		if env := ParseEnvelope(body); env != nil {
			t.Fatalf("ParseEnvelope(%q) = %+v, want nil (plain text)", body, env)
		}
	}
}

func TestParseEnvelopeMedia(t *testing.T) {
	body := "🖼️ 2 photos" + us +
		`{"v":2,"kind":"media","items":[` +
		`{"id":"a1","name":"one.png","size":10,"mime":"image/png","thumbId":"t1"},` +
		`{"id":"a2","name":"two.png","size":20,"mime":"image/png"}]}`

	env := ParseEnvelope(body)
	if env == nil {
		t.Fatal("ParseEnvelope returned nil for a media body")
	}
	if env.Kind != "media" {
		t.Fatalf("Kind = %q, want media", env.Kind)
	}
	if env.Prefix != "🖼️ 2 photos" {
		t.Fatalf("Prefix = %q", env.Prefix)
	}
	got := env.AttachmentIDs()
	// Thumbnails count: a poster is an attachment row of its own, and just as
	// unreadable to someone outside the source conversation.
	want := []string{"a1", "t1", "a2"}
	if len(got) != len(want) {
		t.Fatalf("AttachmentIDs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AttachmentIDs() = %v, want %v", got, want)
		}
	}
}

func TestParseEnvelopeLeavesLocationAlone(t *testing.T) {
	body := "📍 Paris" + us + `{"v":2,"kind":"location","lat":48.85,"lng":2.35}`
	env := ParseEnvelope(body)
	if env == nil || env.Kind != "location" {
		t.Fatalf("expected a location envelope, got %+v", env)
	}
	// Nothing to re-scope: a location is self-contained.
	if ids := env.AttachmentIDs(); len(ids) != 0 {
		t.Fatalf("AttachmentIDs() = %v, want none", ids)
	}
	if _, ok := env.RewriteMediaIDs(map[string]string{"a": "b"}); ok {
		t.Fatal("RewriteMediaIDs rewrote a location envelope")
	}
}

func TestRewriteMediaIDs(t *testing.T) {
	body := "🖼️ 2 photos" + us +
		`{"v":2,"kind":"media","items":[` +
		`{"id":"a1","name":"one.png","size":10,"mime":"image/png","thumbId":"t1","width":100},` +
		`{"id":"a2","name":"two.png","size":20,"mime":"image/png"}]}`

	env := ParseEnvelope(body)
	next, ok := env.RewriteMediaIDs(map[string]string{"a1": "b1", "t1": "u1", "a2": "b2"})
	if !ok {
		t.Fatal("RewriteMediaIDs reported no change")
	}

	out := ParseEnvelope(next)
	if out == nil {
		t.Fatal("rewritten body no longer parses")
	}
	if out.Prefix != env.Prefix {
		t.Fatalf("prefix changed: %q -> %q", env.Prefix, out.Prefix)
	}
	if out.Items[0].ID != "b1" || out.Items[0].ThumbID != "u1" || out.Items[1].ID != "b2" {
		t.Fatalf("ids not rewritten: %+v", out.Items)
	}

	// Fields the Go side does not model must survive — dropping `width` would
	// silently cost the recipient's layout its aspect ratio.
	var parsed struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal([]byte(next[len(out.Prefix)+1:]), &parsed); err != nil {
		t.Fatalf("unmarshal rewritten envelope: %v", err)
	}
	if parsed.Items[0]["name"] != "one.png" || parsed.Items[0]["width"] != float64(100) {
		t.Fatalf("unmodelled fields lost: %+v", parsed.Items[0])
	}
}

func TestRewriteMediaIDsLeavesUnmappedIDs(t *testing.T) {
	// A partial clone must degrade to today's behaviour for the items it could
	// not copy, not corrupt the whole message.
	body := "🖼️ 2 photos" + us +
		`{"v":2,"kind":"media","items":[{"id":"a1"},{"id":"a2"}]}`
	env := ParseEnvelope(body)
	next, ok := env.RewriteMediaIDs(map[string]string{"a1": "b1"})
	if !ok {
		t.Fatal("expected a rewrite")
	}
	out := ParseEnvelope(next)
	if out.Items[0].ID != "b1" || out.Items[1].ID != "a2" {
		t.Fatalf("unexpected ids: %+v", out.Items)
	}
}

func TestRewriteMediaIDsNoOpWhenNothingMatches(t *testing.T) {
	body := "🖼️ 1 photo" + us + `{"v":2,"kind":"media","items":[{"id":"a1"}]}`
	env := ParseEnvelope(body)
	if _, ok := env.RewriteMediaIDs(map[string]string{"zz": "yy"}); ok {
		t.Fatal("reported a change when no id matched")
	}
}
