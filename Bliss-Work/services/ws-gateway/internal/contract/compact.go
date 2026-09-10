package contract

import "github.com/google/uuid"

// compactRefMarker is the first byte of a compact outbox record. A plain
// JSON payload (today's format, and every event type this does not apply
// to) always starts with '{' (0x7B), so any byte outside the printable-JSON
// range is an unambiguous discriminant — no version negotiation needed to
// tell the two formats apart on read.
const compactRefMarker = 0x01

// compactRefLen is the marker byte plus two raw 16-byte UUIDs.
const compactRefLen = 1 + 16 + 16

// TryCompact returns a minimal reference record for OUTBOX STORAGE in place
// of the full event, when it is safe to do so, per
// docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md sections H/R/S. `stripped` must
// already be DeliveryPayload(raw) — the same bytes used for live delivery —
// and is returned unchanged whenever compaction does not apply, so callers
// never pay for re-deriving it.
//
// NEVER use this for live socket delivery: a client receiving the compact
// form directly would get an unparseable binary blob. It exists only for
// what gets written to the replay outbox — see internal/hydrate, which
// reconstructs the full original event server-side before anything reaches
// a client, so the wire contract is unchanged.
//
// Scope is deliberately narrow: only message.created, the dominant type by
// both volume and payload size, and only when eventId/messageId are both
// present and well-formed UUIDs. Every other event type (message.read,
// message.delivered, task.*, channel.*, call.*, notification.*, mail.*)
// falls through to `stripped` unchanged — they were not audited for
// field-necessity in that report, and message.read in particular has no
// message-level reference to reconstruct from (it is a watermark, not a
// per-event fact — see the report's section E/H). Widening this list
// requires the same field-by-field, reconstruction-path evidence gathering
// that report did for message.created; it is not a matter of copying the
// encoding.
func TryCompact(ev *Event, stripped []byte) []byte {
	if ev.Type != "message.created" {
		return stripped
	}
	eid, err := uuid.Parse(ev.EventID)
	if err != nil {
		return stripped
	}
	mid, err := uuid.Parse(ev.MessageID)
	if err != nil {
		return stripped
	}
	out := make([]byte, 0, compactRefLen)
	out = append(out, compactRefMarker)
	out = append(out, eid[:]...)
	out = append(out, mid[:]...)
	return out
}

// IsCompactRef reports whether a stored outbox member is a compact
// reference (rather than a legacy/other-event-type full-JSON payload).
func IsCompactRef(member []byte) bool {
	return len(member) == compactRefLen && member[0] == compactRefMarker
}

// DecodeCompactRef extracts the eventId/messageId from a compact reference.
// Only meaningful when IsCompactRef(member) is true.
func DecodeCompactRef(member []byte) (eventID, messageID string, ok bool) {
	if !IsCompactRef(member) {
		return "", "", false
	}
	eid, err := uuid.FromBytes(member[1:17])
	if err != nil {
		return "", "", false
	}
	mid, err := uuid.FromBytes(member[17:33])
	if err != nil {
		return "", "", false
	}
	return eid.String(), mid.String(), true
}
