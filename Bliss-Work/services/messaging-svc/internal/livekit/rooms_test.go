package livekit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

	m, err := New("APIkey", testSecret, srv.URL)
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

// The token must be scoped to the ONE room being closed. A roomAdmin token
// valid for every room is a far more dangerous thing to leak from a log or a
// proxy than one that can close a meeting which is already over.
func TestDeleteRoomTokenIsScopedToThatRoom(t *testing.T) {
	m, err := New("APIkey", testSecret, "ws://sfu:7880")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	raw, err := m.roomAdminToken("call-123")
	if err != nil {
		t.Fatalf("roomAdminToken: %v", err)
	}
	tok, err := jwt.Parse([]byte(raw), jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	grant, ok := tok.PrivateClaims()["video"].(map[string]any)
	if !ok {
		t.Fatalf("no video grant: %v", tok.PrivateClaims())
	}
	if grant["roomAdmin"] != true {
		t.Errorf("roomAdmin = %v, want true", grant["roomAdmin"])
	}
	if grant["room"] != "call-123" {
		t.Errorf("room = %v, want call-123", grant["room"])
	}
	// Never a blanket grant.
	if grant["roomList"] == true || grant["roomCreate"] == true {
		t.Errorf("token carries a wider grant than closing one room: %v", grant)
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
	m, err := New("APIkey", testSecret, "ws://sfu:7880")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := m.DeleteRoom(context.Background(), "  "); err == nil {
		t.Error("empty room name accepted")
	}
}

// A non-200 must surface, so the caller can log that the room outlived the call.
func TestDeleteRoomSurfacesServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"msg":"boom"}`))
	}))
	defer srv.Close()

	m, _ := New("APIkey", testSecret, srv.URL)
	if err := m.DeleteRoom(context.Background(), "call-123"); err == nil {
		t.Error("500 from the SFU was reported as success")
	}
}
