package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/signal"
)

const (
	pingInterval = 20 * time.Second
	pingTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
)

// session holds the mutable per-connection auth state.
type session struct {
	claims  *auth.Claims
	rtcRate signal.Limiter
}

func (s *Server) serveConn(parent context.Context, ws *websocket.Conn, claims *auth.Claims) {
	connID := uuid.NewString()
	conn := hub.NewConn(claims.UserID, connID)
	sess := &session{claims: claims}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	// Enforce per-node and per-user connection caps BEFORE registering presence.
	// On rejection, close with 1013 (Try Again Later) so a connection storm or a
	// runaway reconnect loop can't exhaust this pod's memory/goroutines.
	if !s.hub.Add(conn, s.cfg.MaxConnections, s.cfg.MaxConnsPerUser) {
		s.log.Warn("ws rejected: connection cap reached",
			"user", claims.UserID, "conn", connID, "node_total", s.hub.Count())
		_ = ws.Close(websocket.StatusTryAgainLater, "connection limit reached")
		return
	}

	// Register presence (local + redis: per-connection + org online set).
	if err := s.store.AddPresence(ctx, claims.UserID, s.nodeID, connID); err != nil {
		s.log.Error("add presence failed", "err", err)
	}
	becameOnline, err := s.store.AddOrgPresence(ctx, claims.OrgID, claims.UserID)
	if err != nil {
		s.log.Error("add org presence failed", "err", err)
	}
	// Broadcast presence.online ONLY on the absent→present transition (first
	// socket/tab), so org-mates flip the avatar live without one event per tab.
	if becameOnline && s.presence != nil {
		s.presence.Online(ctx, claims.OrgID, claims.UserID)
	}
	s.log.Info("ws connected", "user", claims.UserID, "conn", connID, "org", claims.OrgID)

	defer func() {
		conn.Close()
		s.hub.Remove(conn)
		// Use a fresh short-lived context for cleanup (parent may be done).
		cleanupCtx, cc := context.WithTimeout(context.Background(), 3*time.Second)
		defer cc()
		if err := s.store.RemovePresence(cleanupCtx, claims.UserID, s.nodeID, connID); err != nil {
			s.log.Error("remove presence failed", "err", err)
		}
		becameOffline, err := s.store.RemoveOrgPresenceIfLast(cleanupCtx, claims.OrgID, claims.UserID)
		if err != nil {
			s.log.Error("remove org presence failed", "err", err)
		}
		// Broadcast presence.offline ONLY on the present→absent transition (last
		// socket closed across all nodes).
		if becameOffline && s.presence != nil {
			s.presence.Offline(cleanupCtx, claims.OrgID, claims.UserID)
		}
		s.log.Info("ws disconnected", "user", claims.UserID, "conn", connID)
	}()

	go s.writeLoop(ctx, cancel, ws, conn)
	s.readLoop(ctx, ws, conn, sess)
}

// writeLoop drains the send channel, writes a periodic ping, and tears the
// connection down on a slow/full client.
func (s *Server) writeLoop(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, conn *hub.Conn) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	defer cancel()

	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done:
			// Slow consumer or remote close requested.
			_ = ws.Close(websocket.StatusInternalError, "send buffer full")
			return
		case payload := <-conn.Send:
			wctx, wc := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(wctx, websocket.MessageText, payload)
			wc()
			if err != nil {
				s.log.Debug("ws write failed", "err", err)
				return
			}
		case <-ticker.C:
			pctx, pc := context.WithTimeout(ctx, pingTimeout)
			err := ws.Ping(pctx)
			pc()
			if err != nil {
				s.log.Debug("ws ping failed", "err", err)
				return
			}
		}
	}
}

// readLoop processes client control frames.
func (s *Server) readLoop(ctx context.Context, ws *websocket.Conn, conn *hub.Conn, sess *session) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done:
			return
		default:
		}

		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		s.handleClientFrame(ctx, ws, conn, sess, data)
	}
}

type clientFrame struct {
	Type        string   `json:"type"`
	LastSeenSeq *int64   `json:"lastSeenSeq"`
	Token       string   `json:"token"`
	MessageIDs  []string `json:"messageIds"`
	// rtc.* discriminants
	ToUserID             string `json:"toUserId"`
	OfferID              string `json:"offerId"`
	SDP                  string `json:"sdp"`
	Candidate            string `json:"candidate"`
	Reason               string `json:"reason"`
	ResumeFromChunkIndex *int64 `json:"resumeFromChunkIndex"`
	// typing discriminants
	ConversationID string `json:"conversationId"`
	State          string `json:"state"`
	// call discriminants
	CallID string `json:"callId"`
	Media  string `json:"media"`
}

