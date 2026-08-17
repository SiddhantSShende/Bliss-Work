package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The client and the server handler are in different packages and are only ever
// exercised together in production. These drive the real transport — a real
// listener, real JSON, real headers — because the failures worth catching here
// are wire-level: a header the server does not read, a body shape it cannot
// decode, a payload mangled by an extra round of encoding.

func TestPushSendsTheTokenAndTheDeliveriesVerbatim(t *testing.T) {
	var (
		gotToken string
		gotBatch Batch
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get(TokenHeader)
		if err := json.NewDecoder(r.Body).Decode(&gotBatch); err != nil {
			t.Errorf("server could not decode the client's body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(Result{Accepted: 2})
	}))
	defer srv.Close()

	res, err := NewClient("secret").Push(context.Background(), srv.URL, []Delivery{
		{UserID: "u1", Payload: json.RawMessage(`{"type":"message.created","n":1}`)},
		{UserID: "u2", Payload: json.RawMessage(`{"type":"message.created","n":2}`)},
	})
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if res.Accepted != 2 {
		t.Errorf("Accepted = %d, want 2", res.Accepted)
	}
	if gotToken != "secret" {
		t.Errorf("token header = %q, want the configured secret", gotToken)
	}
	if len(gotBatch.Deliveries) != 2 {
		t.Fatalf("server saw %d deliveries, want 2", len(gotBatch.Deliveries))
	}
	// The payload must survive the round trip byte for byte. RawMessage is what
	// keeps it embedded JSON; a []byte would arrive base64-encoded and every
	// client would then be handed a string where an object belongs.
	if got := string(gotBatch.Deliveries[0].Payload); got != `{"type":"message.created","n":1}` {
		t.Errorf("payload = %s, want it unchanged and not re-encoded", got)
	}
}

// A push that does not land is not data loss — the event is already in the
// recipient's replay outbox — but it must be REPORTED, or the delivery service
// cannot tell a working node from a broken one.
func TestPushReportsTransportAndStatusFailures(t *testing.T) {
	t.Run("non-200", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer srv.Close()
		_, err := NewClient("wrong").Push(context.Background(), srv.URL,
			[]Delivery{{UserID: "u1", Payload: json.RawMessage(`{}`)}})
		if err == nil {
			t.Error("a 401 was reported as success")
		}
	})

	t.Run("unreachable node", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		addr := srv.URL
		srv.Close() // the node has gone away

		_, err := NewClient("secret").Push(context.Background(), addr,
			[]Delivery{{UserID: "u1", Payload: json.RawMessage(`{}`)}})
		if err == nil {
			t.Error("a push to a dead node was reported as success")
		}
		if !strings.Contains(err.Error(), addr) {
			t.Errorf("error %q does not name the node; with a fleet of them "+
				"that is the only way to tell which one failed", err)
		}
	})
}

// An empty batch must not become a request. Routed delivery reaches this
// whenever an event's whole audience is offline, which is common.
func TestPushSkipsEmptyBatches(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer srv.Close()

	if _, err := NewClient("secret").Push(context.Background(), srv.URL, nil); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if called {
		t.Error("an empty batch produced an HTTP request")
	}
}

// The deliveries landed; only the accounting was unreadable. Turning that into
// an error would make the delivery service retry — and therefore duplicate — a
// push that actually succeeded.
func TestUnreadableResponseIsNotTreatedAsFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	res, err := NewClient("secret").Push(context.Background(), srv.URL, []Delivery{
		{UserID: "u1", Payload: json.RawMessage(`{}`)},
		{UserID: "u2", Payload: json.RawMessage(`{}`)},
	})
	if err != nil {
		t.Fatalf("a 200 with an undecodable body was reported as an error: %v", err)
	}
	if res.Accepted != 2 {
		t.Errorf("Accepted = %d, want the batch size assumed", res.Accepted)
	}
}

// A cancelled context must abandon the push rather than hold the routing
// goroutine open — one unresponsive node cannot be allowed to stall delivery
// to every other node.
func TestPushHonoursContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		select {} // never responds
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewClient("secret").Push(ctx, srv.URL,
		[]Delivery{{UserID: "u1", Payload: json.RawMessage(`{}`)}}); err == nil {
		t.Error("a cancelled context did not abort the push")
	}
}
