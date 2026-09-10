package api

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/task-board/messaging-svc/internal/livekit"
	"github.com/task-board/messaging-svc/internal/metrics"
	"github.com/task-board/messaging-svc/internal/store"
)

// A deployment that does not run LiveKit Egress is a SUPPORTED configuration,
// not a fault. Reporting it as a 500 "internal error" told the operator their
// server was broken and left the UI with nothing to say beyond "couldn't change
// the recording" — the one thing a user pressing Record cannot act on.
//
// These two errors sit next to each other in the table and are easy to add one
// of and forget the other, which is exactly what happened: calling had a case,
// recording did not, and recording fell through to the default.
func TestNotConfiguredErrorsAreServiceUnavailableNotInternal(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		wantMsg string
	}{
		{"recording", livekit.ErrEgressNotConfigured, "recording is not enabled on this deployment"},
		{"calling", livekit.ErrNotConfigured, "calling is not configured on this deployment"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, code, msg := mapStoreError(tc.err)

			if status != http.StatusServiceUnavailable {
				t.Errorf("status = %d, want %d", status, http.StatusServiceUnavailable)
			}
			// The code is what clients switch on. A 503 carrying internal_error
			// is self-contradictory and makes the envelope unusable.
			if code != CodeServiceUnavailable {
				t.Errorf("code = %q, want %q", code, CodeServiceUnavailable)
			}
			if msg != tc.wantMsg {
				t.Errorf("message = %q, want %q", msg, tc.wantMsg)
			}
		})
	}
}

// Losing the race to record a call is a 409, not the same generic 503 as an
// actual SFU failure — a client cannot retry its way out of "somebody else
// already started this", and telling them to would be the wrong advice.
func TestAlreadyRecordingIsConflictNotServiceUnavailable(t *testing.T) {
	status, code, msg := mapStoreError(store.ErrAlreadyRecording)

	if status != http.StatusConflict {
		t.Errorf("status = %d, want %d", status, http.StatusConflict)
	}
	if code != CodeConflict {
		t.Errorf("code = %q, want %q", code, CodeConflict)
	}
	if msg != "recording already in progress" {
		t.Errorf("message = %q, want %q", msg, "recording already in progress")
	}
	// Must stay distinguishable from an actual SFU outage.
	if status == http.StatusServiceUnavailable {
		t.Error("ErrAlreadyRecording must not map to the same status as livekit.ErrEgressNotConfigured")
	}
}

// The mapping must survive wrapping: handlers add context as the error travels
// up, and a table matching on equality rather than errors.Is would quietly
// start returning 500s again the first time someone wrapped one.
func TestNotConfiguredSurvivesWrapping(t *testing.T) {
	wrapped := fmt.Errorf("start recording: %w", livekit.ErrEgressNotConfigured)

	status, code, _ := mapStoreError(wrapped)

	if status != http.StatusServiceUnavailable || code != CodeServiceUnavailable {
		t.Errorf("wrapped error mapped to (%d, %q), want (503, %q)",
			status, code, CodeServiceUnavailable)
	}
}

// The default is the safety net for genuinely unknown failures, and it must stay
// a 500 — turning everything into a 503 would tell clients to retry bugs.
func TestUnknownErrorStaysInternal(t *testing.T) {
	status, code, _ := mapStoreError(errors.New("something nobody has seen before"))

	if status != http.StatusInternalServerError || code != CodeInternalError {
		t.Errorf("unknown error mapped to (%d, %q), want (500, %q)",
			status, code, CodeInternalError)
	}
}

// callFailReason feeds messaging_call_failed_total's "reason" label, which
// Prometheus/alerting treats as a fixed, bounded set — every store/livekit
// error callToken can actually return needs a stable home in that taxonomy,
// and an error that fell through to server_error unnoticed would silently
// misclassify every failure of that kind on every dashboard built on it.
func TestCallFailReasonClassifiesEveryKnownCallError(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"forbidden", store.ErrForbidden, metrics.FailReasonPermissionDenied},
		{"call ended", store.ErrCallEnded, metrics.FailReasonCallUnavailable},
		{"call not started", store.ErrCallNotStarted, metrics.FailReasonCallUnavailable},
		{"livekit not configured", livekit.ErrNotConfigured, metrics.FailReasonLiveKitConnection},
		{"wrapped forbidden", fmt.Errorf("authorize: %w", store.ErrForbidden), metrics.FailReasonPermissionDenied},
		{"unknown", errors.New("something nobody has seen before"), metrics.FailReasonServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := callFailReason(tc.err); got != tc.want {
				t.Errorf("callFailReason(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}
