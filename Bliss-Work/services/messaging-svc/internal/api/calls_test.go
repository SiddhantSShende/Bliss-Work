package api

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

// The stop-sharing control belongs to the person sharing, and to nobody else.
//
// That requirement cannot be met by a permission check alone — a check can be
// weakened later without anything failing. It is met by the SHAPE of the API:
// there is no route that names whose share to stop, so no other participant can
// construct a request that ends yours. This walks the real router and fails if
// one ever appears.
//
// The two legitimate exceptions are both departures rather than interventions,
// and neither takes a target: leaving the call stops your own share, and ending
// the call stops everyone's.
func TestNoRouteCanStopAnotherParticipantsShare(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}

	var offenders []string
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.Contains(route, "/share") {
			return nil
		}
		// A share route may be parameterised by the CALL and by nothing else.
		// Any second URL parameter would be a way to name a person, which is
		// the door this test exists to keep shut.
		params := strings.Count(route, "{")
		if params > 1 {
			offenders = append(offenders, method+" "+route)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("share route(s) carry a second parameter, which can name a target user:\n  %s\n\n"+
			"Stopping a share must only ever act on the caller's own. If a host force-stop is "+
			"genuinely wanted, that is a product decision to take deliberately — it is the exact "+
			"control the requirement says other participants must not have.",
			strings.Join(offenders, "\n  "))
	}
}

// The waiting-room and sharing routes must exist under the authenticated,
// body-capped /api/v1 group like every other call route. A typo that registered
// one at the wrong prefix would leave it outside both the auth middleware and
// mw.MaxBytes, and nothing else in the suite would notice.
func TestCallLobbyAndShareRoutesAreRegistered(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}

	want := map[string]bool{
		"POST /api/v1/calls/{id}/start":      false,
		"POST /api/v1/calls/{id}/share":      false,
		"POST /api/v1/calls/{id}/share/stop": false,
	}
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := method + " " + strings.TrimSuffix(route, "/")
		if _, expected := want[key]; expected {
			want[key] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	for route, found := range want {
		if !found {
			t.Errorf("route not registered: %s", route)
		}
	}
}

// A long title in a non-Latin script must survive being cut.
//
// The naive title[:200] this replaced cut wherever byte 200 landed, which in
// Hindi, Japanese or an emoji-bearing title is nearly always mid-character. The
// result is invalid UTF-8, and Postgres refuses invalid UTF-8 in a text column
// outright — so the bug was not a cosmetic mangled character, it was "scheduling
// a meeting fails, for these users, at this length, and nowhere else".
func TestTruncateTitleNeverSplitsARune(t *testing.T) {
	cases := map[string]string{
		"devanagari": strings.Repeat("न", 200),  // 3 bytes each
		"emoji":      strings.Repeat("📹", 100),  // 4 bytes each, surrogate-ish
		"japanese":   strings.Repeat("会議", 100), // 3 bytes each
		"ascii":      strings.Repeat("a", 500),
		"mixed":      strings.Repeat("a📹न", 90),
	}
	for name, in := range cases {
		got := truncateTitle(in)
		if len(got) > maxCallTitleBytes {
			t.Errorf("%s: %d bytes, want <= %d", name, len(got), maxCallTitleBytes)
		}
		if !utf8.ValidString(got) {
			t.Errorf("%s: truncation produced invalid UTF-8; Postgres will reject this row", name)
		}
		if !strings.HasPrefix(in, got) {
			t.Errorf("%s: truncation changed the text it kept", name)
		}
	}

	// Short titles are returned untouched, multi-byte or not.
	for _, in := range []string{"", "standup", "टीम मीटिंग", "📹 sync"} {
		if got := truncateTitle(in); got != in {
			t.Errorf("truncateTitle(%q) = %q, want it unchanged", in, got)
		}
	}

	// At most three bytes are given up to find a boundary — a cut that walked
	// back further would be silently dropping characters the limit allowed.
	long := strings.Repeat("न", 200)
	if got := truncateTitle(long); len(got) < maxCallTitleBytes-3 {
		t.Errorf("truncateTitle dropped %d bytes to find a boundary, want at most 3",
			maxCallTitleBytes-len(got))
	}
}

// The person who just arrived in the lobby is not told about their own arrival.
func TestWithoutIDDropsTheNamedUser(t *testing.T) {
	got := withoutID([]string{"host", "waiter", "other"}, "waiter")
	if len(got) != 2 || got[0] != "host" || got[1] != "other" {
		t.Fatalf("withoutID = %v, want [host other]", got)
	}
	// Removing someone who is not there must not disturb the list — a waiter
	// who cannot start the call is never in the starter list to begin with.
	if got := withoutID([]string{"host"}, "waiter"); len(got) != 1 || got[0] != "host" {
		t.Fatalf("withoutID = %v, want [host]", got)
	}
	if got := withoutID(nil, "x"); len(got) != 0 {
		t.Fatalf("withoutID(nil) = %v, want empty", got)
	}
}
