package livekit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// Ending a call has to actually close the room. Before this, ending was a
// database fact alone — the row went ENDED and an event went out, but everyone
// stayed connected with media flowing because the SFU was never told.
func TestDeleteRoomPostsTwirpRequest(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	m, err := New("APIkey", testSecret, srv.URL, MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := m.DeleteRoom(context.Background(), "call-123"); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}

	if gotPath != "/twirp/livekit.RoomService/DeleteRoom" {
		t.Errorf("path = %q", gotPath)
	}
	if gotBody["room"] != "call-123" {
		t.Errorf("room = %q, want call-123", gotBody["room"])
	}
	if !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("authorization = %q, want a bearer token", gotAuth)
	}
}

// Regression test: the Twirp RoomService API (what DeleteRoom calls)
// authorizes on `roomCreate` alone — it does not recognise `roomAdmin`, which
// governs a PARTICIPANT's own permissions over the realtime connection, a
// completely different authorization path. A token minted with `roomAdmin`
// here is rejected by LiveKit with 401 "permissions denied" — confirmed
// against a live deployment, not merely a documentation reading. See
// roomManagementToken's own doc comment for the full explanation, including
// why `roomCreate` cannot be scoped to one room the way `roomAdmin` can.
func TestRoomManagementTokenCarriesRoomCreate(t *testing.T) {
	m, err := New("APIkey", testSecret, "ws://sfu:7880", MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	raw, err := m.roomManagementToken()
	if err != nil {
		t.Fatalf("roomManagementToken: %v", err)
	}
	tok, err := jwt.Parse([]byte(raw), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	grant, ok := tok.PrivateClaims()["video"].(map[string]any)
	if !ok {
		t.Fatalf("no video grant: %v", tok.PrivateClaims())
	}
	if grant["roomCreate"] != true {
		t.Errorf("roomCreate = %v, want true — this is what RoomService.DeleteRoom actually checks", grant["roomCreate"])
	}
	if grant["roomAdmin"] == true {
		t.Errorf("roomAdmin is set but RoomService does not check it — this is the exact bug being regression-tested: %v", grant)
	}
}

// The mitigation for roomCreate necessarily being a service-wide grant (see
// roomManagementToken's doc comment) is keeping its lifetime barely longer
// than the single request that uses it — not scoping, which isn't available.
func TestRoomManagementTokenHasAShortLifetime(t *testing.T) {
	m, err := New("APIkey", testSecret, "ws://sfu:7880", MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	raw, err := m.roomManagementToken()
	if err != nil {
		t.Fatalf("roomManagementToken: %v", err)
	}
	tok, err := jwt.Parse([]byte(raw), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	ttl := tok.Expiration().Sub(tok.IssuedAt())
	if ttl <= 0 || ttl > 10*time.Minute {
		t.Errorf("ttl = %v, want a short, bounded lifetime", ttl)
	}
}

// A deployment with no SFU configured must not report an error the caller has
// to special-case at every site — endCall checks for exactly this.
func TestDeleteRoomOnUnconfiguredMinter(t *testing.T) {
	var m Minter
	if err := m.DeleteRoom(context.Background(), "call-123"); err != ErrNotConfigured {
		t.Errorf("err = %v, want ErrNotConfigured", err)
	}
}

// An empty room name would delete nothing and mask a caller bug.
func TestDeleteRoomRejectsEmptyName(t *testing.T) {
	m, err := New("APIkey", testSecret, "ws://sfu:7880", MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := m.DeleteRoom(context.Background(), "  "); err == nil {
		t.Error("empty room name accepted")
	}
}

// DeleteRoom must reach the SFU at an internal address when one is
// configured, the same override egress.go's Recorder already honours —
// otherwise a deployment where messaging-svc cannot reach LiveKit at the
// address browsers use can mint tokens and join calls, but can never close a
// room server-side.
func TestDeleteRoomUsesAPIURLOverrideWhenSet(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	// url deliberately points nowhere reachable — only apiURL should be used.
	m, err := New("APIkey", testSecret, "wss://unreachable.invalid",
		MinterOptions{APIURL: srv.URL})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := m.DeleteRoom(context.Background(), "call-123"); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	if gotPath != "/twirp/livekit.RoomService/DeleteRoom" {
		t.Errorf("path = %q, apiURL override was not used", gotPath)
	}
}

// A non-200 must surface, so the caller can log that the room outlived the call.
func TestDeleteRoomSurfacesServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"msg":"boom"}`))
	}))
	defer srv.Close()

	m, _ := New("APIkey", testSecret, srv.URL, MinterOptions{})
	if err := m.DeleteRoom(context.Background(), "call-123"); err == nil {
		t.Error("500 from the SFU was reported as success")
	}
}
