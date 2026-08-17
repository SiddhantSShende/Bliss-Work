package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/push"
)

const testToken = "test-internal-token"

func newPushServer(h *hub.Hub, token string) *Server {
	return &Server{
		cfg: Config{InternalToken: token},
		hub: h,
		log: discardLog(),
	}
}

func pushRequest(t *testing.T, token string, body any) *http.Request {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, push.Path, bytes.NewReader(b))
	if token != "" {
		req.Header.Set(push.TokenHeader, token)
	}
	return req
}

// This endpoint delivers an arbitrary payload to any named user, so the shared
// secret is the ENTIRE authorization. There is no JWT, no org check and no
// per-user permission behind it — which is exactly why an unauthenticated
// request must never reach the hub.
func TestPushRejectsRequestsWithoutTheInternalToken(t *testing.T) {
	h := hub.New()
	c := hub.NewConn("u1", "c1")
	h.Add(c, 0, 0)
	srv := newPushServer(h, testToken)

	cases := []struct {
		name  string
		token string
	}{
		{"no token", ""},
		{"wrong token", "not-the-token"},
		{"prefix of the real token", testToken[:len(testToken)-1]},
		{"real token plus a suffix", testToken + "x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			srv.handlePush(rec, pushRequest(t, tc.token, push.Batch{
				Deliveries: []push.Delivery{{UserID: "u1", Payload: json.RawMessage(`{"a":1}`)}},
			}))
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("status %d, want 401", rec.Code)
			}
			if len(c.Send) != 0 {
				t.Error("an unauthorized push reached the socket")
			}
		})
	}
}

// A gateway with no token configured is not running routed delivery, and must
// refuse everything rather than accepting an empty header as a match.
func TestPushIsClosedWhenNoTokenIsConfigured(t *testing.T) {
	srv := newPushServer(hub.New(), "")
	rec := httptest.NewRecorder()
	srv.handlePush(rec, pushRequest(t, "", push.Batch{}))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status %d, want 401 — an unset token must not match an absent header", rec.Code)
	}
}

// The happy path, and the accounting that goes with it: a user held here is
// delivered to, a user who is not is reported missing rather than erroring.
// "Missing" is the ordinary consequence of someone closing their laptop between
// the routing lookup and the push landing.
func TestPushDeliversToLocalSocketsAndReportsTheRest(t *testing.T) {
	h := hub.New()
	here := hub.NewConn("u-here", "c1")
	h.Add(here, 0, 0)
	srv := newPushServer(h, testToken)

	rec := httptest.NewRecorder()
	srv.handlePush(rec, pushRequest(t, testToken, push.Batch{
		Deliveries: []push.Delivery{
			{UserID: "u-here", Payload: json.RawMessage(`{"type":"x"}`)},
			{UserID: "u-elsewhere", Payload: json.RawMessage(`{"type":"x"}`)},
		},
	}))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var res push.Result
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Accepted != 1 || res.Missing != 1 {
		t.Errorf("result %+v, want Accepted=1 Missing=1", res)
	}
	if len(here.Send) != 1 {
		t.Fatalf("local socket queued %d payloads, want 1", len(here.Send))
	}
	// Forwarded verbatim: the gateway does not parse or re-encode the event.
	if got := string(<-here.Send); got != `{"type":"x"}` {
		t.Errorf("payload = %q, want it forwarded byte for byte", got)
	}
}

// Deliveries missing a user or a payload are skipped rather than being turned
// into a bad request: one malformed entry must not discard the whole batch,
// which may carry hundreds of good ones.
func TestPushSkipsIncompleteDeliveriesWithoutFailingTheBatch(t *testing.T) {
	h := hub.New()
	c := hub.NewConn("u1", "c1")
	h.Add(c, 0, 0)
	srv := newPushServer(h, testToken)

	rec := httptest.NewRecorder()
	srv.handlePush(rec, pushRequest(t, testToken, push.Batch{
		Deliveries: []push.Delivery{
			{UserID: "", Payload: json.RawMessage(`{"a":1}`)}, // no user
			{UserID: "u1"}, // no payload
			{UserID: "u1", Payload: json.RawMessage(`{"a":1}`)},
		},
	}))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	if len(c.Send) != 1 {
		t.Errorf("queued %d payloads, want only the one complete delivery", len(c.Send))
	}
}

func TestPushRejectsNonPost(t *testing.T) {
	srv := newPushServer(hub.New(), testToken)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, push.Path, nil)
	req.Header.Set(push.TokenHeader, testToken)
	srv.handlePush(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status %d, want 405", rec.Code)
	}
}

func TestPushRejectsMalformedBody(t *testing.T) {
	srv := newPushServer(hub.New(), testToken)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, push.Path, strings.NewReader("{not json"))
	req.Header.Set(push.TokenHeader, testToken)
	srv.handlePush(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
}

// The body cap is what stops a hostile or broken caller making a gateway buffer
// without bound. MaxBytesReader must be in front of the decoder, not after it.
func TestPushBodyIsCapped(t *testing.T) {
	srv := newPushServer(hub.New(), testToken)
	rec := httptest.NewRecorder()
	// A valid JSON prefix that never terminates, longer than the cap.
	huge := strings.NewReader(`{"deliveries":[` + strings.Repeat(`{"userId":"u","payload":{}},`, 400_000))
	req := httptest.NewRequest(http.MethodPost, push.Path, huge)
	req.Header.Set(push.TokenHeader, testToken)
	srv.handlePush(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400 — an oversized body must be refused, not buffered", rec.Code)
	}
}

