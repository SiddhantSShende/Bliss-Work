// Call-level observability.
//
// ── Why these exist ──────────────────────────────────────────────────────────
// Every signal this service had before this file was infrastructure-shaped:
// is LiveKit's HTTP listener up, is Prometheus scraping it, is the container
// healthy. None of that says whether a person trying to join a call actually
// could. A healthy SFU serving a 40% call-failure rate looks identical to a
// healthy SFU serving zero calls on every dashboard that stops at "is it up".
//
// ── Where each signal comes from, and why THAT source and not another ───────
//
//   - CallAttemptTotal / CallFailedTotal are recorded here, in the token
//     endpoint (calls.go's callToken), because that is the one place a join
//     either becomes possible (a token is minted) or definitively cannot (an
//     authorization or LiveKit error). The waiting room is NOT an attempt —
//     see callToken — a lobby is polled every 30s and counting each poll
//     would make "attempts" mostly measure how long people wait, not how
//     often they try to connect.
//
//   - CallConnectedTotal is recorded in store/calls_lifecycle.go's
//     MarkJoinedFromSFU, from LiveKit's own participant_joined webhook — NOT
//     from callToken returning 200. A minted token proves authorization, not
//     that the browser ever reached the SFU across the open internet; TURN
//     failures and dead networks happen strictly after that point. Counting
//     API success as call success would hide exactly the failures this
//     metric exists to catch.
//
//   - CallDroppedTotal is recorded in MarkLeftFromSFU, and ONLY when the SFU
//     is the FIRST party to report the departure (its own `recorded` return
//     value) — LeaveCall and EndCall both close call_participants.left_at
//     synchronously on an explicit request, before the client ever
//     disconnects from LiveKit, so an intentional hangup's webhook always
//     arrives second and is correctly not double-counted. Only a departure
//     nobody announced reaches this counter.
//
//   - CallReconnectTotal and CallSetupDurationSeconds are the two facts only
//     the CLIENT can observe: a short ICE/media reconnect is usually
//     transparent to the SFU (same participant session throughout, no new
//     webhook), and the token-issued and SFU-confirmed timestamps can land on
//     different service replicas with no shared clock between them, so
//     reconstructing setup latency server-side would mean adding a new
//     unbounded per-call timer store — exactly what CODING_PRACTICES.md and
//     this task's own instructions say not to do. Both are reported by the
//     client via POST /calls/{id}/telemetry (see calls.go's callTelemetry)
//     and are deliberately the ONLY two things that endpoint accepts: it
//     cannot report "connected" or "dropped", because a compromised or
//     merely buggy client cannot be trusted to grade its own connection —
//     that stays server-derived, from the SFU webhook, above.
package metrics

import "github.com/prometheus/client_golang/prometheus"

const (
	// CallTypeDirect / CallTypeGroup mirror store.CallDirect / (store.CallChannel,
	// store.CallMeeting) — duplicated as plain strings rather than imported,
	// because store imports this package (to record CallConnectedTotal /
	// CallDroppedTotal) and this package must stay a leaf everyone can import
	// without a cycle, the same reasoning metrics.go documents for why HTTP
	// metrics and outbox metrics live in separate files.
	CallTypeDirect = "direct"
	CallTypeGroup  = "group"
	// CallTypeUnknown covers the rare case where a call attempt fails before
	// its kind could even be resolved (e.g. AuthorizeCallAccess itself erroring
	// out on a malformed or already-deleted call id).
	CallTypeUnknown = "unknown"

	// FailReasonPermissionDenied: the caller is not entitled to this call
	// (blocked, wrong org, not on the roster) — store.ErrForbidden.
	FailReasonPermissionDenied = "permission_denied"
	// FailReasonCallUnavailable: the call exists but is not in a joinable
	// state right now — store.ErrCallEnded / store.ErrCallNotStarted.
	FailReasonCallUnavailable = "call_unavailable"
	// FailReasonLiveKitConnection: this deployment could not mint a token at
	// all — livekit.ErrNotConfigured or Mint() itself erroring.
	FailReasonLiveKitConnection = "livekit_connection_failure"
	// FailReasonServerError: anything else — an unclassified/unexpected error,
	// almost always a database or programming fault.
	FailReasonServerError = "server_error"
)

