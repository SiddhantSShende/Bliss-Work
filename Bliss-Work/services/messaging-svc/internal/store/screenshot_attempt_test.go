package store

import "testing"

func TestScreenshotAttemptBody(t *testing.T) {
	cases := []struct {
		name        string
		displayName string
		username    string
		want        string
	}{
		{"prefers display name", "Jane Okafor", "j.okafor", "Jane Okafor tried to take a screenshot"},
		{"falls back to username", "", "j.okafor", "j.okafor tried to take a screenshot"},
		{"falls back to generic when projection has neither", "", "", "Someone tried to take a screenshot"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := screenshotAttemptBody(c.displayName, c.username); got != c.want {
				t.Errorf("screenshotAttemptBody(%q, %q) = %q, want %q", c.displayName, c.username, got, c.want)
			}
		})
	}
}