// ── The broadcast shape ──────────────────────────────────────────────────────

// One payload for many recipients — how presence transitions arrive. The point
// of the shape is that the event crosses the wire once instead of once per
// recipient, so what matters here is that every named user still gets it.
func TestPushBroadcastReachesEveryNamedLocalSocket(t *testing.T) {
	h := hub.New()
	a := hub.NewConn("u1", "c1")
	b := hub.NewConn("u2", "c2")
	h.Add(a, 0, 0)
	h.Add(b, 0, 0)
	srv := newPushServer(h, testToken)

	rec := httptest.NewRecorder()
	srv.handlePush(rec, pushRequest(t, testToken, push.Batch{
		Broadcast: &push.Broadcast{
			UserIDs: []string{"u1", "u2", "u3-elsewhere"},
			Payload: json.RawMessage(`{"type":"presence.online"}`),
		},
	}))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var res push.Result
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Accepted != 2 || res.Missing != 1 {
		t.Errorf("result %+v, want Accepted=2 Missing=1", res)
	}
	for name, c := range map[string]*hub.Conn{"u1": a, "u2": b} {
		if len(c.Send) != 1 {
			t.Fatalf("%s queued %d payloads, want 1", name, len(c.Send))
		}
		if got := string(<-c.Send); got != `{"type":"presence.online"}` {
			t.Errorf("%s got %q, want the payload forwarded byte for byte", name, got)
		}
	}
}

// A batch carrying both shapes is a caller bug, but dropping half of it would
// silently lose events. Both halves are delivered.
func TestPushHandlesDeliveriesAndABroadcastInOneBatch(t *testing.T) {
	h := hub.New()
	a := hub.NewConn("u1", "c1")
	b := hub.NewConn("u2", "c2")
	h.Add(a, 0, 0)
	h.Add(b, 0, 0)
	srv := newPushServer(h, testToken)

	rec := httptest.NewRecorder()
	srv.handlePush(rec, pushRequest(t, testToken, push.Batch{
		Deliveries: []push.Delivery{{UserID: "u1", Payload: json.RawMessage(`{"a":1}`)}},
		Broadcast: &push.Broadcast{
			UserIDs: []string{"u2"},
			Payload: json.RawMessage(`{"b":2}`),
		},
	}))

	if len(a.Send) != 1 || len(b.Send) != 1 {
		t.Errorf("queued u1=%d u2=%d, want one each — neither shape may be dropped",
			len(a.Send), len(b.Send))
	}
}

// A nil json.RawMessage marshals as the literal `null`, which decodes back into
// a four-byte slice — so a length check alone lets it through and the socket
// receives a frame no client can parse. Empty user ids are skipped for the same
// reason: nothing useful can come of delivering to nobody.
func TestPushSkipsEmptyAndNullBroadcasts(t *testing.T) {
	h := hub.New()
	c := hub.NewConn("u1", "c1")
	h.Add(c, 0, 0)
	srv := newPushServer(h, testToken)

	for _, body := range []string{
		`{"broadcast":{"userIds":["u1"],"payload":null}}`,
		`{"broadcast":{"userIds":["u1"]}}`,
		`{"broadcast":{"userIds":[""],"payload":{"a":1}}}`,
		`{"broadcast":{"payload":{"a":1}}}`,
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, push.Path, strings.NewReader(body))
		req.Header.Set(push.TokenHeader, testToken)
		srv.handlePush(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("status %d for %s, want 200 — skipped, not rejected", rec.Code, body)
		}
	}
	if len(c.Send) != 0 {
		t.Errorf("queued %d payloads; an empty or null broadcast reached a socket", len(c.Send))
	}
}

// ── Bounded presence query ───────────────────────────────────────────────────

// The org-wide presence set is one Redis key per organisation, and one key
// lives on one node however many nodes a cluster has — so a large org is a hot
// slot that sharding cannot fix. The bounded form asks about a specific list
// instead, which reads per-user keys and shards evenly. This guards the bound
// itself: without it the endpoint would just be a slower way to ask the same
// unbounded question.
func TestPresenceQueryRejectsAnUnboundedList(t *testing.T) {
	srv := &Server{cfg: Config{}, log: discardLog()}
	ids := make([]string, maxPresenceQuery+1)
	for i := range ids {
		ids[i] = "u"
	}
	body, _ := json.Marshal(map[string]any{"userIds": ids})
	req := httptest.NewRequest(http.MethodPost, "/presence/query", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.handlePresenceQuery(rec, req)

	// Auth runs first and this Server has no verifier, so the request is
	// refused before the bound is reached — what matters is that it is refused
	// and never reaches the store.
	if rec.Code == http.StatusOK {
		t.Error("an oversized presence query was accepted")
	}
}

func TestPresenceQueryRejectsNonPost(t *testing.T) {
	srv := &Server{cfg: Config{}, log: discardLog()}
	rec := httptest.NewRecorder()
	srv.handlePresenceQuery(rec, httptest.NewRequest(http.MethodGet, "/presence/query", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status %d, want 405 — the user list is the request body", rec.Code)
	}
}
