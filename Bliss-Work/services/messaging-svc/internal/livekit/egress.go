package livekit

// Recording, via LiveKit Egress.
//
// ── What this is ─────────────────────────────────────────────────────────────
// Egress is a separate LiveKit process that JOINS a room as a hidden
// participant, composites what it sees, and writes one file. It is asked to do
// so through the SFU's own HTTP API — the same host that serves the websocket,
// under /twirp — authenticated with a short-lived token signed by the API
// secret this package already holds.
//
// So messaging-svc never sees a frame of the recording. It says "record room
// X into key K", stores the answer, and later hears how it went over the
// webhook. That is the whole integration.
//
// ── Why hand-rolled JSON rather than the LiveKit Go SDK ──────────────────────
// The same reason token.go mints its own JWTs: the SDK brings protobuf, gRPC
// and a large transitive tree to express two POSTs and one signature check.
// LiveKit's Twirp endpoints accept protojson, and protojson accepts the proto
// field names used below.
//
// ── The int64-as-string trap ─────────────────────────────────────────────────
// protojson encodes 64-bit integers as STRINGS ("1048576", not 1048576). Every
// numeric field that comes back from LiveKit is therefore read through
// flexInt64, which takes either. Reading them as plain int64 compiles, passes a
// hand-written test, and then fails against the real server on the first
// non-empty recording.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// egressAPITimeout bounds every call to the SFU's API. Starting a recording sits
// in the path of a person pressing "Start meeting", so it must not be able to
// hang that request: a recording that fails to start is a degraded call, while a
// call that never opens is a broken one.
const egressAPITimeout = 8 * time.Second

// webhookLeeway allows for clock skew between the SFU and this service when
// checking the webhook token's validity window.
const webhookLeeway = 2 * time.Minute

// ErrEgressNotConfigured means recording is switched off, or the SFU is.
var ErrEgressNotConfigured = errors.New("livekit: recording is not configured")

// ErrRoomNotFound means the SFU does not (yet) know about this room. Matched
// via errors.Is by callers that can retry once the race resolves itself — see
// StartRoom's own doc comment for why this is a race rather than a real
// failure, and recordings.go's startRecording for the retry that uses it.
var ErrRoomNotFound = errors.New("livekit: room does not exist")

// S3Output addresses the bucket egress uploads a finished recording to. It is
// the SAME bucket the blob store uses, so the file lands where the download
// route can already find it.
type S3Output struct {
	AccessKey string
	SecretKey string
	Region    string
	// Endpoint is a full URL including the scheme, which is what LiveKit wants
	// here and what the blob store's host:port form is not.
	Endpoint string
	Bucket   string
	// ForcePathStyle is required by MinIO and by any endpoint that does not do
	// virtual-host addressing.
	ForcePathStyle bool
	// Prefix scopes every key in the bucket, exactly as the blob store's own
	// MEDIA_S3_PREFIX does. It MUST match: the blob store adds it when reading,
	// so a recording written without it is a file nothing can find.
	Prefix string
}

// Recorder asks the SFU to record a room, and hears back about it.
//
// The zero value is unconfigured and returns ErrEgressNotConfigured from every
// call, matching Minter — "no recording" is a supported deployment, not a
// broken one.
type Recorder struct {
	apiKey    string
	apiSecret string
	// apiURL is the http(s) base of the SFU's API, derived from LIVEKIT_URL
	// unless overridden: the browser dials wss://…, and this is the same host
	// spoken to over HTTP.
	apiURL string
	// s3 is set when recordings are uploaded to object storage; when it is
	// empty, fileRoot is used instead and egress writes to a shared volume.
	s3       S3Output
	fileRoot string
	client   *http.Client
}

// RecorderOptions is what NewRecorder needs beyond the SFU credentials.
type RecorderOptions struct {
	// APIURL overrides the base derived from the wss:// URL. Set it when the
	// service can reach the SFU on an internal address the browser cannot.
	APIURL string
	// S3 uploads recordings to a bucket. Leave zero to use FileRoot.
	S3 S3Output
	// FileRoot is the blob root AS THE EGRESS CONTAINER SEES IT. Egress writes
	// through its own filesystem, so this is not necessarily this service's
	// MEDIA_ROOT — it is whatever path the same volume is mounted at over
	// there.
	FileRoot string
}

