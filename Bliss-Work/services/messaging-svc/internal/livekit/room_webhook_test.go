package livekit

import "testing"

// The room webhook is the ONLY thing that notices a participant who never said
// goodbye — a closed laptop, a killed tab, a dropped network. Everything else
// that clears `left_at` is a request from a browser that, in exactly these
// cases, is gone.
func TestParseRoomWebhookReadsAParticipantLeaving(t *testing.T) {
	m, err := New(testKey, testSecret, "wss://sfu.example", MinterOptions{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	body := []byte(`{"event":"participant_left",` +
		`"room":{"name":"call-1"},"participant":{"identity":"user-7"}}`)

	ev, err := m.ParseRoomWebhook("Bearer "+signWebhook(t, body, testSecret), body)
	if err != nil {
		t.Fatalf("ParseRoomWebhook: %v", err)
	}
	if ev.Event != EventParticipantLeft {
		t.Errorf("event = %q, want %q", ev.Event, EventParticipantLeft)
	}
	if ev.Room != "call-1" {
		t.Errorf("room = %q, want the call id", ev.Room)
	}
	if ev.Identity != "user-7" {
		t.Errorf("identity = %q, want the BlissWork user id", ev.Identity)
	}
}

func TestParseRoomWebhookReadsARoomFinishing(t *testing.T) {
	m, _ := New(testKey, testSecret, "wss://sfu.example", MinterOptions{})
	body := []byte(`{"event":"room_finished","room":{"name":"call-2"}}`)

	ev, err := m.ParseRoomWebhook("Bearer "+signWebhook(t, body, testSecret), body)
	if err != nil {
		t.Fatalf("ParseRoomWebhook: %v", err)
	}
	if ev.Event != EventRoomFinished || ev.Room != "call-2" {
		t.Fatalf("got %+v, want a room_finished for call-2", ev)
	}
}

// Everything else the SFU sends is somebody else's business, and must read as
// "nothing to do" rather than as an error — the route answers 200 to those, and
// a non-2xx would make the SFU retry an event we will ignore just as hard.
func TestParseRoomWebhookIgnoresEventsItDoesNotActuponAndIncompleteOnes(t *testing.T) {
	m, _ := New(testKey, testSecret, "wss://sfu.example", MinterOptions{})

	for _, body := range []string{
		`{"event":"participant_joined","room":{"name":"call-1"},"participant":{"identity":"u"}}`,
		`{"event":"room_started","room":{"name":"call-1"}}`,
		`{"event":"egress_ended","egressInfo":{"egress_id":"EG_1"}}`,
		// A participant event naming no participant, and a room event naming no
		// room: nothing to act on, and not worth a retry.
		`{"event":"participant_left","room":{"name":"call-1"}}`,
		`{"event":"room_finished"}`,
	} {
		raw := []byte(body)
		ev, err := m.ParseRoomWebhook("Bearer "+signWebhook(t, raw, testSecret), raw)
		if err != nil {
			t.Fatalf("ParseRoomWebhook(%s): %v", body, err)
		}
		if ev.Event != "" {
			t.Errorf("ParseRoomWebhook(%s) = %+v, want an ignored event", body, ev)
		}
	}
}

// The signature is the whole security boundary: the route is public because the
// sender holds no account here. A body that is not signed with the API secret
// must never be believed, whatever it claims about who left which room.
func TestParseRoomWebhookRefusesAnythingItCannotAuthenticate(t *testing.T) {
	m, _ := New(testKey, testSecret, "wss://sfu.example", MinterOptions{})
	body := []byte(`{"event":"room_finished","room":{"name":"call-1"}}`)

	cases := []struct {
		name string
		auth string
		body []byte
	}{
		{"unsigned", "", body},
		{"signed with the wrong secret", "Bearer " + signWebhook(t, body, "not-the-secret"), body},
		{
			// A valid token replayed over a DIFFERENT body. The token carries a
			// hash of the body it was minted for, which is what stops this.
			name: "a good signature over a different body",
			auth: "Bearer " + signWebhook(t, body, testSecret),
			body: []byte(`{"event":"room_finished","room":{"name":"someone-elses-call"}}`),
		},
	}
	for _, c := range cases {
		if _, err := m.ParseRoomWebhook(c.auth, c.body); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
}

// An SFU-less deployment holds no key, so it can authenticate nothing — and
// must say so rather than reading the payload anyway.
func TestParseRoomWebhookOnAnUnconfiguredMinter(t *testing.T) {
	var zero Minter
	if _, err := zero.ParseRoomWebhook("Bearer x", []byte("{}")); err != ErrNotConfigured {
		t.Fatalf("ParseRoomWebhook on an unconfigured minter = %v, want %v", err, ErrNotConfigured)
	}
}
