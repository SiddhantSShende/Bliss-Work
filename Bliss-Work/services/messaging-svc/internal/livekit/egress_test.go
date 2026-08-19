package livekit

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// testSecret is shared with token_test.go, which declares it.
const testKey = "APIkey123"

func newTestRecorder(t *testing.T, url string, o RecorderOptions) *Recorder {
	t.Helper()
	if o.S3.Bucket == "" && o.FileRoot == "" {
		o.FileRoot = "/media"
	}
	o.APIURL = url
	r, err := NewRecorder(testKey, testSecret, "wss://sfu.test", o)
	if err != nil {
		t.Fatalf("NewRecorder: %v", err)
	}
	return r
}

func TestStartRoomAsksForOneFileAndReturnsTheEgressID(t *testing.T) {
	var got struct {
		RoomName    string `json:"room_name"`
		Layout      string `json:"layout"`
		FileOutputs []struct {
			FileType string `json:"file_type"`
			Filepath string `json:"filepath"`
			S3       *struct {
				Bucket string `json:"bucket"`
			} `json:"s3"`
		} `json:"file_outputs"`
	}
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/twirp/livekit.Egress/StartRoomCompositeEgress" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		auth = r.Header.Get("authorization")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("request body: %v", err)
		}
		_, _ = w.Write([]byte(`{"egress_id":"EG_abc","status":"EGRESS_STARTING"}`))
	}))
	defer srv.Close()

	rec := newTestRecorder(t, srv.URL, RecorderOptions{FileRoot: "/media"})
	id, err := rec.StartRoom(context.Background(), "room-1", "blobs/o/recordings/c/EG_abc.mp4")
	if err != nil {
		t.Fatalf("StartRoom: %v", err)
	}
	if id != "EG_abc" {
		t.Fatalf("egress id = %q", id)
	}
	if got.RoomName != "room-1" || got.Layout != "grid" {
		t.Fatalf("room/layout = %q/%q", got.RoomName, got.Layout)
	}
	if len(got.FileOutputs) != 1 {
		t.Fatalf("want exactly one output, got %d", len(got.FileOutputs))
	}
	// The file lands under the root the EGRESS container sees, not this one's.
	if got.FileOutputs[0].Filepath != "/media/blobs/o/recordings/c/EG_abc.mp4" {
		t.Fatalf("filepath = %q", got.FileOutputs[0].Filepath)
	}
	if got.FileOutputs[0].S3 != nil {
		t.Fatal("no bucket was configured, so no s3 upload should have been asked for")
	}

	// The API credential must actually carry the recording grant, or LiveKit
	// answers 401 and the whole feature is a log line nobody reads.
	tok, err := jwt.Parse([]byte(strings.TrimPrefix(auth, "Bearer ")),
		jwt.WithKey(jwa.HS256, []byte(testSecret)))
	if err != nil {
		t.Fatalf("api token does not verify: %v", err)
	}
	video, _ := tok.Get("video")
	grant, _ := video.(map[string]any)
	if grant["roomRecord"] != true {
		t.Fatalf("api token lacks roomRecord: %v", video)
	}
}

