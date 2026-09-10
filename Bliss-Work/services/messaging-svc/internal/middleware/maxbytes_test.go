package middleware

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// mustURL parses a path into a *url.URL for hand-built http.Request values.
func mustURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

// echoBody reads the entire request body and reports back how many bytes it
// consumed plus whether the read terminated in an error. http.MaxBytesReader
// surfaces the cap as a read error once the limit is crossed, so a handler that
// drains the body (as json.Decode does) sees it here.
func echoBody() (http.Handler, *bodyResult) {
	res := &bodyResult{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		res.read = n
		res.err = err
		if err != nil {
			// Mirror what a real handler does: a body that overflows the cap
			// can't be decoded, so it must fail the request rather than 200.
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return h, res
}

type bodyResult struct {
	read int64
	err  error
}

func TestMaxBytes_TableDriven(t *testing.T) {
	const limit = int64(16)

	cases := []struct {
		name        string
		method      string
		bodyLen     int
		wantStatus  int
		wantReadErr bool
		// wantRead is how many bytes the handler should observe before any cap
		// error. MaxBytesReader lets exactly limit bytes through, so an
		// over-limit body is observed as `limit` read bytes + an error.
		wantRead int64
	}{
		{
			name:       "under limit passes",
			method:     http.MethodPost,
			bodyLen:    10,
			wantStatus: http.StatusOK,
			wantRead:   10,
		},
		{
			name:       "exactly at limit passes",
			method:     http.MethodPost,
			bodyLen:    int(limit),
			wantStatus: http.StatusOK,
			wantRead:   limit,
		},
		{
			name:        "over limit errors",
			method:      http.MethodPost,
			bodyLen:     int(limit) + 1,
			wantStatus:  http.StatusBadRequest,
			wantReadErr: true,
			wantRead:    limit,
		},
		{
			name:        "way over limit errors",
			method:      http.MethodPost,
			bodyLen:     int(limit) * 100,
			wantStatus:  http.StatusBadRequest,
			wantReadErr: true,
			wantRead:    limit,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			inner, res := echoBody()
			h := MaxBytes(limit)(inner)

			body := strings.Repeat("a", c.bodyLen)
			req := httptest.NewRequest(c.method, "/", bytes.NewReader([]byte(body)))
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)

			if rr.Code != c.wantStatus {
				t.Errorf("status = %d, want %d", rr.Code, c.wantStatus)
			}
			if got := res.err != nil; got != c.wantReadErr {
				t.Errorf("read error present = %v (err=%v), want %v", got, res.err, c.wantReadErr)
			}
			if res.read != c.wantRead {
				t.Errorf("bytes read by handler = %d, want %d", res.read, c.wantRead)
			}
		})
	}
}

// A nil body must not panic — the guard in MaxBytes only wraps a non-nil body.
// httptest.NewRequest always supplies a non-nil body, so construct the request
// directly to exercise the nil case the way the real server can see it.
func TestMaxBytes_NilBodyIsNoop(t *testing.T) {
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Body != nil {
			t.Errorf("expected nil body to be left nil, got %T", r.Body)
		}
		w.WriteHeader(http.StatusOK)
	})
	h := MaxBytes(8)(inner)

	req := &http.Request{Method: http.MethodGet, URL: mustURL("/"), Header: make(http.Header)}
	req.Body = nil
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !called {
		t.Fatal("next handler was not called for nil-body request")
	}
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
}

// A GET with a normal small body still streams through untouched (the cap only
// bites on overflow), so reads under the cap behave identically regardless of
// method.
func TestMaxBytes_UnderLimitReadsFullBody(t *testing.T) {
	inner, res := echoBody()
	h := MaxBytes(1024)(inner)

	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader("hello world"))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if res.read != int64(len("hello world")) {
		t.Errorf("read = %d, want %d", res.read, len("hello world"))
	}
	if res.err != nil {
		t.Errorf("unexpected read error: %v", res.err)
	}
}