// maxAckBatch caps a single message.ack frame size — a client that
// over-batches is throttled at the source.
const maxAckBatch = 64

func (s *Server) handleClientFrame(ctx context.Context, ws *websocket.Conn, conn *hub.Conn, sess *session, data []byte) {
	var f clientFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return
	}

	switch f.Type {
	case "hello":
		s.onHello(ctx, conn, sess, f.LastSeenSeq)
	case "ping":
		s.enqueueJSON(conn, map[string]string{"type": "pong"})
	case "message.ack":
		// Phase 5: the recipient ack'd receipt of these messageIds. The
		// dispatcher batches per-recipient and POSTs to messaging-svc, which
		// is the canonical producer for MessageDelivered events.
		if s.dispatcher == nil {
			return
		}
		ids := f.MessageIDs
		if len(ids) > maxAckBatch {
			ids = ids[:maxAckBatch]
		}
		for _, id := range ids {
			s.dispatcher.Ack(sess.claims.UserID, id)
		}
	case "auth.renew":
		newClaims, err := s.verifier.Verify(ctx, f.Token)
		if err != nil {
			s.log.Warn("auth.renew rejected", "err", err)
			s.enqueueJSON(conn, map[string]string{"type": "token.refresh.required"})
			return
		}
		if newClaims.UserID != sess.claims.UserID {
			// Refuse to switch identity on an existing socket.
			s.log.Warn("auth.renew identity mismatch", "old", sess.claims.UserID, "new", newClaims.UserID)
			conn.Close()
			return
		}
		sess.claims = newClaims
		s.log.Debug("auth.renew accepted", "user", newClaims.UserID)
	case "rtc.offer", "rtc.answer", "rtc.ice", "rtc.cancel":
		s.handleSignalingFrame(ctx, conn, sess, &f)
	case "typing":
		s.handleTypingFrame(ctx, conn, sess, &f)
	case "call.invite", "call.accept", "call.decline", "call.cancel", "call.end":
		s.handleCallFrame(ctx, conn, sess, &f)
	default:
		// "subscribe" and any unknown frames are ignored (fan-out is implicit).
	}
}

// handleSignalingFrame validates + routes one rtc.* frame.
//
//   - Rate-limit at MaxRatePerSec; reply with rtc.rate_limited if exceeded.
//   - Validate toUserId (uuid + not self).
//   - Forward via signal.Dispatcher; on unreachable, reply rtc.peer.unreachable.
//
// Cross-org sends are guarded inside the Dispatcher via the org claim.
func (s *Server) handleSignalingFrame(ctx context.Context, conn *hub.Conn, sess *session, f *clientFrame) {
	if s.signal == nil {
		return
	}
	if !sess.rtcRate.Allow(time.Now()) {
		if raw, err := signal.RateLimitedFrame(int(signal.RateWindow / time.Millisecond)); err == nil {
			select {
			case conn.Send <- raw:
			default:
				conn.Close()
			}
		}
		return
	}
	if f.ToUserID == "" || f.ToUserID == sess.claims.UserID {
		// Bad target or self-send. Quietly drop.
		return
	}
	frame := signal.Frame{
		Type:                 f.Type,
		OfferID:              f.OfferID,
		SDP:                  f.SDP,
		Candidate:            f.Candidate,
		Reason:               f.Reason,
		ResumeFromChunkIndex: f.ResumeFromChunkIndex,
	}
	delivered := s.signal.Forward(ctx, sess.claims.OrgID, sess.claims.UserID, f.ToUserID, frame)
	if !delivered {
		if raw, err := signal.UnreachableFrame(f.OfferID, "offline"); err == nil {
			select {
			case conn.Send <- raw:
			default:
				conn.Close()
			}
		}
	}
}

// handleTypingFrame relays an ephemeral 1:1 typing hint to the peer. Unlike
// rtc.*, it is best-effort: a hint to an offline / cross-org peer is silently
// dropped (no peer.unreachable echo), and an over-budget connection is simply
// ignored (typing is debounced, so it should never approach the rate cap).
func (s *Server) handleTypingFrame(ctx context.Context, conn *hub.Conn, sess *session, f *clientFrame) {
	if s.signal == nil {
		return
	}
	if !sess.rtcRate.Allow(time.Now()) {
		return
	}
	if f.ToUserID == "" || f.ToUserID == sess.claims.UserID {
		return
	}
	if f.State != "start" && f.State != "stop" {
		return
	}
	_ = s.signal.Forward(ctx, sess.claims.OrgID, sess.claims.UserID, f.ToUserID, signal.Frame{
		Type:           "typing",
		ConversationID: f.ConversationID,
		State:          f.State,
	})
}

