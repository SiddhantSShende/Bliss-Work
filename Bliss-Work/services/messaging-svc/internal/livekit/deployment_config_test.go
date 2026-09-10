package livekit

// The webhook is only worth having if the SFU is actually told to send it.
//
// Every other test in this package proves that a callback which ARRIVES is read
// correctly. None of them can notice the failure that actually happened: the
// `webhook:` block lived in the rendered recording config alone, so any deploy
// that brought `livekit` up without `-f docker-compose.recording.yml` recreated
// the SFU against a config with no callbacks at all. Nothing errored. Calls kept
// connecting. `participant_left` simply never arrived, `left_at` stayed NULL for
// every closed laptop, and ExpireHostlessCalls could not match at any grace
// value — so hostless meetings ran for ever and everyone in them stayed "Busy".
//
// A Go test reaching for deployment files is unusual, and deliberate: this is
// the only place the two halves of that feature — the reader here and the sender
// there — can be checked against each other. It SKIPS rather than fails when the
// files are not reachable, so it costs nothing in a build context that has only
// this service's source.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoFile locates a path relative to the repository root, walking up from the
// package directory until it finds the marker that identifies it.
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Skipf("cannot resolve the working directory: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "docker-compose.prod.yml")); err == nil {
			p := filepath.Join(dir, rel)
			if _, err := os.Stat(p); err != nil {
				t.Skipf("%s is not present in this checkout", rel)
			}
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Skip("repository root not found; running from a source-only context")
	return ""
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// The path matters as much as the presence of the block. `/livekit/*` at the
// edge is proxied to the SFU ITSELF, so a callback sent there arrives back at
// LiveKit; messaging-svc is reached under `/api/messaging`, which Caddy strips
// before this service sees the `/livekit/webhook` route.
const webhookPath = "/api/messaging/livekit/webhook"

func TestBaseComposeConfigAsksTheSFUForRoomCallbacks(t *testing.T) {
	cfg := mustRead(t, repoFile(t, "infra/livekit/livekit.yaml"))

	// A LIVE block, not the commented-out one this file used to carry.
	if !strings.Contains(cfg, "\nwebhook:\n") {
		t.Fatal("infra/livekit/livekit.yaml has no active `webhook:` block.\n\n" +
			"Without it the SFU reports nothing, participant_left never reaches " +
			"messaging-svc, and a meeting whose organiser closed their laptop stays " +
			"LIVE with everyone in it marked Busy. This is the BASE config: it must " +
			"not depend on the recording overlay, which is how the block went missing.")
	}
	if !strings.Contains(cfg, webhookPath) {
		t.Errorf("the webhook url does not end in %s — check it is not being posted "+
			"back to the SFU via the edge's /livekit/* route", webhookPath)
	}
	// The signing key is a credential and must never be committed. It reaches
	// the SFU as LIVEKIT_WEBHOOK_API_KEY instead.
	for _, line := range strings.Split(cfg, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "api_key:") {
			t.Error("infra/livekit/livekit.yaml sets webhook.api_key. That is a credential " +
				"and this file is in the repository — pass it as LIVEKIT_WEBHOOK_API_KEY.")
		}
	}

	compose := mustRead(t, repoFile(t, "docker-compose.prod.yml"))
	if !strings.Contains(compose, "LIVEKIT_WEBHOOK_API_KEY") {
		t.Error("docker-compose.prod.yml does not pass LIVEKIT_WEBHOOK_API_KEY to livekit.\n\n" +
			"With webhook.urls set and no api_key resolved, livekit-server exits at " +
			"startup with \"api_key is required to use webhooks\".")
	}
}

func TestHelmChartAsksTheSFUForRoomCallbacks(t *testing.T) {
	values := mustRead(t, repoFile(t, "deploy/helm/taskboard/values.yaml"))
	if !strings.Contains(values, "/livekit/webhook") {
		t.Error("deploy/helm/taskboard/values.yaml configures no livekit.webhook.urls, " +
			"so a Kubernetes install gets an SFU that never reports a departure.")
	}

	tpl := mustRead(t, repoFile(t, "deploy/helm/taskboard/templates/livekit.yaml"))
	if !strings.Contains(tpl, "webhook:") {
		t.Error("the livekit ConfigMap renders no webhook: block")
	}
	if !strings.Contains(tpl, "LIVEKIT_WEBHOOK_API_KEY") {
		t.Error("the livekit Deployment does not inject LIVEKIT_WEBHOOK_API_KEY")
	}
	// From the Secret. A ConfigMap is not a secret store, and this is the same
	// api key messaging-svc holds.
	if strings.Contains(tpl, "LIVEKIT_WEBHOOK_API_KEY") &&
		!strings.Contains(tpl, "key: LIVEKIT_API_KEY") {
		t.Error("LIVEKIT_WEBHOOK_API_KEY is not taken from the LIVEKIT_API_KEY secret key")
	}
}
