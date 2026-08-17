package contract

import "encoding/json"

// routingOnlyFields are event fields that exist SOLELY so the gateway can decide
// who an event goes to. They are consumed by RecipientsOf and are of no use to a
// client, which already knows it is the recipient by virtue of having received
// the frame.
//
// `members` is the one that matters. The others are listed for the same reason
// and cost nothing to drop, but they are bounded in size and would not justify
// this on their own.
var routingOnlyFields = []string{"members"}

// DeliveryPayload returns the bytes that should actually be stored in a replay
// outbox and pushed to a socket: the event, minus the fields that only existed
// to route it.
//
// ── Why this exists: fan-out storage was quadratic in channel size ──────────
//
// messaging-svc computes a channel's full roster on every send and ships it
// INSIDE the event (see store/channels.go — `Members: members`). The gateway
// then writes that whole event, roster included, into EVERY recipient's replay
// ZSET. So one message to an N-member channel stored N copies of a payload that
// was itself O(N) — O(N²) bytes in Redis for a single "hello everyone".
//
// Concretely, at ~39 B per member id in a JSON array:
//
//	 1,000 members →  39 KB event ×  1,000 outboxes ≈  39 MB per message
//	10,000 members → 390 KB event × 10,000 outboxes ≈ 3.9 GB per message
//
// Against a Redis with `maxmemory` and `noeviction` — which is to say, against
// this one — a single message into a large channel can fill the instance, and
// because noeviction applies to the whole keyspace that takes presence, the node
// registry and the shared rate-limit buckets down with the outbox.
//
// Routed delivery (WS_FANOUT_MODE=routed) does NOT fix this on its own. It
// removes the per-POD duplication — every gateway no longer writes every outbox
// — but router.go passes the same raw bytes to AppendOutboxMulti, so the
// quadratic payload survives it untouched. This is the half that fan-out mode
// cannot fix, which is why it lives here and applies to both paths.
//
// After stripping, one message to an N-member channel costs O(N) bytes total:
// N outboxes each holding a constant-size event.
//
// ── Why a map round-trip rather than re-marshalling contract.Event ──────────
//
// Event is a PARTIAL view — it extracts only what routing needs, and every
// other field in the payload (body, senderDisplayName, seq, the call and
// forward-provenance fields) is absent from the struct. Re-marshalling it would
// silently delete everything the client actually renders. Decoding to
// json.RawMessage preserves every field verbatim, including ones added later by
// a producer this binary has never been taught about.
//
// On failure it returns the input unchanged. A payload that will not parse is
// one the gateway could not have routed either, and delivering it intact is
// strictly better than dropping it: the client dedupes and validates anyway.
func DeliveryPayload(raw []byte) []byte {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return raw
	}

	stripped := false
	for _, f := range routingOnlyFields {
		if _, present := fields[f]; present {
			delete(fields, f)
			stripped = true
		}
	}
	// Nothing to remove — hand back the ORIGINAL bytes rather than a re-encoded
	// equivalent. Most events on the bus have no routing-only field at all, and
	// this keeps them on a path that neither allocates nor rewrites them.
	if !stripped {
		return raw
	}

	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}
