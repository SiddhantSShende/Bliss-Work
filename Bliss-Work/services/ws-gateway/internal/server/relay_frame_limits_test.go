package server

// Frames relayed to ANOTHER user must not carry attacker-sized fields.
//
// rtc.*, typing and call.* frames go straight from one socket to another. Only
// `type`, `state` and the target were checked, so `conversationId`, `offerId`,
// `callId`, `reason`, `media` and `candidate` could each hold up to the websocket
// read limit (32 KiB) and were relayed verbatim: one connection sending "typing"
// frames with a 30 KB conversationId put ~6 MB/s on a victim's socket (200 frames/s
// is the per-connection cap), enough to fill the victim's 64-slot send buffer, get
// it shed, and knock it off again after every reconnect.
//
// Drives handleClientFrame against a real hub and signal dispatcher. Only Redis
// presence and messaging-svc's block list are stood in for.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/signal"
)

type everyoneOnline struct{}

func (everyoneOnline) IsOnlineInOrg(context.Context, string, string) (bool, error) { return true, nil }

type noBlocks struct{}

func (noBlocks) IsBlocked(context.Context, string, string, string) (bool, error) { return false, nil }

type relayRig struct {
	srv      *Server
	attacker *hub.Conn
	sess     *session
	victim   *hub.Conn
	victimID string
}

func newRelayRig(t *testing.T) *relayRig {
	t.Helper()
	h := hub.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := &Server{hub: h, signal: signal.New(h, everyoneOnline{}, noBlocks{}, nil, log), log: log}

	orgID, attackerID, victimID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	sess := &session{}
	sess.claims.Store(&auth.Claims{UserID: attackerID, OrgID: orgID, Username: "mallory"})
	attacker := hub.NewConn(attackerID, uuid.NewString(), "")
	victim := hub.NewConn(victimID, uuid.NewString(), "")
	if !h.Add(victim, 0, 0) {
		t.Fatal("register victim")
	}
	return &relayRig{srv: srv, attacker: attacker, sess: sess, victim: victim, victimID: victimID}
}

func (r *relayRig) send(t *testing.T, frame map[string]any) {
	t.Helper()
	frame["toUserId"] = r.victimID
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	r.srv.handleClientFrame(context.Background(), r.attacker, r.sess, raw)
}

// relayed returns the frames the victim was sent so far.
func (r *relayRig) relayed() []map[string]any {
	var out []map[string]any
	for {
		select {
		case raw := <-r.victim.Send:
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err == nil {
				out = append(out, m)
			}
		default:
			return out
		}
	}
}

func TestRelay_LegitimateFramesStillArrive(t *testing.T) {
	r := newRelayRig(t)
	id := uuid.NewString()

	r.send(t, map[string]any{"type": "typing", "conversationId": id, "state": "start"})
	r.send(t, map[string]any{"type": "rtc.offer", "offerId": id, "sdp": strings.Repeat("v=0\r\n", 1500)})
	r.send(t, map[string]any{"type": "rtc.ice", "offerId": id, "candidate": "candidate:842163049 1 udp 1677729535 203.0.113.7 46154 typ srflx raddr 10.0.0.2 rport 46154 generation 0 ufrag abcd network-cost 999"})
	r.send(t, map[string]any{"type": "rtc.cancel", "offerId": id, "reason": "receiver_declined"})
	r.send(t, map[string]any{"type": "call.invite", "callId": id, "media": "video"})

	if got := len(r.relayed()); got != 5 {
		t.Fatalf("victim received %d of 5 legitimate frames", got)
	}
}

func TestRelay_OversizedFieldsAreNotForwarded(t *testing.T) {
	huge := strings.Repeat("A", 30_000)
	id := uuid.NewString()
	cases := map[string]map[string]any{
		"typing conversationId": {"type": "typing", "conversationId": huge, "state": "start"},
		"rtc offerId":           {"type": "rtc.ice", "offerId": huge, "candidate": "candidate:1"},
		"rtc candidate":         {"type": "rtc.ice", "offerId": id, "candidate": huge},
		"rtc reason":            {"type": "rtc.cancel", "offerId": id, "reason": huge},
		"call callId":           {"type": "call.invite", "callId": huge, "media": "video"},
		"call media":            {"type": "call.invite", "callId": id, "media": huge},
	}
	for name, frame := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRelayRig(t)

			r.send(t, frame)

			if got := r.relayed(); len(got) != 0 {
				raw, _ := json.Marshal(got)
				t.Fatalf("an oversized field was relayed to the victim (%d bytes)", len(raw))
			}
		})
	}
}

func TestRelay_OversizedFramesStillCountAgainstTheSendersBudget(t *testing.T) {
	r := newRelayRig(t)
	huge := strings.Repeat("A", 30_000)

	for i := 0; i < signal.MaxRatePerSec+50; i++ {
		r.send(t, map[string]any{"type": "typing", "conversationId": huge, "state": "start"})
	}
	// The budget is exhausted by the rejected frames, so even a valid one now waits.
	r.send(t, map[string]any{"type": "typing", "conversationId": uuid.NewString(), "state": "start"})

	if got := r.relayed(); len(got) != 0 {
		t.Fatalf("victim received %d frames from a sender that had exhausted its budget", len(got))
	}
}
