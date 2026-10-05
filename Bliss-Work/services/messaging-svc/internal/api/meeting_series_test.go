package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/task-board/messaging-svc/internal/recurrence"
	"github.com/task-board/messaging-svc/internal/store"
)

// The request boundary for repeating meetings and channel-addressed meetings.
// Nothing here needs a database: everything below is decided before a
// transaction is opened, which is exactly what makes it the right place to be
// strict.

func newIDs(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = uuid.NewString()
	}
	return out
}

func meetingReq(t *testing.T, body string) scheduleMeetingReq {
	t.Helper()
	var req scheduleMeetingReq
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return req
}

func TestParseIDListAcceptsAndCanonicalises(t *testing.T) {
	id := uuid.New()
	got, msg := parseIDList([]string{strings.ToUpper(id.String())}, 5, "invitee")
	if msg != "" || len(got) != 1 || got[0] != id.String() {
		t.Fatalf("got %v, %q; want the lowercase form", got, msg)
	}
	if got, msg := parseIDList(nil, 5, "invitee"); msg != "" || got == nil {
		t.Errorf("an empty list must be valid and non-nil, got %v, %q", got, msg)
	}
}

func TestParseIDListRefusesWhatItCannotUse(t *testing.T) {
	dup := uuid.NewString()
	cases := []struct {
		name string
		ids  []string
		max  int
		want string
	}{
		{"too many", newIDs(4), 3, "too many invitees"},
		{"malformed", []string{"nope"}, 3, "invalid invitee id"},
		{"duplicate", []string{dup, dup}, 3, "duplicate invitee"},
		// The same person in another spelling is still the same person.
		{"duplicate in another case", []string{dup, strings.ToUpper(dup)}, 3, "duplicate invitee"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, msg := parseIDList(c.ids, c.max, "invitee"); msg != c.want {
				t.Errorf("message = %q, want %q", msg, c.want)
			}
		})
	}
	// The cap is inclusive.
	if _, msg := parseIDList(newIDs(3), 3, "invitee"); msg != "" {
		t.Errorf("a list at the cap was refused: %q", msg)
	}
}

func futureSchedule(t *testing.T) schedule {
	t.Helper()
	at := time.Now().UTC().Add(48 * time.Hour)
	return schedule{At: &at}
}

// A plain one-off — the shape every existing client sends — passes through with
// no recurrence and no channels, exactly as before.
func TestMeetingOptionsForAPlainMeetingAreEmpty(t *testing.T) {
	req := meetingReq(t, `{"title":"Standup"}`)
	opts, msg := meetingOptions(req, schedule{})
	if msg != "" || opts.Recurrence != nil || len(opts.ChannelIDs) != 0 {
		t.Fatalf("opts = %+v, msg = %q", opts, msg)
	}
}

func TestMeetingOptionsCarryChannelsAndTheRule(t *testing.T) {
	ch := newIDs(2)
	body := fmt.Sprintf(`{"channelIds":[%q,%q],"recurrence":{
		"frequency":"WEEKLY","interval":2,"weekdays":[1,3],
		"endCondition":"AFTER_OCCURRENCES","occurrenceCount":6,"timeZone":"Europe/Berlin"}}`, ch[0], ch[1])
	opts, msg := meetingOptions(meetingReq(t, body), futureSchedule(t))
	if msg != "" {
		t.Fatalf("refused a valid request: %q", msg)
	}
	if len(opts.ChannelIDs) != 2 || opts.ChannelIDs[0] != ch[0] {
		t.Errorf("channels = %v", opts.ChannelIDs)
	}
	r := opts.Recurrence
	if r == nil || r.TimeZone != "Europe/Berlin" || r.Rule.Interval != 2 ||
		r.Rule.Frequency != recurrence.Weekly || len(r.Rule.Weekdays) != 2 ||
		r.Rule.EndCondition != recurrence.EndAfterCount || r.Rule.OccurrenceCount != 6 {
		t.Errorf("recurrence = %+v", r)
	}
}

