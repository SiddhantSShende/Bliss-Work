package config

import "testing"

// The mode switch decides whether a gateway consumes the entire Kafka stream or
// none of it, so an unrecognised value must not leave it in some third state.
//
// It falls back to broadcast rather than failing to start — the opposite of the
// choice made for Kafka security, and deliberately: a typo here should leave
// the gateway serving traffic exactly as it always has. The resolved mode is
// logged at boot, so a misspelling is visible rather than silent.
func TestFanoutModeFallsBackToBroadcast(t *testing.T) {
	cases := map[string]string{
		"":            FanoutBroadcast,
		"broadcast":   FanoutBroadcast,
		"routed":      FanoutRouted,
		"ROUTED":      FanoutRouted,
		"  Routed  ":  FanoutRouted,
		"rout3d":      FanoutBroadcast, // typo
		"route":       FanoutBroadcast, // near miss
		"distributed": FanoutBroadcast, // plausible but wrong
	}
	for in, want := range cases {
		if got := normalizeFanoutMode(in); got != want {
			t.Errorf("normalizeFanoutMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// The advertise address is joined to a path and used as a URL. A bare host:port
// is the most natural thing to write — and is exactly what a Kubernetes
// downward-API fieldRef gives you on its own — so accepting it and supplying
// the scheme removes a whole class of "registered fine, nothing is delivered".
func TestAdvertiseAddrIsNormalizedToABaseURL(t *testing.T) {
	cases := map[string]string{
		"":                          "",
		"   ":                       "",
		"10.1.2.3:8080":             "http://10.1.2.3:8080",
		"ws-gateway:8080":           "http://ws-gateway:8080",
		"http://ws-gateway:8080":    "http://ws-gateway:8080",
		"https://gw.internal:8443":  "https://gw.internal:8443",
		"http://ws-gateway:8080/":   "http://ws-gateway:8080",
		"http://ws-gateway:8080///": "http://ws-gateway:8080",
		"  10.1.2.3:8080  ":         "http://10.1.2.3:8080",
	}
	for in, want := range cases {
		if got := normalizeAddr(in); got != want {
			t.Errorf("normalizeAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

// A trailing slash must not survive: the push path is appended directly, and
// "http://host//internal/push" is a different route from "/internal/push".
func TestAdvertiseAddrJoinsCleanlyWithThePushPath(t *testing.T) {
	const path = "/internal/push"
	for _, in := range []string{"http://gw:8080", "http://gw:8080/", "gw:8080"} {
		if got := normalizeAddr(in) + path; got != "http://gw:8080/internal/push" {
			t.Errorf("normalizeAddr(%q)+path = %q, want http://gw:8080/internal/push", in, got)
		}
	}
}
