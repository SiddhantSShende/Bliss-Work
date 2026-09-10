package api

import (
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/task-board/messaging-svc/internal/config"
)

// parseCoord is the SSRF boundary for the static map proxy: everything that
// reaches the upstream URL is a re-formatted number that passed through here, so
// no user-supplied string is ever interpolated into an outbound request.
func TestParseCoord(t *testing.T) {
	valid := []struct {
		raw   string
		limit float64
	}{
		{"0", 90}, {"12.9716", 90}, {"-89.999999", 90}, {"90", 90}, {"-90", 90},
		{"77.5946", 180}, {"180", 180}, {"-180", 180},
	}
	for _, c := range valid {
		if _, ok := parseCoord(c.raw, c.limit); !ok {
			t.Errorf("parseCoord(%q, %v) rejected a valid coordinate", c.raw, c.limit)
		}
	}

	invalid := []struct {
		raw   string
		limit float64
	}{
		{"", 90},
		{"91", 90}, {"-91", 90}, {"181", 180}, {"-181", 180},
		{"abc", 90},
		{"NaN", 90}, // would format into the URL as "NaN"
		{"Inf", 90}, // and as "+Inf"
		{"-Inf", 90},
		{"1e400", 90}, // overflows to +Inf
		{"12.34,56", 90},
		{"12 OR 1=1", 90},
		{"../../etc", 90},
		{"0x1F", 90},
	}
	for _, c := range invalid {
		if v, ok := parseCoord(c.raw, c.limit); ok {
			t.Errorf("parseCoord(%q, %v) accepted an invalid coordinate (got %v)", c.raw, c.limit, v)
		}
	}
}

// A rejected coordinate must never reach the URL builder, and an accepted one
// must round-trip as a plain decimal — no exponents, no signs beyond a leading
// minus, nothing that could alter the URL's structure.
func TestParseCoord_FormatsAsPlainDecimal(t *testing.T) {
	for _, raw := range []string{"12.97160000", "1e2", "-0.0000001", "45"} {
		v, ok := parseCoord(raw, 180)
		if !ok {
			continue
		}
		s := strconv.FormatFloat(v, 'f', 5, 64)
		if strings.ContainsAny(s, "eE+&?/#") {
			t.Errorf("parseCoord(%q) formatted as %q, which is not URL-inert", raw, s)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			t.Errorf("parseCoord(%q) yielded a non-finite value", raw)
		}
	}
}

func TestStaticMapURL_KnownProviders(t *testing.T) {
	for _, provider := range []string{"geoapify", "", "maptiler"} {
		s := &Server{mapsCfg: config.MapsConfig{Provider: provider, APIKey: "test-key"}}
		got, err := s.staticMapURL("12.97160", "77.59460", 15)
		if err != nil {
			t.Fatalf("provider %q: %v", provider, err)
		}
		if !strings.HasPrefix(got, "https://") {
			t.Errorf("provider %q built a non-https URL: %s", provider, got)
		}
		if strings.ContainsAny(got, " \r\n") {
			t.Errorf("provider %q built a URL with whitespace: %q", provider, got)
		}
		if !strings.Contains(got, "test-key") {
			t.Errorf("provider %q dropped the API key", provider)
		}
	}
}

// An unknown provider must fail rather than silently building a garbage URL —
// which the handler then reports as 204, degrading to the coordinates card.
func TestStaticMapURL_UnknownProviderErrors(t *testing.T) {
	s := &Server{mapsCfg: config.MapsConfig{Provider: "totally-made-up", APIKey: "k"}}
	if _, err := s.staticMapURL("1.0", "2.0", 15); err == nil {
		t.Fatal("unknown provider did not error")
	}
}
