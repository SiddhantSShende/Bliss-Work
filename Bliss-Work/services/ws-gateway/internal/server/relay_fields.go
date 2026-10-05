package server

// Field caps for frames a connection asks the gateway to relay to ANOTHER user
// (rtc.*, typing, call.*).
//
// The websocket read limit (coder/websocket's default 32 KiB; SetReadLimit is not
// called) is the only other bound on such a frame, so without these a sender could
// stuff any string field with ~32 KB and have it delivered verbatim to a victim —
// at the per-connection cap of 200 frames/s that is ~6 MB/s onto one socket, which
// fills the victim's send buffer and gets it shed. The caps are far above anything
// a real client sends (ids are UUIDs, an ICE candidate line is a few hundred bytes)
// so they reject only abuse.
//
// `sdp` is NOT capped here on purpose: a real offer/answer can legitimately run to
// several KB and its ceiling is a product decision (it is still bounded by the 32
// KiB frame limit). See the note on per-target rate limiting in the change log.
const (
	// maxRelayIDLen bounds offerId, callId and conversationId. UUIDs are 36.
	maxRelayIDLen = 64
	// maxRelayReasonLen bounds a cancel reason, a short enumerated token.
	maxRelayReasonLen = 64
	// maxRelayMediaLen bounds a call's media kind ("audio" | "video").
	maxRelayMediaLen = 16
	// maxRelayCandidateLen bounds one ICE candidate line (typically ~150-300 bytes).
	maxRelayCandidateLen = 2048
)

// relayFieldsOK reports whether every free-form field of a frame that is about to
// be relayed is within its cap. A frame that fails is dropped, like one with a bad
// target.
func (f *clientFrame) relayFieldsOK() bool {
	return len(f.OfferID) <= maxRelayIDLen &&
		len(f.CallID) <= maxRelayIDLen &&
		len(f.ConversationID) <= maxRelayIDLen &&
		len(f.Reason) <= maxRelayReasonLen &&
		len(f.Media) <= maxRelayMediaLen &&
		len(f.Candidate) <= maxRelayCandidateLen
}