// CallTypeFor maps a store call kind (store.CallDirect / CallChannel /
// CallMeeting) to the bounded label used on every call metric. Group covers
// both CHANNEL and MEETING: the failure/success question this label exists to
// answer ("was this a 1:1 or a room with more than two people") does not
// distinguish the two further, and a third value here would only fragment an
// already-small sample without changing what anyone would do about it.
func CallTypeFor(kind string) string {
	if kind == "DIRECT" {
		return CallTypeDirect
	}
	return CallTypeGroup
}

var (
	// CallAttemptTotal counts call joins that reached signaling initiation: a
	// LiveKit token was either successfully minted or definitively refused.
	// Compare its rate against CallConnectedTotal for the success rate, and
	// against CallFailedTotal broken out by reason for where attempts go to
	// die.
	CallAttemptTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_call_attempt_total",
		Help: "Call join attempts that reached signaling initiation (a LiveKit token was minted or definitively refused). Excludes waiting-room polling.",
	}, []string{"call_type"})

	// CallConnectedTotal counts calls the SFU itself confirmed a participant
	// joined. See the package doc comment for why this, and not a 200 from
	// callToken, is what "connected" means here.
	CallConnectedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_call_connected_total",
		Help: "Calls where LiveKit's participant_joined webhook confirmed an actual SFU connection, not merely that a token was issued.",
	}, []string{"call_type"})

	// CallFailedTotal counts attempts that terminated before a successful
	// connection, by a small, bounded reason taxonomy (see the FailReason*
	// constants). Every increment here is paired with one on
	// CallAttemptTotal, so (attempt - connected - failed) is never negative
	// and the gap between attempts and (connected + failed) is exactly the
	// set of tokens issued to a client that then never reached the SFU at
	// all — a real, currently-uninstrumented failure mode (see docs).
	CallFailedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_call_failed_total",
		Help: "Call attempts that terminated before a successful connection, labeled by a bounded failure reason.",
	}, []string{"call_type", "reason"})

	// CallDroppedTotal counts previously-connected calls the SFU reported as
	// unexpectedly disconnected — a participant_left that no prior
	// LeaveCall/EndCall request already explained. A user pressing "Leave" is
	// never counted here.
	CallDroppedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_call_dropped_total",
		Help: "Previously-connected calls the SFU reported as unexpectedly disconnected, excluding explicit leave/end requests.",
	}, []string{"call_type"})

	// CallReconnectTotal counts client-reported successful ICE/media
	// reconnects (LiveKit's Room "Reconnected" event) after a transient
	// disruption. Self-reported — see the package doc comment.
	CallReconnectTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "messaging_call_reconnect_total",
		Help: "Client-reported successful reconnects after a transient WebRTC disruption.",
	}, []string{"call_type"})

	// CallSetupDurationSeconds is the client-measured time from requesting a
	// LiveKit token to the Room reporting Connected. Client-reported — see
	// the package doc comment for why this cannot be reconstructed
	// server-side without a new per-call timer store.
	CallSetupDurationSeconds = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "messaging_call_setup_duration_seconds",
		Help:    "Client-measured time from requesting a LiveKit token to the LiveKit Room reporting Connected.",
		Buckets: []float64{0.5, 1, 2, 3, 5, 10, 20, 30},
	}, []string{"call_type"})
)

func init() {
	prometheus.MustRegister(
		CallAttemptTotal, CallConnectedTotal, CallFailedTotal,
		CallDroppedTotal, CallReconnectTotal, CallSetupDurationSeconds,
	)
	// Pre-create every known label combination so a panel reads a flat 0
	// instead of "no data" before first occurrence, and so an alert querying
	// e.g. messaging_call_failed_total{reason="turn_failure"} does not
	// silently never fire just because that reason hasn't happened yet on
	// this deployment — same reasoning ws-gateway's metrics.go documents.
	for _, ct := range []string{CallTypeDirect, CallTypeGroup, CallTypeUnknown} {
		CallAttemptTotal.WithLabelValues(ct)
		CallConnectedTotal.WithLabelValues(ct)
		CallDroppedTotal.WithLabelValues(ct)
		CallReconnectTotal.WithLabelValues(ct)
		CallSetupDurationSeconds.WithLabelValues(ct)
		for _, reason := range []string{
			FailReasonPermissionDenied, FailReasonCallUnavailable,
			FailReasonLiveKitConnection, FailReasonServerError,
		} {
			CallFailedTotal.WithLabelValues(ct, reason)
		}
	}
}
