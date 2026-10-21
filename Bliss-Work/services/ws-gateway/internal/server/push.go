package server

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/task-board/shared-internalauth"
	wsmetrics "github.com/task-board/ws-gateway/internal/metrics"
	"github.com/task-board/ws-gateway/internal/push"
)

// handlePush receives fan-out deliveries addressed to sockets on THIS node.
//
// The receiving half of routed delivery. Where the Kafka consumer computes
// recipients for the whole platform and discards the ones it does not hold,
// this is handed only the users it does hold — so the work it does is the work
// that was needed.
//
// ── What this endpoint is trusted to do, and what it is not ──────────────────
// It fans a payload out to a named user's sockets, verbatim. It does NOT parse
// the payload, decide who should receive it, or check that the caller is
// entitled to reach that user — all of that was settled by the delivery service
// reading a recipient list the producers computed. The shared secret is the
// whole authorization, which is the same trust model the delivery-ack path
// already uses in the other direction.
//
// That makes WS_GATEWAY_INTERNAL_TOKEN a credential of real weight: anyone holding it
// can deliver an arbitrary payload to any connected user. It must never be
// exposed off the internal network, and this route is deliberately not part of
// the CORS-allowed browser surface.
//
// ── Authorization beyond the shared secret ───────────────────────────────────
// The secret alone used to be the entire trust model (see security-review.md
// S1/D3): any holder of WS_GATEWAY_INTERNAL_TOKEN could post either batch
// shape on behalf of either legitimate caller. The token is held by two
// distinct roles — delivery-svc (routed fan-out) and every OTHER ws-gateway
// node (RTC signalling / presence, via push.Fanout) — and each one only ever
// needs to send ONE of the two batch shapes. push.CallerHeader now names which
// role the caller claims to be, and this handler enforces that a
// `delivery-svc` caller may only post `Deliveries` and a `ws-gateway-peer`
// caller may only post `Broadcast`. This is least-privilege scoping of what an
// authenticated caller may DO, not a second secret — the shared token is still
// the sole authentication step, so a caller who holds the token can still lie
// about its own role. What this closes is the case where a caller that should
// only ever send one shape is silently accepted sending the other, which is a
// real gap today: nothing stops a compromised/misbehaving gateway peer from
// posting addressed `Deliveries` as if it were delivery-svc.
//
// ── What this does NOT fix ────────────────────────────────────────────────────
// This endpoint still performs no per-recipient authorization: it still trusts
// that the caller's UserID/UserIDs were computed correctly upstream (by
// router.Route's RecipientsOf for delivery-svc, by presence/signal lookups for
// a gateway peer). ws-gateway has no org/tenant membership table of its own to
// check a recipient against, so recipient-level authorization — "is this
// caller actually entitled to reach THIS user" — is not something this layer
// can verify without a architectural change (giving the gateway its own
// membership source, or having the caller present a signed claim per
// recipient). That remains an explicit, documented residual risk, not claimed
// as fixed by this change. See batch-2-push-auth-fix.md.
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Constant-time compare (shared internalauth package, so every service's
	// /internal/* check is byte-for-byte the same comparison): this is a
	// secret equality check on a request path, and a length-independent
	// early return would leak the token a byte at a time to anyone who can
	// measure it.
	got := r.Header.Get(push.TokenHeader)
	if !internalauth.Matches(got, s.cfg.WSGatewayInternalToken) {
		wsmetrics.PushReceivedTotal.WithLabelValues("unauthorized").Inc()
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// ── Caller identity: cryptographic when available, header otherwise ─────
	// See internal/push/svcjwt.go for the full rationale. If the caller
	// presents push.PushJWTHeader at all, that is the ONLY thing this
	// handler trusts for identity from this point on: it must verify against
	// a configured role's public key or the request is rejected outright,
	// even if the legacy token+header would otherwise have been accepted.
	// Falling back to the header once an (invalid) crypto credential has been
	// offered would let a caller probe for whichever check is weaker; a
	// caller that wants the legacy path must not send the header at all.
	//
	// X-Internal-Caller is never the source of truth once a verified role is
	// in hand — it is logged only as a cross-check, so a mismatch (a caller
	// whose verified key is delivery-svc but whose header claims to be the
	// gateway peer) is visible without ever being authoritative.
	var caller string
	if jwtStr := r.Header.Get(push.PushJWTHeader); jwtStr != "" {
		verifiedRole, err := push.VerifyPushJWT(jwtStr, s.pushVerifyKeys)
		if err != nil {
			wsmetrics.PushReceivedTotal.WithLabelValues("unauthorized").Inc()
			if s.log != nil {
				// Never logs the token itself — only that verification failed.
				s.log.Warn("push: signed caller identity rejected", "err", err)
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		caller = verifiedRole
		if claimed := r.Header.Get(push.CallerHeader); claimed != "" && claimed != caller && s.log != nil {
			s.log.Warn("push: X-Internal-Caller does not match verified signer; verified identity used", "claimed", claimed, "verified", caller)
		}
	} else {
		wsmetrics.PushReceivedTotal.WithLabelValues("legacy_header_path").Inc()
		caller = r.Header.Get(push.CallerHeader)
		switch caller {
		case push.CallerDeliverySvc, push.CallerGatewayPeer:
			// Recognized role; which batch shape it may post is enforced
			// below, once the body is decoded. This is the pre-Batch-5
			// trust level: a self-asserted header, not a verified claim —
			// kept only so callers not yet provisioned with a signing key
			// keep working. See svcjwt.go's migration posture.
		default:
			// Missing, misspelled, or a role that does not exist. Fail closed —
			// an authenticated-but-unidentified caller is rejected rather than
			// defaulted into either role.
			wsmetrics.PushReceivedTotal.WithLabelValues("unauthorized").Inc()
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	var batch push.Batch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, push.MaxBodyBytes))
	if err := dec.Decode(&batch); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	// Least-privilege: a role is authorized for exactly the batch shape it
	// legitimately sends. Mirrors push.Client's own doc comment on why the
	// two shapes exist (addressed deliveries vs. one payload to many users) —
	// delivery-svc only ever builds the former, a gateway peer only ever
	// builds the latter (push.Fanout.Deliver), so a request crossing that
	// line is never a legitimate caller, successful or not.
	if len(batch.Deliveries) > 0 && caller != push.CallerDeliverySvc {
		wsmetrics.PushReceivedTotal.WithLabelValues("forbidden").Inc()
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if batch.Broadcast != nil && hasPayload(batch.Broadcast.Payload) && caller != push.CallerGatewayPeer {
		wsmetrics.PushReceivedTotal.WithLabelValues("forbidden").Inc()
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var res push.Result
	// Fanout is non-blocking and sheds a socket whose buffer is full, so a slow
	// client cannot make this request hang — the same property that lets the
	// Kafka consumer share one goroutine across every recipient.
	deliver := func(userID string, payload []byte) {
		if s.hub.Fanout(userID, payload) {
			res.Accepted++
			wsmetrics.PushReceivedTotal.WithLabelValues("delivered").Inc()
			return
		}
		// The user disconnected between the sender reading the routing table
		// and this landing. Ordinary rather than an error: for fan-out the
		// event is in their replay outbox, and signalling and presence are
		// both best-effort by design.
		res.Missing++
		wsmetrics.PushReceivedTotal.WithLabelValues("missing").Inc()
	}

	for _, d := range batch.Deliveries {
		if d.UserID == "" || !hasPayload(d.Payload) {
			continue
		}
		deliver(d.UserID, d.Payload)
	}

	// One payload, many recipients — the presence shape. Handled alongside
	// Deliveries rather than instead of them: a batch carrying both is a caller
	// bug worth tolerating, not worth dropping deliveries over.
	if b := batch.Broadcast; b != nil && hasPayload(b.Payload) {
		for _, uid := range b.UserIDs {
			if uid == "" {
				continue
			}
			deliver(uid, b.Payload)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(res)
}

// hasPayload reports whether a delivery carries an actual event.
//
// The JSON null check is not defensive padding. A Delivery built with no
// Payload marshals its nil json.RawMessage as the literal `null`, which decodes
// back into a FOUR-BYTE slice rather than an empty one — so a length check
// alone passes it, and the gateway forwards `null` to the socket as a frame no
// client can parse. Absent and null are the same thing here and both are
// skipped.
func hasPayload(p json.RawMessage) bool {
	trimmed := bytes.TrimSpace(p)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}
