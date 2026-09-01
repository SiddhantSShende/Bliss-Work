package pins

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The rows this client fetches are CLAIMED upstream — sticky-svc increments
// delivery_attempts in the same statement that returns them. So every failure
// mode here costs a real nudge attempt, and the handling has to be deliberate.

func TestSendsTheInternalToken(t *testing.T) {
	var gotToken, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Internal-Token")
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	if _, err := New(srv.URL, "sekrit").Undelivered(context.Background(), 5*time.Minute, 50); err != nil {
		t.Fatalf("Undelivered: %v", err)
	}
	if gotToken != "sekrit" {
		t.Errorf("token: got %q, want %q", gotToken, "sekrit")
	}
	// The age and the page size are the blast-radius controls; they must
	// actually reach the server rather than silently defaulting.
	if gotQuery != "limit=50&older_than_s=300" {
		t.Errorf("query: got %q", gotQuery)
	}
}

func TestParsesPins(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
		  {"taskId":"t1","orgId":"o1","assigneeId":"alice",
		   "openedAt":"2026-09-01T12:00:00Z","deliveryAttempts":2}
		]`))
	}))
	defer srv.Close()

	got, err := New(srv.URL, "t").Undelivered(context.Background(), time.Minute, 10)
	if err != nil {
		t.Fatalf("Undelivered: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d pins, want 1", len(got))
	}
	if got[0].AssigneeID != "alice" || got[0].DeliveryAttempts != 2 {
		t.Errorf("unexpected pin: %+v", got[0])
	}
	if !got[0].OpenedAt.Equal(time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("openedAt: got %v", got[0].OpenedAt)
	}
}

func TestOneUnparseableRowDoesNotDiscardThePage(t *testing.T) {
	// The page is already claimed. Dropping all of it because one row has a bad
	// timestamp would silently spend an attempt on every other pin in it.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
		  {"taskId":"bad","orgId":"o1","assigneeId":"bob","openedAt":"not-a-date"},
		  {"taskId":"t1","orgId":"o1","assigneeId":"alice","openedAt":"2026-09-01T12:00:00Z"}
		]`))
	}))
	defer srv.Close()

	got, err := New(srv.URL, "t").Undelivered(context.Background(), time.Minute, 10)
	if err != nil {
		t.Fatalf("Undelivered: %v", err)
	}
	if len(got) != 1 || got[0].AssigneeID != "alice" {
		t.Errorf("expected the good row to survive, got %+v", got)
	}
}

func TestErrorsAreReportedNotPanicked(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"server error", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
		}},
		{"rejected token", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}},
		{"malformed body", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{not json`))
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()
			if _, err := New(srv.URL, "t").Undelivered(context.Background(), time.Minute, 10); err == nil {
				t.Error("expected an error, got nil")
			}
		})
	}
}

func TestHonoursContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := New(srv.URL, "t").Undelivered(ctx, time.Minute, 10); err == nil {
		t.Error("a hung dependency must not hang the sweep loop")
	}
}
