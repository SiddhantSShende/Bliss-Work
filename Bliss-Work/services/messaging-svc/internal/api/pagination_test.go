package api

import (
	"net/http/httptest"
	"testing"
)

// pageParams is the only thing standing between a client-supplied ?limit= and
// the database, so its clamping behaviour is load-bearing rather than cosmetic:
// the conversation and channel history endpoints had no limit at all before,
// and an uncapped limit here would put that back.
func TestPageParams(t *testing.T) {
	cases := []struct {
		name          string
		query         string
		def, max      int
		wantBeforeSeq int64
		wantLimit     int
	}{
		{"no params uses the default and starts from newest", "", 50, 100, 0, 50},
		{"explicit cursor and limit are honoured", "?beforeSeq=900&limit=20", 50, 100, 900, 20},
		{"limit above the cap falls back to the default", "?limit=5000", 50, 100, 0, 50},
		{"limit exactly at the cap is allowed", "?limit=100", 50, 100, 0, 100},
		{"zero limit falls back to the default", "?limit=0", 50, 100, 0, 50},
		{"negative limit falls back to the default", "?limit=-10", 50, 100, 0, 50},
		{"non-numeric limit falls back to the default", "?limit=all", 50, 100, 0, 50},
		{"negative cursor is ignored, not clamped to a real seq", "?beforeSeq=-5", 50, 100, 0, 50},
		{"non-numeric cursor is ignored", "?beforeSeq=latest", 50, 100, 0, 50},
		{"zero cursor means newest", "?beforeSeq=0", 50, 100, 0, 50},
		{"thread endpoint keeps its own smaller defaults", "", 12, 50, 0, 12},
		{"thread endpoint caps at its own max", "?limit=80", 12, 50, 0, 12},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/v1/conversations/x/messages"+tc.query, nil)
			gotBefore, gotLimit := pageParams(r, tc.def, tc.max)
			if gotBefore != tc.wantBeforeSeq {
				t.Errorf("beforeSeq = %d, want %d", gotBefore, tc.wantBeforeSeq)
			}
			if gotLimit != tc.wantLimit {
				t.Errorf("limit = %d, want %d", gotLimit, tc.wantLimit)
			}
		})
	}
}

// A limit can never exceed the cap regardless of what arrives on the wire.
func TestPageParamsNeverExceedsMax(t *testing.T) {
	for _, q := range []string{
		"?limit=101", "?limit=999999", "?limit=9223372036854775807",
		"?limit=1e9", "?limit=+100000", "?limit=0x64",
	} {
		r := httptest.NewRequest("GET", "/x"+q, nil)
		_, limit := pageParams(r, DefaultMessagePageSize, MaxMessagePageSize)
		if limit > MaxMessagePageSize {
			t.Errorf("%s produced limit %d, above the cap %d", q, limit, MaxMessagePageSize)
		}
	}
}
