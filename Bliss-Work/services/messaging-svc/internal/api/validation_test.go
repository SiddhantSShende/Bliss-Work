package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// validUUID is the gatekeeper every id-bearing handler runs before it touches
// the store, so its correctness is load-bearing: a false positive would feed a
// malformed id straight into a parametrized query.
func TestValidUUID_TableDriven(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"canonical v4", "123e4567-e89b-12d3-a456-426614174000", true},
		{"nil uuid", "00000000-0000-0000-0000-000000000000", true},
		{"uppercase", "123E4567-E89B-12D3-A456-426614174000", true},
		{"urn prefix accepted by uuid.Parse", "urn:uuid:123e4567-e89b-12d3-a456-426614174000", true},
		{"braced form accepted by uuid.Parse", "{123e4567-e89b-12d3-a456-426614174000}", true},
		{"empty", "", false},
		{"not a uuid", "hello", false},
		{"too short", "123e4567-e89b-12d3-a456", false},
		{"missing hyphens but right length is rejected when wrong", "123e4567e89b12d3a456-26614174000", false},
		{"trailing junk", "123e4567-e89b-12d3-a456-426614174000x", false},
		{"sql-ish injection", "1; DROP TABLE messages;", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validUUID(c.in); got != c.want {
				t.Errorf("validUUID(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

// sendMessage runs full request validation BEFORE it dereferences the store, so
// every bad-input case here returns 400 without a live DB. A nil-store Server is
// safe for exactly these reject paths.
func TestSendMessage_ValidationRejects(t *testing.T) {
	validUUIDStr := "123e4567-e89b-12d3-a456-426614174000"
	otherUUID := "223e4567-e89b-12d3-a456-426614174000"

	cases := []struct {
		name string
		body string
	}{
		{"malformed json", `{`},
		{"empty object", `{}`},
		{"missing recipientId", `{"body":"hi","clientMsgId":"` + validUUIDStr + `"}`},
		{"bad recipientId", `{"recipientId":"nope","body":"hi","clientMsgId":"` + validUUIDStr + `"}`},
		{"empty body", `{"recipientId":"` + validUUIDStr + `","body":"","clientMsgId":"` + otherUUID + `"}`},
		{"missing clientMsgId", `{"recipientId":"` + validUUIDStr + `","body":"hi"}`},
		{"bad clientMsgId", `{"recipientId":"` + validUUIDStr + `","body":"hi","clientMsgId":"nope"}`},
	}

	s := &Server{} // store is nil — reject paths must not reach it.
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/messages", strings.NewReader(c.body))
			rr := httptest.NewRecorder()
			s.sendMessage(rr, req)

			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", rr.Code, c.body)
			}
		})
	}
}

// reply validates the conversation id from the URL and then the body fields,
// both before any store call — so all rejects are testable without a DB.
func TestReply_ValidationRejects(t *testing.T) {
	validUUIDStr := "123e4567-e89b-12d3-a456-426614174000"

	cases := []struct {
		name   string
		convID string
		body   string
	}{
		{"bad conversation id", "not-a-uuid", `{"body":"hi","clientMsgId":"` + validUUIDStr + `"}`},
		{"valid id but malformed json", validUUIDStr, `{`},
		{"valid id but empty body", validUUIDStr, `{"body":"","clientMsgId":"` + validUUIDStr + `"}`},
		{"valid id but bad clientMsgId", validUUIDStr, `{"body":"hi","clientMsgId":"nope"}`},
	}

	s := &Server{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/conv/"+c.convID+"/reply", strings.NewReader(c.body))
			// reply reads the id via chi.URLParam, so seed a route context.
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", c.convID)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

			rr := httptest.NewRecorder()
			s.reply(rr, req)

			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (convID=%s body=%s)", rr.Code, c.convID, c.body)
			}
		})
	}
}

// The Inbox surface presents itself as a mailbox and asks for MAIL + THREAD;
// nothing else passes a kinds filter today. Absent must therefore keep meaning
// "everything", or every caller that predates the filter loses rows.
func TestInboxKinds(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		want   []string
		wantOK bool
	}{
		{"absent means every kind", "", nil, true},
		{"the Inbox surface's filter", "MAIL,THREAD", []string{"MAIL", "THREAD"}, true},
		{"case and spacing are the caller's business", " mail , Thread ", []string{"MAIL", "THREAD"}, true},
		// The enum can only grow. A client asking for a kind this build has
		// never heard of should get the kinds it does know, not a 400.
		{"unknown kinds are dropped, not rejected", "MAIL,PIGEON", []string{"MAIL"}, true},
		// But a list naming ONLY unknown kinds is a caller asking for nothing,
		// and answering "everything" would be the exact opposite of the ask.
		{"a list of only unknown kinds is a bad request", "PIGEON", nil, false},
		{"a list of only separators is a bad request", " , , ", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := inboxKinds(c.raw)
			if ok != c.wantOK {
				t.Fatalf("inboxKinds(%q) ok = %v, want %v", c.raw, ok, c.wantOK)
			}
			if len(got) != len(c.want) {
				t.Fatalf("inboxKinds(%q) = %v, want %v", c.raw, got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("inboxKinds(%q) = %v, want %v", c.raw, got, c.want)
				}
			}
		})
	}
}