// callFrameFor builds the frame forwarded to the peer. Only the discriminant,
// callId and media are copied off the client frame; the caller's NAME comes
// from the verified JWT claims (clientFrame has no fromName field), so a peer
// can never ring someone under a borrowed name. The callee needs it because the
// ring screen has no other way to say who is calling.
func callFrameFor(sess *session, f *clientFrame) signal.Frame {
	return signal.Frame{
		Type:     f.Type,
		CallID:   f.CallID,
		Media:    f.Media,
		FromName: sess.claims.Username,
	}
}

// handleCallFrame relays a 1:1 call lifecycle frame (invite/accept/decline/
// cancel/end) to the peer over the same signaling path as rtc.*. The media SDP
// and ICE candidates ride the existing rtc.offer/answer/ice frames (offerId ==
// callId). Only a call.invite to an offline / cross-org peer echoes back a
// peer.unreachable (reusing the rtc frame with offerId == callId) so the caller
// stops ringing; the rest are best-effort.
func (s *Server) handleCallFrame(ctx context.Context, conn *hub.Conn, sess *session, f *clientFrame) {
	if s.signal == nil {
		return
	}
	if !sess.rtcRate.Allow(time.Now()) {
		return
	}
	if f.ToUserID == "" || f.ToUserID == sess.claims.UserID || f.CallID == "" {
		return
	}
	delivered := s.signal.Forward(ctx, sess.claims.OrgID, sess.claims.UserID, f.ToUserID, callFrameFor(sess, f))
	if !delivered && f.Type == "call.invite" {
		if raw, err := signal.UnreachableFrame(f.CallID, "offline"); err == nil {
			select {
			case conn.Send <- raw:
			default:
				conn.Close()
			}
		}
	}
}

// onHello sends ready and replays the catch-up buffer.
//
// The hello burst (ready + presence snapshot + per-user replay) is a known,
// in-order batch that can legitimately exceed the send buffer when a client
// reconnects after accumulating a backlog. It is delivered with BACKPRESSURE
// (deliverCtx blocks until writeLoop drains a slot) rather than the non-blocking
// drop-and-close used for live fan-out. Without this, a backlog larger than
// sendChanCap trips conn.Close() and tears the socket down ~immediately, and the
// client reconnects into the same overflow forever — a connect→replay→overflow→
// disconnect loop. A genuinely stuck client is still bounded: writeLoop's
// writeTimeout fails the write, cancels ctx, and deliverCtx then returns false.
func (s *Server) onHello(ctx context.Context, conn *hub.Conn, sess *session, lastSeenSeq *int64) {
	if !s.deliverJSONCtx(ctx, conn, map[string]string{
		"type":   "ready",
		"userId": sess.claims.UserID,
		"orgId":  sess.claims.OrgID,
	}) {
		return
	}

	// Authoritative presence snapshot so a (re)connecting client renders correct
	// online/offline state immediately, rather than waiting for the next 20s poll
	// or for the next transition event from a peer.
	if s.presence != nil {
		if ids, err := s.store.OnlineUserIDs(ctx, sess.claims.OrgID); err == nil {
			if raw, err := s.presence.SnapshotRaw(sess.claims.OrgID, ids); err == nil {
				if !deliverCtx(ctx, conn, raw) {
					return
				}
			}
		}
	}

	var seq int64
	if lastSeenSeq != nil {
		seq = *lastSeenSeq
	}
	events, err := s.store.Replay(ctx, sess.claims.UserID, seq)
	if err != nil {
		s.log.Error("replay failed", "user", sess.claims.UserID, "err", err)
		return
	}
	for _, raw := range events {
		if !deliverCtx(ctx, conn, raw) {
			return
		}
	}
}

// deliverCtx pushes one frame to the connection's outbound buffer with
// backpressure: it blocks until writeLoop frees a slot, the connection closes,
// or ctx is done. Returns false if the frame could not be delivered (caller
// stops). Use this for the connect-time hello/replay burst; use enqueueJSON's
// non-blocking drop-and-close for LIVE traffic where a slow consumer is shed.
func deliverCtx(ctx context.Context, conn *hub.Conn, raw []byte) bool {
	select {
	case conn.Send <- raw:
		return true
	case <-conn.Done:
		return false
	case <-ctx.Done():
		return false
	}
}

// deliverJSONCtx marshals v and delivers it with backpressure (see deliverCtx).
// A marshal error is treated as "nothing to send" (true) so it never fails the
// whole hello.
func (s *Server) deliverJSONCtx(ctx context.Context, conn *hub.Conn, v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return true
	}
	return deliverCtx(ctx, conn, b)
}

// enqueueJSON marshals v and pushes it; on a full buffer it closes the conn.
func (s *Server) enqueueJSON(conn *hub.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case conn.Send <- b:
	default:
		conn.Close()
	}
}