// NewRecorder builds a Recorder from the SFU credentials and one output.
//
// Fails closed on a half-configured output: recording that silently writes
// nowhere is worse than recording that refuses to start, because the first is
// only discovered when someone goes looking for the file.
func NewRecorder(apiKey, apiSecret, wsURL string, o RecorderOptions) (*Recorder, error) {
	if apiKey == "" || apiSecret == "" {
		return &Recorder{}, nil
	}
	apiURL := o.APIURL
	if apiURL == "" {
		apiURL = httpBase(wsURL)
	}
	if apiURL == "" {
		return nil, errors.New("livekit: recording needs LIVEKIT_URL or LIVEKIT_API_URL")
	}
	hasS3 := o.S3.Bucket != "" || o.S3.AccessKey != "" || o.S3.Endpoint != ""
	if hasS3 && (o.S3.Bucket == "" || o.S3.AccessKey == "" || o.S3.SecretKey == "") {
		return nil, errors.New("livekit: recording to S3 needs bucket, access key and secret")
	}
	if !hasS3 && o.FileRoot == "" {
		return nil, errors.New(
			"livekit: recording needs either an S3 output or RECORDINGS_EGRESS_ROOT")
	}
	return &Recorder{
		apiKey:    apiKey,
		apiSecret: apiSecret,
		apiURL:    strings.TrimSuffix(apiURL, "/"),
		s3:        o.S3,
		fileRoot:  strings.TrimSuffix(o.FileRoot, "/"),
		client:    &http.Client{Timeout: egressAPITimeout},
	}, nil
}

// Configured reports whether recording can be started at all.
func (r *Recorder) Configured() bool { return r != nil && r.apiSecret != "" }

// Extension is the container recordings are written in. Fixed rather than
// configurable: it decides the file type asked for below, the MIME served on
// playback, and what a browser will actually play back without a plugin.
const Extension = "mp4"

// MimeType matches Extension.
const MimeType = "video/mp4"

// httpBase turns the public wss:// endpoint into the http(s) base of the API.
func httpBase(wsURL string) string {
	switch {
	case strings.HasPrefix(wsURL, "wss://"):
		return "https://" + strings.TrimPrefix(wsURL, "wss://")
	case strings.HasPrefix(wsURL, "ws://"):
		return "http://" + strings.TrimPrefix(wsURL, "ws://")
	case strings.HasPrefix(wsURL, "http://"), strings.HasPrefix(wsURL, "https://"):
		return wsURL
	default:
		return ""
	}
}

// StartRoom asks the SFU to record `room` into `key`, and returns LiveKit's
// egress id — the handle everything afterwards is keyed by.
//
// `key` is a blob key (blob.RecordingKey). Where that becomes an object name
// and where it becomes a path is the output's business, not the caller's.
//
// ── The room may not exist yet — this is a real race, not a rare one ────────
// The caller (recordings.go's startRecording) fires the instant a call is
// marked started, server-side, before the host's own browser has received
// its LiveKit token, let alone connected — and `room.auto_create` (see
// infra/livekit/livekit.yaml) only creates the room once the FIRST
// participant's realtime connection actually reaches the SFU. Egress needs an
// EXISTING room, so calling this here reliably loses that race under normal
// conditions, not merely under load — confirmed against a live deployment as
// a steady stream of 404 ErrRoomNotFound. Returning ErrRoomNotFound (rather
// than a generic error) is what lets the caller retry instead of giving up on
// the first, structurally-doomed-to-lose attempt.
func (r *Recorder) StartRoom(ctx context.Context, room, key string) (string, error) {
	if !r.Configured() {
		return "", ErrEgressNotConfigured
	}
	out := fileOutput{FileType: "MP4", Filepath: r.filepath(key)}
	if r.s3.Bucket != "" {
		out.S3 = &s3Upload{
			AccessKey:      r.s3.AccessKey,
			Secret:         r.s3.SecretKey,
			Region:         r.s3.Region,
			Endpoint:       r.s3.Endpoint,
			Bucket:         r.s3.Bucket,
			ForcePathStyle: r.s3.ForcePathStyle,
		}
	}
	req := startRoomCompositeReq{
		RoomName: room,
		// One tile per participant. "grid" is the layout that does not
		// privilege whoever happens to be speaking, which is what a meeting
		// recording is usually wanted for.
		Layout:      "grid",
		FileOutputs: []fileOutput{out},
	}
	var info egressInfo
	if err := r.call(ctx, "StartRoomCompositeEgress", room, req, &info); err != nil {
		return "", err
	}
	if info.EgressID == "" {
		return "", errors.New("livekit: egress started without an id")
	}
	return info.EgressID, nil
}

