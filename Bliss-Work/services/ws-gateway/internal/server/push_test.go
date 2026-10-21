package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/push"
)

// pushTestServer builds a minimal Server sufficient to exercise handlePush in
// isolation: a real (unregistered-with-anyone-else) *hub.Hub with no live
// sockets, and a fixed internal token. No network, no Redis, no Kafka.
func pushTestServer(token string) *Server {
	return &Server{
		cfg: Config{WSGatewayInternalToken: token},
		hub: hub.New(),
	}
}

func doPush(t *testing.T, s *Server, token, caller string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, push.Path, bytes.NewReader(body))
	if token != "" {
		req.Header.Set(push.TokenHeader, token)
	}
	if caller != "" {
		req.Header.Set(push.CallerHeader, caller)
	}
	rec := httptest.NewRecorder()
	s.handlePush(rec, req)
	return rec
}

func deliveriesBody(t *testing.T) []byte {
	t.Helper()
	b, err := json.Marshal(push.Batch{Deliveries: []push.Delivery{{UserID: "u1", Payload: json.RawMessage(`{"a":1}`)}}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func broadcastBody(t *testing.T) []byte {
	t.Helper()
	b, err := json.Marshal(push.Batch{Broadcast: &push.Broadcast{UserIDs: []string{"u1", "u2"}, Payload: json.RawMessage(`{"a":1}`)}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// 1. Valid authorized internal caller succeeds, for each role sending the
// batch shape that role is actually allowed to send.
func TestHandlePush_AuthorizedCallerSucceeds(t *testing.T) {
	s := pushTestServer("supersecret")

	rec := doPush(t, s, "supersecret", push.CallerDeliverySvc, deliveriesBody(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("delivery-svc posting Deliveries: got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}

	rec = doPush(t, s, "supersecret", push.CallerGatewayPeer, broadcastBody(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("gateway peer posting Broadcast: got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}

// 2. Missing or invalid credentials are rejected.
func TestHandlePush_MissingOrInvalidTokenRejected(t *testing.T) {
	s := pushTestServer("supersecret")

	for _, tok := range []string{"", "wrong-token"} {
		rec := doPush(t, s, tok, push.CallerDeliverySvc, deliveriesBody(t))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("token %q: got %d, want 401", tok, rec.Code)
		}
	}
}

// 2b. An unconfigured server secret fails CLOSED — never "accept anything",
// which is the specific property internalauth.Matches documents and this
// handler relies on.
func TestHandlePush_UnconfiguredServerSecretRejectsEveryCaller(t *testing.T) {
	s := pushTestServer("") // WS_GATEWAY_INTERNAL_TOKEN unset

	rec := doPush(t, s, "anything-at-all", push.CallerDeliverySvc, deliveriesBody(t))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 when the server has no configured secret", rec.Code)
	}
}

// 4. Authenticated (correct token) but unauthorized/unidentified caller
// identity is rejected rather than defaulted into a role.
func TestHandlePush_AuthenticatedButUnknownCallerRejected(t *testing.T) {
	s := pushTestServer("supersecret")

	for _, caller := range []string{"", "some-other-service", "Delivery-Svc"} {
		rec := doPush(t, s, "supersecret", caller, deliveriesBody(t))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("caller %q: got %d, want 401", caller, rec.Code)
		}
	}
}

// 4b/6. A recognized-but-wrong role for the batch shape it sent is rejected:
// this is what stops a holder of the shared secret acting outside the role it
// claims (a gateway peer posting addressed Deliveries as if it were
// delivery-svc, or vice versa) — the closest this layer can come to rejecting
// a forged caller identity, since the token itself carries no identity of its
// own.
func TestHandlePush_WrongRoleForBatchShapeRejected(t *testing.T) {
	s := pushTestServer("supersecret")

	rec := doPush(t, s, "supersecret", push.CallerGatewayPeer, deliveriesBody(t))
	if rec.Code != http.StatusForbidden {
		t.Errorf("gateway-peer posting Deliveries: got %d, want 403", rec.Code)
	}

	rec = doPush(t, s, "supersecret", push.CallerDeliverySvc, broadcastBody(t))
	if rec.Code != http.StatusForbidden {
		t.Errorf("delivery-svc posting Broadcast: got %d, want 403", rec.Code)
	}
}

// 7. Malformed body is rejected before any authorization-by-shape decision
// can even be made.
func TestHandlePush_MalformedBodyRejected(t *testing.T) {
	s := pushTestServer("supersecret")

	rec := doPush(t, s, "supersecret", push.CallerDeliverySvc, []byte("{not json"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

// Wrong HTTP method is rejected regardless of credentials.
func TestHandlePush_WrongMethodRejected(t *testing.T) {
	s := pushTestServer("supersecret")

	req := httptest.NewRequest(http.MethodGet, push.Path, nil)
	req.Header.Set(push.TokenHeader, "supersecret")
	req.Header.Set(push.CallerHeader, push.CallerDeliverySvc)
	rec := httptest.NewRecorder()
	s.handlePush(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d, want 405", rec.Code)
	}
}

// A batch that mixes a caller-appropriate shape with no content in the other
// (e.g. a nil-payload Broadcast alongside Deliveries) must not be rejected —
// hasPayload's nil/empty check is what gates the cross-shape authorization,
// matching the existing "batch carrying both is a caller bug worth
// tolerating" contract from push.Batch's own doc comment.
func TestHandlePush_EmptyBroadcastAlongsideDeliveriesStillAuthorized(t *testing.T) {
	s := pushTestServer("supersecret")
	body, err := json.Marshal(push.Batch{
		Deliveries: []push.Delivery{{UserID: "u1", Payload: json.RawMessage(`{"a":1}`)}},
		Broadcast:  &push.Broadcast{},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	rec := doPush(t, s, "supersecret", push.CallerDeliverySvc, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
}