func TestMeetingOptionsRefuseBadInput(t *testing.T) {
	dup := uuid.NewString()
	rule := func(extra string) string {
		return `{"recurrence":{"timeZone":"UTC","endCondition":"NO_END",` + extra + `}}`
	}
	cases := []struct {
		name string
		body string
		sc   schedule
		want string
	}{
		{"duplicate channel", fmt.Sprintf(`{"channelIds":[%q,%q]}`, dup, dup), schedule{}, "duplicate channel"},
		{"malformed channel", `{"channelIds":["x"]}`, schedule{}, "invalid channel id"},
		{"too many channels", fmt.Sprintf(`{"channelIds":%s}`, mustJSON(newIDs(store.MaxMeetingChannels+1))), schedule{}, "too many channels"},
		{"repeat with no start time", rule(`"frequency":"DAILY","interval":1`), schedule{}, "needs a start time"},
		{"weekly with no weekday", rule(`"frequency":"WEEKLY","interval":1`), futureSchedule(t), "at least one weekday"},
		{"interval zero", rule(`"frequency":"DAILY","interval":0`), futureSchedule(t), "interval"},
		{"interval too large", rule(`"frequency":"DAILY","interval":100`), futureSchedule(t), "interval"},
		{"no zone", `{"recurrence":{"frequency":"DAILY","interval":1,"endCondition":"NO_END"}}`, futureSchedule(t), "timeZone"},
		{"end date before the start", `{"recurrence":{"frequency":"DAILY","interval":1,"timeZone":"UTC","endCondition":"ON_DATE","endDate":"2001-01-01"}}`, futureSchedule(t), "before the meeting"},
		{"zero occurrences", `{"recurrence":{"frequency":"DAILY","interval":1,"timeZone":"UTC","endCondition":"AFTER_OCCURRENCES","occurrenceCount":0}}`, futureSchedule(t), "occurrenceCount"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, msg := meetingOptions(meetingReq(t, c.body), c.sc)
			if msg == "" || !strings.Contains(msg, c.want) {
				t.Errorf("message = %q, want it to mention %q", msg, c.want)
			}
		})
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestSeriesPatchRequiresSomethingToChange(t *testing.T) {
	if _, msg := seriesPatch(updateSeriesReq{}); msg != "nothing to change" {
		t.Errorf("message = %q", msg)
	}
}

func TestSeriesPatchLeavesOmittedFieldsAlone(t *testing.T) {
	title := "  Retro  "
	p, msg := seriesPatch(updateSeriesReq{Title: &title})
	if msg != "" {
		t.Fatalf("refused: %q", msg)
	}
	if p.Title == nil || *p.Title != "Retro" {
		t.Errorf("title = %v, want it trimmed", p.Title)
	}
	if p.InviteeIDs != nil || p.ChannelIDs != nil || p.Recurrence != nil {
		t.Errorf("a field the request never named was set: %+v", p)
	}
}

// An explicitly EMPTY list is a real edit — "remove everyone I had picked" — and
// must not be mistaken for the field being absent.
func TestSeriesPatchTreatsAnEmptyListAsAnEdit(t *testing.T) {
	empty := []string{}
	p, msg := seriesPatch(updateSeriesReq{InviteeIDs: &empty, ChannelIDs: &empty})
	if msg != "" {
		t.Fatalf("refused: %q", msg)
	}
	if p.InviteeIDs == nil || p.ChannelIDs == nil {
		t.Fatalf("an empty list was dropped: %+v", p)
	}
}

func TestSeriesPatchValidatesItsLists(t *testing.T) {
	dup := uuid.NewString()
	ids := []string{dup, dup}
	if _, msg := seriesPatch(updateSeriesReq{InviteeIDs: &ids}); msg != "duplicate invitee" {
		t.Errorf("invitees: %q", msg)
	}
	if _, msg := seriesPatch(updateSeriesReq{ChannelIDs: &ids}); msg != "duplicate channel" {
		t.Errorf("channels: %q", msg)
	}
	long := newIDs(maxMeetingInvitees + 1)
	if _, msg := seriesPatch(updateSeriesReq{InviteeIDs: &long}); msg != "too many invitees" {
		t.Errorf("cap: %q", msg)
	}
}

// Every failure the new paths can produce has to reach the client as something it
// can act on. Falling through to the default would be a 500 "internal error" for
// a request that was simply wrong.
func TestNewStoreErrorsMapToClientErrors(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   ErrorCode
	}{
		{"invalid recurrence", fmt.Errorf("%w: weekly recurrence needs at least one weekday", recurrence.ErrInvalid), http.StatusBadRequest, CodeValidationError},
		{"roster too large", store.ErrMeetingTooLarge, http.StatusBadRequest, CodeValidationError},
		{"series cancelled", store.ErrSeriesCancelled, http.StatusConflict, CodeConflict},
		{"too many series", store.ErrTooManySeries, http.StatusConflict, CodeConflict},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, code, msg := mapStoreError(c.err)
			if status != c.wantStatus || code != c.wantCode {
				t.Errorf("got %d/%s, want %d/%s", status, code, c.wantStatus, c.wantCode)
			}
			if msg == "" || msg == "internal error" {
				t.Errorf("message %q tells the client nothing", msg)
			}
		})
	}
	// The rule's own message is what the client shows.
	_, _, msg := mapStoreError(fmt.Errorf("%w: interval must be between 1 and 99", recurrence.ErrInvalid))
	if !strings.Contains(msg, "interval must be between 1 and 99") {
		t.Errorf("message %q lost the specific reason", msg)
	}
}

// The series routes must sit under the authenticated, body-capped /api/v1 group.
// (The body-cap inventory in routes_test.go independently proves PATCH and DELETE
// are capped; this proves all three exist where the client will call them.)
func TestSeriesRoutesAreRegistered(t *testing.T) {
	r, ok := testRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	want := map[string]bool{
		"GET /api/v1/meeting-series/{id}":    false,
		"PATCH /api/v1/meeting-series/{id}":  false,
		"DELETE /api/v1/meeting-series/{id}": false,
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
			t.Errorf("%s is not registered", route)
		}
	}
}