// Stop ends a running egress. Stopping one that has already finished is not an
// error worth surfacing — the file is what matters, and it is already written.
func (r *Recorder) Stop(ctx context.Context, egressID string) error {
	if !r.Configured() {
		return ErrEgressNotConfigured
	}
	var info egressInfo
	return r.call(ctx, "StopEgress", "", stopEgressReq{EgressID: egressID}, &info)
}

// filepath places a blob key inside whichever output is configured — under the
// bucket prefix, or under the volume root, so that either way it is exactly
// where blob.Store.OpenKey will look for it.
func (r *Recorder) filepath(key string) string {
	if r.s3.Bucket != "" {
		if r.s3.Prefix != "" {
			return path.Join(r.s3.Prefix, key)
		}
		return key
	}
	return r.fileRoot + "/" + key
}

func (r *Recorder) call(ctx context.Context, method, room string, body, into any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	tok, err := r.recordToken(room)
	if err != nil {
		return err
	}
	url := r.apiURL + "/twirp/livekit.Egress/" + method
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+tok)
	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("livekit: %s: %w", method, err)
	}
	defer resp.Body.Close()
	// Bounded: an error body from a misconfigured proxy can be a whole HTML
	// page, and none of it belongs in a log line.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return fmt.Errorf("livekit: %s: %w", method, err)
	}
	if resp.StatusCode != http.StatusOK {
		trimmed := strings.TrimSpace(string(raw))
		if resp.StatusCode == http.StatusNotFound && isTwirpNotFound(raw) {
			return fmt.Errorf("livekit: %s: %s: %s: %w", method, resp.Status, trimmed, ErrRoomNotFound)
		}
		return fmt.Errorf("livekit: %s: %s: %s", method, resp.Status, trimmed)
	}
	return json.Unmarshal(raw, into)
}

// isTwirpNotFound reads Twirp's {"code": "not_found", ...} error shape.
// Deliberately narrow — matched by code, not by scraping the human-readable
// msg string, which LiveKit does not promise to keep stable.
func isTwirpNotFound(body []byte) bool {
	var e struct {
		Code string `json:"code"`
	}
	return json.Unmarshal(body, &e) == nil && e.Code == "not_found"
}

// recordToken mints the credential the egress API requires: roomRecord, scoped
// to one room where there is one, and valid for barely longer than the request.
func (r *Recorder) recordToken(room string) (string, error) {
	now := time.Now().UTC()
	tok, err := jwt.NewBuilder().
		Issuer(r.apiKey).
		Subject(r.apiKey).
		IssuedAt(now).
		NotBefore(now).
		Expiration(now.Add(egressAPITimeout+time.Minute)).
		Claim("video", map[string]any{"roomRecord": true, "room": room}).
		Build()
	if err != nil {
		return "", err
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.HS256, []byte(r.apiSecret)))
	if err != nil {
		return "", err
	}
	return string(signed), nil
}

// ── Wire shapes ──────────────────────────────────────────────────────────────
// Field names are LiveKit's proto field names. protojson accepts these and
// emits lowerCamelCase; encoding/json matches field names case-insensitively on
// the way back, which covers both spellings of every field read here.

type startRoomCompositeReq struct {
	RoomName    string       `json:"room_name"`
	Layout      string       `json:"layout,omitempty"`
	FileOutputs []fileOutput `json:"file_outputs"`
}

type fileOutput struct {
	FileType string    `json:"file_type"`
	Filepath string    `json:"filepath"`
	S3       *s3Upload `json:"s3,omitempty"`
}

type s3Upload struct {
	AccessKey      string `json:"access_key"`
	Secret         string `json:"secret"`
	Region         string `json:"region,omitempty"`
	Endpoint       string `json:"endpoint,omitempty"`
	Bucket         string `json:"bucket"`
	ForcePathStyle bool   `json:"force_path_style,omitempty"`
}

type stopEgressReq struct {
	EgressID string `json:"egress_id"`
}

// egressInfo is the subset of LiveKit's EgressInfo this service acts on.
type egressInfo struct {
	EgressID string     `json:"egress_id"`
	Status   string     `json:"status"`
	Error    string     `json:"error"`
	File     *fileInfo  `json:"file"`
	Files    []fileInfo `json:"file_results"`
}

type fileInfo struct {
	Filename string    `json:"filename"`
	Size     flexInt64 `json:"size"`
	// Duration is nanoseconds, which is what LiveKit measures in.
	Duration flexInt64 `json:"duration"`
}

// flexInt64 reads a 64-bit integer written either as a JSON number or, as
// protojson does, as a string.
type flexInt64 int64

func (v *flexInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*v = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("livekit: expected an integer, got %s", string(b))
	}
	*v = flexInt64(n)
	return nil
}

