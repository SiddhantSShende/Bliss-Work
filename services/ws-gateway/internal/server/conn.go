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
	if err := s.store.AddOrgPresence(ctx, claims.OrgID, claims.UserID); err != nil {
		s.log.Error("add org presence failed", "err", err)
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
		if err := s.store.RemoveOrgPresenceIfLast(cleanupCtx, claims.OrgID, claims.UserID); err != nil {
			s.log.Error("remove org presence failed", "err", err)
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

// onHello sends ready and replays the catch-up buffer.
func (s *Server) onHello(ctx context.Context, conn *hub.Conn, sess *session, lastSeenSeq *int64) {
	s.enqueueJSON(conn, map[string]string{
		"type":   "ready",
		"userId": sess.claims.UserID,
		"orgId":  sess.claims.OrgID,
	})

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
		select {
		case conn.Send <- raw:
		default:
			conn.Close()
			return
		}
	}
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
