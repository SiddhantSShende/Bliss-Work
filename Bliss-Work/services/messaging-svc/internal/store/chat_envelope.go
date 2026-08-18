package store

import (
	"encoding/json"
	"strings"
)

// The SERVER's reader for the structured message bodies the client writes
// (packages/app/src/lib/chatEnvelope.ts):
//
//	"{readable prefix}" + U+001F + JSON.stringify(envelope)
//
// Almost nothing on the server looks past the prefix — truncatePreview cuts at
// the sentinel precisely so attachment ids and shared coordinates stay out of
// previews. Forwarding is the one operation that MUST look inside, and it is
// worth being clear about why, because "the server cannot see what a message
// references" is load-bearing everywhere else in this service.
//
// An attachment is authorized by (scope, scope_id) — the conversation or channel
// it was uploaded to — so its id is meaningless to a reader anywhere else. A
// forwarded photo whose body was copied verbatim would arrive as an id the
// recipient is not authorized for, and every tile would render "not available to
// you". Re-scoping is therefore not an optimization; it is the difference
// between a forward that works and one that delivers a broken card.
//
// This DOES NOT weaken the encryption posture: the body is decrypted here inside
// the same transaction that re-encrypts it for the destination, under the same
// org DEK, on a message the caller has already been authorized to read. Nothing
// is stored in the clear and nothing new becomes visible to the server that
// ForwardSourceResolve had not already decrypted.
//
// Anything that does not parse is treated as plain text and forwarded verbatim,
// which is the correct fallback for a body written by a client we do not control.

// mediaAttachmentIDs returns the attachment ids a media body references — the
// files and their thumbnails, in that order — or nil for any other body.
func mediaAttachmentIDs(body string) []string {
	_, env, ok := decodeMediaEnvelope(body)
	if !ok {
		return nil
	}
	var files, thumbs []string
	for _, item := range env.items {
		if id, ok := item["id"].(string); ok && id != "" {
			files = append(files, id)
		}
		if id, ok := item["thumbId"].(string); ok && id != "" {
			thumbs = append(thumbs, id)
		}
	}
	// Files first: a thumbnail row references its file as parent_attachment_id,
	// so the clone of the parent has to exist before the clone of the poster.
	return append(files, thumbs...)
}

// rewriteMediaAttachmentIDs returns body with every attachment id replaced by
// its entry in remap, leaving every other field — including ones this server has
// never heard of — exactly as the sending client wrote them.
//
// An id with no mapping is DROPPED along with its item rather than carried over:
// it would point at a row in a scope the recipient cannot read, which is the
// broken tile this whole path exists to avoid. A thumbnail that failed to clone
// simply loses its poster, which is cosmetic (MediaBubble falls back to the full
// image), so the item survives.
//
// Returns ok=false when the body is not a media envelope, in which case the
// caller forwards it unchanged.
func rewriteMediaAttachmentIDs(body string, remap map[string]string) (string, bool) {
	prefix, env, ok := decodeMediaEnvelope(body)
	if !ok {
		return body, false
	}

	kept := make([]any, 0, len(env.items))
	for _, item := range env.items {
		id, _ := item["id"].(string)
		clone, mapped := remap[id]
		if !mapped {
			continue
		}
		item["id"] = clone
		if thumb, ok := item["thumbId"].(string); ok {
			if cloneThumb, mapped := remap[thumb]; mapped {
				item["thumbId"] = cloneThumb
			} else {
				delete(item, "thumbId")
			}
		}
		kept = append(kept, item)
	}
	if len(kept) == 0 {
		// Nothing survived re-scoping. Forward the readable prefix alone rather
		// than an envelope with an empty item list, which the client's parser
		// rejects (parseChatEnvelope returns null for zero items) and would
		// render as raw JSON.
		return prefix, true
	}
	env.raw["items"] = kept

	payload, err := json.Marshal(env.raw)
	if err != nil {
		// Unreachable for a value that came out of json.Unmarshal, but a
		// forward that silently dropped its attachments would be worse than one
		// that arrives as text.
		return prefix, true
	}
	return prefix + string(envelopeSentinel) + string(payload), true
}

// mediaEnvelope is one decoded media body: the whole object (so unknown fields
// survive a round trip) plus its item list, already type-asserted.
type mediaEnvelope struct {
	raw   map[string]any
	items []map[string]any
}

// decodeMediaEnvelope splits a body and decodes it, reporting ok only for a
// media envelope. Locations and plain text answer false — they are
// self-contained and forward verbatim.
func decodeMediaEnvelope(body string) (prefix string, env mediaEnvelope, ok bool) {
	i := strings.IndexRune(body, envelopeSentinel)
	if i < 0 {
		return body, mediaEnvelope{}, false
	}
	prefix = body[:i]

	var raw map[string]any
	if err := json.Unmarshal([]byte(body[i+1:]), &raw); err != nil {
		return prefix, mediaEnvelope{}, false
	}
	if kind, _ := raw["kind"].(string); kind != "media" {
		return prefix, mediaEnvelope{}, false
	}
	list, _ := raw["items"].([]any)
	items := make([]map[string]any, 0, len(list))
	for _, entry := range list {
		if item, ok := entry.(map[string]any); ok {
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return prefix, mediaEnvelope{}, false
	}
	return prefix, mediaEnvelope{raw: raw, items: items}, true
}
