package store

import (
	"encoding/json"
	"strings"
	"testing"
)

// The forward path is the only place the server reads INSIDE a message body, so
// these tests pin the two things that make a media forward work: finding the
// attachment ids, and rewriting them to the clones without disturbing anything
// else the client put there.

const (
	fileA  = "018f0000-0000-7000-8000-0000000000a1"
	thumbA = "018f0000-0000-7000-8000-0000000000a2"
	fileB  = "018f0000-0000-7000-8000-0000000000b1"
	newA   = "018f1111-0000-7000-8000-0000000000a1"
	newTA  = "018f1111-0000-7000-8000-0000000000a2"
	newB   = "018f1111-0000-7000-8000-0000000000b1"
)

func mediaBody(t *testing.T, prefix string, items ...map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"v": 2, "kind": "media", "items": items})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return prefix + string(envelopeSentinel) + string(payload)
}

func TestMediaAttachmentIDsReturnsFilesBeforeThumbs(t *testing.T) {
	body := mediaBody(t, "🖼️ 2 photos",
		map[string]any{"id": fileA, "thumbId": thumbA, "name": "a.jpg"},
		map[string]any{"id": fileB, "name": "b.jpg"},
	)
	got := mediaAttachmentIDs(body)
	want := []string{fileA, fileB, thumbA}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		// Files must come first: a thumbnail's clone references its file's
		// clone as parent, so the parent has to be inserted first.
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestMediaAttachmentIDsIgnoresOtherBodies(t *testing.T) {
	for name, body := range map[string]string{
		"plain text": "just a message",
		"location": "📍 Office" + string(envelopeSentinel) +
			`{"v":2,"kind":"location","lat":12.9716,"lng":77.5946}`,
		"malformed": "🖼️ photo" + string(envelopeSentinel) + `{not json`,
	} {
		if ids := mediaAttachmentIDs(body); ids != nil {
			t.Errorf("%s: expected no attachment ids, got %v", name, ids)
		}
	}
}

func TestRewriteMediaAttachmentIDsPreservesUnknownFields(t *testing.T) {
	// `caption` is not a field this server knows about. A forward must not be
	// where a newer client's data quietly disappears.
	body := mediaBody(t, "🖼️ photo.jpg · 2.0 MB", map[string]any{
		"id": fileA, "thumbId": thumbA, "name": "photo.jpg",
		"size": float64(2048), "mime": "image/jpeg", "caption": "on the roof",
	})

	out, ok := rewriteMediaAttachmentIDs(body, map[string]string{fileA: newA, thumbA: newTA})
	if !ok {
		t.Fatal("expected a media envelope")
	}
	if !strings.HasPrefix(out, "🖼️ photo.jpg · 2.0 MB"+string(envelopeSentinel)) {
		t.Fatalf("readable prefix not preserved: %q", out)
	}

	_, env, decoded := decodeMediaEnvelope(out)
	if !decoded {
		t.Fatal("rewritten body no longer parses")
	}
	item := env.items[0]
	if item["id"] != newA || item["thumbId"] != newTA {
		t.Fatalf("ids not remapped: %v", item)
	}
	if item["caption"] != "on the roof" || item["mime"] != "image/jpeg" {
		t.Fatalf("unknown/known fields lost: %v", item)
	}
}

func TestRewriteMediaAttachmentIDsDropsUnmappedItems(t *testing.T) {
	// An id with no clone points at a scope the recipient cannot read. Sending
	// it anyway is the broken "not available to you" tile this path exists to
	// prevent, so the item goes.
	body := mediaBody(t, "🖼️ 2 photos",
		map[string]any{"id": fileA, "name": "a.jpg"},
		map[string]any{"id": fileB, "name": "b.jpg"},
	)
	out, _ := rewriteMediaAttachmentIDs(body, map[string]string{fileB: newB})
	_, env, ok := decodeMediaEnvelope(out)
	if !ok {
		t.Fatal("expected a media envelope")
	}
	if len(env.items) != 1 || env.items[0]["id"] != newB {
		t.Fatalf("expected only the mapped item, got %v", env.items)
	}
}

func TestRewriteMediaAttachmentIDsDropsAThumbThatDidNotClone(t *testing.T) {
	// A poster is cosmetic — MediaBubble falls back to the full image — so
	// losing it must not lose the photo with it.
	body := mediaBody(t, "🖼️ photo.jpg",
		map[string]any{"id": fileA, "thumbId": thumbA, "name": "a.jpg"})
	out, _ := rewriteMediaAttachmentIDs(body, map[string]string{fileA: newA})
	_, env, ok := decodeMediaEnvelope(out)
	if !ok {
		t.Fatal("expected a media envelope")
	}
	if _, present := env.items[0]["thumbId"]; present {
		t.Fatalf("stale thumbId survived: %v", env.items[0])
	}
	if env.items[0]["id"] != newA {
		t.Fatalf("file id not remapped: %v", env.items[0])
	}
}

func TestRewriteMediaAttachmentIDsFallsBackToTextWhenNothingClones(t *testing.T) {
	// An envelope with zero items is rejected by the client's parser and would
	// render as raw JSON at the reader, so the readable prefix travels alone.
	body := mediaBody(t, "🖼️ photo.jpg", map[string]any{"id": fileA, "name": "a.jpg"})
	out, ok := rewriteMediaAttachmentIDs(body, nil)
	if !ok {
		t.Fatal("expected a media envelope")
	}
	if strings.ContainsRune(out, envelopeSentinel) {
		t.Fatalf("expected plain text, got %q", out)
	}
	if out != "🖼️ photo.jpg" {
		t.Fatalf("expected the readable prefix, got %q", out)
	}
}

func TestRewriteMediaAttachmentIDsLeavesOtherBodiesAlone(t *testing.T) {
	location := "📍 Office" + string(envelopeSentinel) +
		`{"v":2,"kind":"location","lat":12.9716,"lng":77.5946}`
	for name, body := range map[string]string{"text": "hello", "location": location} {
		out, ok := rewriteMediaAttachmentIDs(body, map[string]string{fileA: newA})
		if ok {
			t.Errorf("%s: reported as a media envelope", name)
		}
		if out != body {
			t.Errorf("%s: body changed: %q", name, out)
		}
	}
}
