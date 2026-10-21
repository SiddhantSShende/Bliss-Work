package server

import "testing"

// TestIsAllowedOrigin covers the exact-match Origin policy shared by the
// CORS middleware and the WS upgrade handler (handleWS), including the
// classic suffix/prefix/character-confusion bypass attempts the policy is
// specifically designed to reject.
func TestIsAllowedOrigin(t *testing.T) {
	prodCfg := Config{WebOrigin: "https://app.example.com"}
	devCfg := Config{WebOrigin: "http://localhost:5173"}

	cases := []struct {
		name string
		cfg  Config
		in   string
		want bool
	}{
		{"exact prod origin allowed", prodCfg, "https://app.example.com", true},
		{"wrong scheme rejected", prodCfg, "http://app.example.com", false},
		{"different host rejected", prodCfg, "https://evil.com", false},
		{"suffix-confusion bypass rejected", prodCfg, "https://evil-app.example.com", false},
		{"prefix-confusion bypass rejected", prodCfg, "https://app.example.com.evil.com", false},
		{"char-class confusion bypass rejected", prodCfg, "https://appXexample.com", false},
		{"different port rejected", prodCfg, "https://app.example.com:8443", false},
		{"empty origin rejected (fail closed)", prodCfg, "", false},
		{"malformed origin rejected", prodCfg, "not a url", false},
		{"origin with userinfo rejected", prodCfg, "https://user:pass@app.example.com", false},
		{"origin with path rejected", prodCfg, "https://app.example.com/path", false},
		{"localhost rejected in prod", prodCfg, "http://localhost:5173", false},
		{"electron file origin allowed in prod", prodCfg, "file:///index.html", true},
		{"electron app origin allowed in prod", prodCfg, "app://desktop", true},
		{"electron null origin allowed in prod", prodCfg, "null", true},
		{"electron null origin case-insensitive", prodCfg, "NULL", true},
		{"electron origin spoof must still anchor on file/app/null exactly", prodCfg, "https://file://evil.com", false},

		{"dev localhost allowed", devCfg, "http://localhost:5173", true},
		{"dev 127.0.0.1 allowed", devCfg, "http://127.0.0.1:5173", true},
		{"dev different remote host still rejected", devCfg, "https://evil.com", false},
		{"dev electron carve-out still applies", devCfg, "null", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isAllowedOrigin(tc.cfg, tc.in)
			if got != tc.want {
				t.Errorf("isAllowedOrigin(%+v, %q) = %v, want %v", tc.cfg, tc.in, got, tc.want)
			}
		})
	}
}