// ── Webhook ──────────────────────────────────────────────────────────────────

// RecordingEvent is one finished (or failed) recording, as reported by the SFU.
type RecordingEvent struct {
	// Ended is false for events that are not about a recording finishing —
	// those are ignored rather than treated as a result.
	Ended      bool
	EgressID   string
	Filename   string
	SizeBytes  int64
	DurationMs int64
	// Error is empty on success. Non-empty means there is no file.
	Error string
}

type webhookBody struct {
	Event string      `json:"event"`
	Info  *egressInfo `json:"egressInfo"`
	// The same field under its proto name, for a sender that emits proto names
	// rather than protojson's camelCase.
	InfoSnake *egressInfo `json:"egress_info"`
}

// ParseWebhook authenticates a LiveKit webhook and extracts what it says about
// a recording.
//
// The signature check is the whole security boundary of the webhook route: it
// is a public, unauthenticated endpoint, and this is what makes a POST to it
// from anywhere else inert. The token carries a SHA-256 of the body, so a valid
// token cannot be replayed over a different payload.
func (r *Recorder) ParseWebhook(authHeader string, body []byte) (*RecordingEvent, error) {
	if !r.Configured() {
		return nil, ErrEgressNotConfigured
	}
	if err := verifyWebhook(r.apiKey, r.apiSecret, authHeader, body); err != nil {
		return nil, err
	}

	var wb webhookBody
	if err := json.Unmarshal(body, &wb); err != nil {
		return nil, fmt.Errorf("livekit: webhook body: %w", err)
	}
	info := wb.Info
	if info == nil {
		info = wb.InfoSnake
	}
	if wb.Event != "egress_ended" || info == nil {
		// Every other webhook (participant joined, room finished, an egress
		// merely starting) is not this route's business.
		return &RecordingEvent{}, nil
	}
	ev := &RecordingEvent{Ended: true, EgressID: info.EgressID, Error: info.Error}
	f := info.File
	if f == nil && len(info.Files) > 0 {
		f = &info.Files[0]
	}
	if f != nil {
		ev.Filename = f.Filename
		ev.SizeBytes = int64(f.Size)
		ev.DurationMs = int64(f.Duration) / int64(time.Millisecond)
	}
	// A completed egress with no file is a failure whatever the status says:
	// there is nothing to play.
	if ev.Error == "" && (f == nil || f.Size == 0) {
		ev.Error = "egress produced no file"
	}
	if info.Status == "EGRESS_FAILED" || info.Status == "EGRESS_ABORTED" {
		if ev.Error == "" {
			ev.Error = strings.ToLower(info.Status)
		}
	}
	return ev, nil
}

// verifyWebhook authenticates a LiveKit webhook against one API key pair.
//
// This IS the security boundary of the webhook route: the endpoint is public
// and unauthenticated in the JWT sense, because the sender is the SFU and it
// holds no BlissWork account. The token is signed with the API secret and
// carries a SHA-256 of the body, so a valid token cannot be replayed over a
// different payload.
//
// Shared by the two things that read that one route — a finished recording
// (Recorder.ParseWebhook) and a room's lifecycle (Minter.ParseRoomWebhook) —
// so the check cannot drift into being stricter on one than the other. They are
// separate types because they are configured separately: an SFU with no egress
// is an ordinary deployment, and its room events must still be believed.
func verifyWebhook(apiKey, apiSecret, authHeader string, body []byte) error {
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(authHeader), "Bearer"))
	if raw == "" {
		return errors.New("livekit: webhook is not signed")
	}
	tok, err := jwt.Parse([]byte(raw),
		jwt.WithKey(jwa.HS256, []byte(apiSecret)),
		jwt.WithIssuer(apiKey),
		jwt.WithAcceptableSkew(webhookLeeway),
	)
	if err != nil {
		return fmt.Errorf("livekit: webhook token: %w", err)
	}
	sum, _ := tok.Get("sha256")
	want, _ := sum.(string)
	if want == "" {
		return errors.New("livekit: webhook token carries no body hash")
	}
	got := sha256.Sum256(body)
	// Constant time, and over the decoded digest rather than its encoding, so
	// padding or encoding differences cannot be probed.
	wantRaw, err := decodeB64(want)
	if err != nil || !hmac.Equal(wantRaw, got[:]) {
		return errors.New("livekit: webhook body does not match its signature")
	}
	return nil
}

// decodeB64 accepts either base64 alphabet, padded or not — the encoding of the
// hash is not part of the contract worth being strict about.
func decodeB64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("livekit: undecodable hash")
}