func TestStartRoomUploadsUnderTheSamePrefixTheBlobStoreReadsFrom(t *testing.T) {
	var got struct {
		FileOutputs []struct {
			Filepath string `json:"filepath"`
			S3       *struct {
				Bucket         string `json:"bucket"`
				Endpoint       string `json:"endpoint"`
				ForcePathStyle bool   `json:"force_path_style"`
			} `json:"s3"`
		} `json:"file_outputs"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_, _ = w.Write([]byte(`{"egress_id":"EG_1"}`))
	}))
	defer srv.Close()

	rec := newTestRecorder(t, srv.URL, RecorderOptions{S3: S3Output{
		AccessKey: "ak", SecretKey: "sk", Bucket: "media",
		Endpoint: "https://minio:9000", Prefix: "prod", ForcePathStyle: true,
	}})
	if _, err := rec.StartRoom(context.Background(), "room-1", "blobs/o/recordings/c/EG_1.mp4"); err != nil {
		t.Fatalf("StartRoom: %v", err)
	}
	out := got.FileOutputs[0]
	// Without the prefix the object lands where blob.Store.OpenKey will never
	// look for it, and the recording is lost while appearing to have worked.
	if out.Filepath != "prod/blobs/o/recordings/c/EG_1.mp4" {
		t.Fatalf("filepath = %q", out.Filepath)
	}
	if out.S3 == nil || out.S3.Bucket != "media" || !out.S3.ForcePathStyle {
		t.Fatalf("s3 output = %+v", out.S3)
	}
}

func TestStartRoomReportsAnErrorStatusRatherThanSwallowingIt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"unavailable","msg":"no egress workers"}`))
	}))
	defer srv.Close()

	rec := newTestRecorder(t, srv.URL, RecorderOptions{FileRoot: "/media"})
	_, err := rec.StartRoom(context.Background(), "room-1", "blobs/o/recordings/c/EG_1.mp4")
	if err == nil {
		t.Fatal("a 503 from the SFU must not read as a started recording")
	}
	if !strings.Contains(err.Error(), "no egress workers") {
		t.Fatalf("the SFU's reason should survive into the log: %v", err)
	}
}

func TestUnconfiguredRecorderRefusesRatherThanPanicking(t *testing.T) {
	var zero Recorder
	if zero.Configured() {
		t.Fatal("the zero Recorder must report itself unconfigured")
	}
	if _, err := zero.StartRoom(context.Background(), "r", "k"); err != ErrEgressNotConfigured {
		t.Fatalf("StartRoom on an unconfigured recorder = %v", err)
	}
	if _, err := zero.ParseWebhook("Bearer x", []byte("{}")); err != ErrEgressNotConfigured {
		t.Fatalf("ParseWebhook on an unconfigured recorder = %v", err)
	}
}

// signWebhook builds the token LiveKit sends: signed with the API secret, and
// carrying a hash of the exact body.
func signWebhook(t *testing.T, body []byte, secret string) string {
	t.Helper()
	sum := sha256.Sum256(body)
	now := time.Now()
	tok, err := jwt.NewBuilder().
		Issuer(testKey).
		IssuedAt(now).
		Expiration(now.Add(5*time.Minute)).
		Claim("sha256", base64.StdEncoding.EncodeToString(sum[:])).
		Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.HS256, []byte(secret)))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return string(signed)
}

const endedBody = `{
  "event": "egress_ended",
  "egressInfo": {
    "egress_id": "EG_abc",
    "status": "EGRESS_COMPLETE",
    "file_results": [{
      "filename": "blobs/11111111-1111-4111-8111-111111111111/recordings/22222222-2222-4222-8222-222222222222/EG_abc.mp4",
      "size": "1048576",
      "duration": "63000000000"
    }]
  }
}`

func TestParseWebhookAcceptsASignedResultAndReadsProtojsonIntegers(t *testing.T) {
	rec := newTestRecorder(t, "http://sfu.test", RecorderOptions{FileRoot: "/media"})
	body := []byte(endedBody)
	ev, err := rec.ParseWebhook(signWebhook(t, body, testSecret), body)
	if err != nil {
		t.Fatalf("ParseWebhook: %v", err)
	}
	if !ev.Ended || ev.EgressID != "EG_abc" || ev.Error != "" {
		t.Fatalf("event = %+v", ev)
	}
	// Both arrived as JSON STRINGS, which is how protojson writes 64-bit ints.
	if ev.SizeBytes != 1048576 {
		t.Fatalf("size = %d", ev.SizeBytes)
	}
	if ev.DurationMs != 63000 {
		t.Fatalf("duration = %dms, want 63000 (63s reported in nanoseconds)", ev.DurationMs)
	}
}

