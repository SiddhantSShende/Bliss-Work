package media

import (
	"encoding/json"
	"strings"
)

// Server-side reader/writer for the structured message body.
//
// The canonical definition lives in packages/app/src/lib/chatEnvelope.ts:
//
//	"{readable prefix}" + U+001F + JSON.stringify(envelope)
//
// The server has had no reason to parse it until now — bodies are ciphertext at
// rest and the client does all the rendering. Forwarding a media message is the
// exception: the attachment ids inside are scoped to the SOURCE conversation, so
// a verbatim clone hands the recipient ids they may not read and every tile
// renders "Not available to you". Rewriting them requires understanding the
// body, which requires this.
//
// ── Deliberately partial ─────────────────────────────────────────────────────
// Only what re-scoping needs is modelled: the media item ids, and enough of the
// rest to put the envelope back together byte-for-byte. Locations and v1 file
// offers are recognised and left ALONE — a location is self-contained and a v1
// offer is peer-to-peer, so neither has anything to re-scope. Anything
// unrecognised is treated as plain text, which is the same fail-safe the client
// applies: a body is attacker-controlled, and a malformed envelope must degrade
// to "leave it alone", never to an error that blocks the forward.

// sentinel is U+001F (Unit Separator) — a non-printing control character that
// never appears in typed text.
const sentinel = "\x1f"

// MediaItem mirrors the TS MediaItem. Unknown fields are preserved through the
// raw map (see Envelope.rawItems) so a client-side addition does not get
// silently dropped by a forward.
type MediaItem struct {
	ID      string `json:"id"`
	ThumbID string `json:"thumbId,omitempty"`
}

// Envelope is a parsed structured body.
type Envelope struct {
	// Kind is "media", "location" or "fileOffer".
	Kind string
	// Prefix is the human-readable half, which is what inbox rows, search and
	// notifications show. Carried through a rewrite unchanged.
	Prefix string
	// Items are the media attachment ids, in order. Empty for other kinds.
	Items []MediaItem

	// raw is the decoded JSON object, kept so RewriteMediaIDs can put back
	// every field it does not model rather than re-serialising a lossy subset.
	raw map[string]any
}

// ParseEnvelope returns the structured body carried by `body`, or nil when it
// is ordinary text. Never errors: an unparseable body IS ordinary text.
func ParseEnvelope(body string) *Envelope {
	i := strings.Index(body, sentinel)
	if i < 0 {
		return nil
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(body[i+1:]), &raw); err != nil {
		return nil
	}
	kind, _ := raw["kind"].(string)
	if kind == "" {
		return nil
	}
	env := &Envelope{Kind: kind, Prefix: body[:i], raw: raw}

	if kind == "media" {
		items, _ := raw["items"].([]any)
		for _, it := range items {
			obj, ok := it.(map[string]any)
			if !ok {
				continue
			}
			id, _ := obj["id"].(string)
			thumb, _ := obj["thumbId"].(string)
			env.Items = append(env.Items, MediaItem{ID: id, ThumbID: thumb})
		}
	}
	return env
}

// AttachmentIDs lists every attachment this envelope references — files and
// their poster thumbnails alike, since a thumb is an attachment row of its own
// and is just as unreadable to a recipient outside the source scope.
func (e *Envelope) AttachmentIDs() []string {
	if e == nil {
		return nil
	}
	out := make([]string, 0, len(e.Items)*2)
	for _, it := range e.Items {
		if it.ID != "" {
			out = append(out, it.ID)
		}
		if it.ThumbID != "" {
			out = append(out, it.ThumbID)
		}
	}
	return out
}

// RewriteMediaIDs returns a new body with every attachment id replaced per
// `mapping` (old id → new id). Ids absent from the mapping are left as they
// are, so a partial clone degrades to the current behaviour for the items it
// could not copy rather than corrupting the whole message.
//
// The readable prefix and every unmodelled field survive verbatim: only the
// `id` and `thumbId` of each item are touched.
func (e *Envelope) RewriteMediaIDs(mapping map[string]string) (string, bool) {
	if e == nil || e.Kind != "media" || len(mapping) == 0 {
		return "", false
	}
	items, _ := e.raw["items"].([]any)
	changed := false
	for _, it := range items {
		obj, ok := it.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := obj["id"].(string); id != "" {
			if next, ok := mapping[id]; ok && next != id {
				obj["id"] = next
				changed = true
			}
		}
		if id, _ := obj["thumbId"].(string); id != "" {
			if next, ok := mapping[id]; ok && next != id {
				obj["thumbId"] = next
				changed = true
			}
		}
	}
	if !changed {
		return "", false
	}
	encoded, err := json.Marshal(e.raw)
	if err != nil {
		return "", false
	}
	return e.Prefix + sentinel + string(encoded), true
}