func TestParseWebhookRefusesAnythingItCannotAuthenticate(t *testing.T) {
	rec := newTestRecorder(t, "http://sfu.test", RecorderOptions{FileRoot: "/media"})
	body := []byte(endedBody)
	good := signWebhook(t, body, testSecret)

	cases := map[string]struct {
		auth string
		body []byte
	}{
		"no token at all": {"", body},
		"signed with another secret": {
			signWebhook(t, body, "ffffffffffffffffffffffffffffffff"), body},
		// The one that matters most: a valid token replayed over a DIFFERENT
		// body would otherwise let anyone settle any recording they liked.
		"valid token, tampered body": {good, []byte(strings.Replace(endedBody, "EG_abc", "EG_xyz", 1))},
	}
	for name, c := range cases {
		if _, err := rec.ParseWebhook(c.auth, c.body); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}

func TestParseWebhookIgnoresEventsThatAreNotAFinishedRecording(t *testing.T) {
	rec := newTestRecorder(t, "http://sfu.test", RecorderOptions{FileRoot: "/media"})
	body := []byte(`{"event":"participant_joined","room":{"name":"r"}}`)
	ev, err := rec.ParseWebhook(signWebhook(t, body, testSecret), body)
	if err != nil {
		t.Fatalf("ParseWebhook: %v", err)
	}
	if ev.Ended {
		t.Fatalf("a participant joining is not a recording result: %+v", ev)
	}
}

func TestParseWebhookTreatsAnEmptyOrFailedEgressAsAFailure(t *testing.T) {
	rec := newTestRecorder(t, "http://sfu.test", RecorderOptions{FileRoot: "/media"})

	// Reported as complete, but nothing was written. There is no recording, and
	// saying READY here would put a broken player in front of a participant.
	empty := []byte(`{"event":"egress_ended","egressInfo":{"egress_id":"EG_1","status":"EGRESS_COMPLETE"}}`)
	ev, err := rec.ParseWebhook(signWebhook(t, empty, testSecret), empty)
	if err != nil {
		t.Fatalf("ParseWebhook: %v", err)
	}
	if ev.Error == "" {
		t.Fatal("a completed egress with no file must be reported as a failure")
	}

	failed := []byte(`{"event":"egress_ended","egressInfo":` +
		`{"egress_id":"EG_2","status":"EGRESS_FAILED","error":"disk full"}}`)
	ev, err = rec.ParseWebhook(signWebhook(t, failed, testSecret), failed)
	if err != nil {
		t.Fatalf("ParseWebhook: %v", err)
	}
	if ev.Error != "disk full" {
		t.Fatalf("the SFU's own reason should survive: %q", ev.Error)
	}
}

func TestNewRecorderRefusesAHalfConfiguredOutput(t *testing.T) {
	if _, err := NewRecorder(testKey, testSecret, "wss://sfu.test", RecorderOptions{}); err == nil {
		t.Fatal("no output configured must be a boot error, not a silent no-op")
	}
	if _, err := NewRecorder(testKey, testSecret, "wss://sfu.test", RecorderOptions{
		S3: S3Output{Bucket: "media"},
	}); err == nil {
		t.Fatal("a bucket with no credentials must be a boot error")
	}
	// No SFU at all is a supported state, not an error.
	r, err := NewRecorder("", "", "", RecorderOptions{})
	if err != nil || r.Configured() {
		t.Fatalf("unconfigured = %v, %v", r, err)
	}
}

func TestHTTPBaseFollowsTheSocketURL(t *testing.T) {
	for in, want := range map[string]string{
		"wss://sfu.test/livekit": "https://sfu.test/livekit",
		"ws://localhost:7880":    "http://localhost:7880",
		"https://sfu.test":       "https://sfu.test",
		"sfu.test":               "",
	} {
		if got := httpBase(in); got != want {
			t.Fatalf("httpBase(%q) = %q, want %q", in, got, want)
		}
	}
}
