package server

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/auth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/signal"
	"github.com/task-board/ws-gateway/internal/store"
)

const (
	pingInterval = 20 * time.Second
	pingTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
)

// session holds the mutable per-connection auth state.
//
// claims is an atomic.Pointer, not a plain field: auth.renew (readLoop's
// goroutine) swaps it wholesale on every token refresh, and writeLoop's own
// goroutine now reads it every heartbeat tick (see writeLoop's doc comment)
// — two goroutines, one shared pointer, so a plain field would be a genuine
// data race the moment writeLoop started reading it.
type session struct {
	claims  atomic.Pointer[auth.Claims]
	rtcRate signal.Limiter
}

func (s *Server) serveConn(parent context.Context, ws *websocket.Conn, claims *auth.Claims) {
	connID := uuid.NewString()
	conn := hub.NewConn(claims.UserID, connID)
	sess := &session{}
	sess.claims.Store(claims)

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

	// Register presence for EVERY organization this person belongs to, not just
	// the one this socket is signed in to.
	//
	// One person, one presence: being at their desk is a fact about them, not
	// about which workspace tab happens to be open. Before this, a member of two
	// orgs working in A showed as offline to everyone in B — and would have,
	// indefinitely, because nothing about them was going to change.
	//
	// The org's online set is keyed by the MEMBERSHIP user id, which differs per
	// org for the same person, so each org gets its own id from the claim rather
	// than claims.UserID. Verify guarantees the current membership is in the
	// list, so the single-org case is just a loop of one.
	for _, m := range claims.Memberships {
		if err := s.store.AddPresence(ctx, m.UserID, s.nodeID, connID); err != nil {
			s.log.Error("add presence failed", "err", err, "org", m.OrgID)
		}
		becameOnline, err := s.store.AddOrgPresence(ctx, m.OrgID, m.UserID)
		if err != nil {
			s.log.Error("add org presence failed", "err", err, "org", m.OrgID)
		}
		// Broadcast presence.online ONLY on the absent→present transition (first
		// socket/tab), so org-mates flip the avatar live without one event per
		// tab. Evaluated per org: opening a second tab in A is not a transition
		// there, but it may well be the first signal B has seen.
		if becameOnline && s.presence != nil {
			s.presence.Online(ctx, m.OrgID, m.UserID)
		}
	}
	s.log.Info("ws connected", "user", claims.UserID, "conn", connID, "org", claims.OrgID,
		"orgs", len(claims.Memberships))

	defer func() {
		conn.Close()
		s.hub.Remove(conn)
		// Use a fresh short-lived context for cleanup (parent may be done).
		cleanupCtx, cc := context.WithTimeout(context.Background(), 3*time.Second)
		defer cc()
		// Mirror of the connect loop: this socket's presence is withdrawn from
		// every org it registered in, and each org decides independently whether
		// that was the person's last connection.
		//
		// Reads sess.claims (the LATEST, possibly-renewed membership list), not
		// the claims this function was called with: auth.renew already keeps
		// presence itself in sync with each renewal via reconcilePresence, but
		// if this read the original claims instead, it would re-add presence
		// for an org membership that renewal had removed (or leave a joined
		// org's presence never withdrawn), undoing that reconciliation the
		// moment the socket closed.
		for _, m := range sess.claims.Load().Memberships {
			if err := s.store.RemovePresence(cleanupCtx, m.UserID, s.nodeID, connID); err != nil {
				s.log.Error("remove presence failed", "err", err, "org", m.OrgID)
			}
			becameOffline, err := s.store.RemoveOrgPresenceIfLast(cleanupCtx, m.OrgID, m.UserID)
			if err != nil {
				s.log.Error("remove org presence failed", "err", err, "org", m.OrgID)
			}
			// Broadcast presence.offline ONLY on the present→absent transition
			// (last socket closed across all nodes).
			if becameOffline && s.presence != nil {
				s.presence.Offline(cleanupCtx, m.OrgID, m.UserID)
			}
		}
		s.log.Info("ws disconnected", "user", claims.UserID, "conn", connID)
	}()

	go s.writeLoop(ctx, cancel, ws, conn, sess)
	s.readLoop(ctx, ws, conn, sess)
}

// reconcilePresence updates presence for a token renewal's membership DELTA.
//
// Before this, auth.renew swapped sess.claims and stopped there — it never
// touched presence at all. Joining a new org left that org's members unaware
// this person was even connected until their next full reconnect. Leaving an
// org was worse: the person kept showing online, and reachable for RTC
// signaling (signal.Dispatcher.Forward gates delivery on presence), to every
// remaining member of an org they had just been removed from, for as long as
// the socket stayed open — auth-svc's own token-refresh contract says a
// membership change "reaches presence within one token lifetime without a
// re-login"; this is what makes that true on the ws-gateway side too.
//
// added orgs get AddPresence/AddOrgPresence, broadcasting presence.online on
// the absent→present transition — the same call connect-time registration
// makes. Removed orgs get RemovePresence/RemoveOrgPresenceIfLast,
// broadcasting presence.offline on the present→absent transition — the same
// call disconnect cleanup makes. An org present in both lists (the ordinary
// case: nothing changed) is touched by neither.
func (s *Server) reconcilePresence(ctx context.Context, conn *hub.Conn, oldMemberships, newMemberships []auth.Membership) {
	oldByOrg := make(map[string]string, len(oldMemberships)) // orgID -> member user id
	for _, m := range oldMemberships {
		oldByOrg[m.OrgID] = m.UserID
	}
	newByOrg := make(map[string]string, len(newMemberships))
	for _, m := range newMemberships {
		newByOrg[m.OrgID] = m.UserID
	}

	for orgID, userID := range newByOrg {
		if _, stillMember := oldByOrg[orgID]; stillMember {
			continue
		}
		if err := s.store.AddPresence(ctx, userID, s.nodeID, conn.ConnID); err != nil {
			s.log.Error("auth.renew: add presence failed", "err", err, "org", orgID)
		}
		becameOnline, err := s.store.AddOrgPresence(ctx, orgID, userID)
		if err != nil {
			s.log.Error("auth.renew: add org presence failed", "err", err, "org", orgID)
		}
		if becameOnline && s.presence != nil {
			s.presence.Online(ctx, orgID, userID)
		}
	}

	for orgID, userID := range oldByOrg {
		if _, stillMember := newByOrg[orgID]; stillMember {
			continue
		}
		if err := s.store.RemovePresence(ctx, userID, s.nodeID, conn.ConnID); err != nil {
			s.log.Error("auth.renew: remove presence failed", "err", err, "org", orgID)
		}
		becameOffline, err := s.store.RemoveOrgPresenceIfLast(ctx, orgID, userID)
		if err != nil {
			s.log.Error("auth.renew: remove org presence failed", "err", err, "org", orgID)
		}
		if becameOffline && s.presence != nil {
			s.presence.Offline(ctx, orgID, userID)
		}
	}
}

// writeLoop drains the send channel, writes a periodic ping, refreshes this
// connection's presence heartbeat, and tears the connection down on a
// slow/full client.
//
// ── Two tickers, deliberately ────────────────────────────────────────────────
//
// The presence heartbeat used to ride the ping ticker, which had one number
// doing two unrelated jobs. A ping detects a dead TCP connection and wants to
// be frequent; a presence write keeps a Redis entry fresh and wants to be as
// rare as the staleness window allows. Tied together at 20s, presence became
// the single largest source of Redis traffic in the platform — one 4-command
// write per socket per 20 seconds, before anyone sends a message.
//
// Separated, each is sized for its own job: pings stay at 20s, the heartbeat
// moves to 45s inside a 120s stale window, and the write rate more than halves
// without changing how fast a dead socket is noticed.
//
// Takes sess (not a frozen membership list) so each beat reads
// sess.claims.Load().Memberships fresh: a membership added or removed by
// auth.renew since this loop started must be reflected on the very next
// heartbeat, or a stale frozen list would either let a removed org's
// presence entry get silently re-created here (undoing reconcilePresence's
// removal) or never heartbeat a newly joined org's entry until it aged out.
func (s *Server) writeLoop(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, conn *hub.Conn, sess *session) {
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()
	beatTicker := time.NewTicker(store.PresenceHeartbeatInterval)
	defer beatTicker.Stop()
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
		case <-pingTicker.C:
			pctx, pc := context.WithTimeout(ctx, pingTimeout)
			err := ws.Ping(pctx)
			pc()
			if err != nil {
				s.log.Debug("ws ping failed", "err", err)
				return
			}
		case <-beatTicker.C:
			// Presence is scored by the last time we heard from a connection
			// and is reaped on read, so a live socket has to say so
			// periodically or it ages out from under itself.
			//
			// A failure here is not fatal to the socket: the entry simply keeps
			// its previous score and, if Redis stays unreachable past the stale
			// window, the user is reported offline while still connected. That
			// is the correct way to be wrong — the alternative is reporting
			// people online because we cannot tell.
			//
			// Beaten for every organization this socket registered in, or the
			// orgs the person is not currently looking at would age out of the
			// stale window and show them offline while they are plainly
			// connected — which is the bug this whole path exists to fix.
			tctx, tc := context.WithTimeout(ctx, pingTimeout)
			for _, m := range sess.claims.Load().Memberships {
				if err := s.store.TouchPresence(tctx, m.OrgID, m.UserID, s.nodeID, conn.ConnID); err != nil {
					s.log.Warn("presence heartbeat failed", "err", err, "user", m.UserID, "org", m.OrgID)
				}
			}
			tc()
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
		s.handleClientFrame(ctx, conn, sess, data)
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

func (s *Server) handleClientFrame(ctx context.Context, conn *hub.Conn, sess *session, data []byte) {
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
			s.dispatcher.Ack(sess.claims.Load().UserID, id)
		}
	case "auth.renew":
		newClaims, err := s.verifier.Verify(ctx, f.Token)
		if err != nil {
			s.log.Warn("auth.renew rejected", "err", err)
			s.enqueueJSON(conn, map[string]string{"type": "token.refresh.required"})
			return
		}
		oldClaims := sess.claims.Load()
		if newClaims.UserID != oldClaims.UserID {
			// Refuse to switch identity on an existing socket.
			s.log.Warn("auth.renew identity mismatch", "old", oldClaims.UserID, "new", newClaims.UserID)
			conn.Close()
			return
		}
		s.reconcilePresence(ctx, conn, oldClaims.Memberships, newClaims.Memberships)
		sess.claims.Store(newClaims)
		s.log.Debug("auth.renew accepted", "user", newClaims.UserID)
	case "rtc.offer", "rtc.answer", "rtc.ice", "rtc.cancel":
		s.handleSignalingFrame(ctx, conn, sess, &f)
	case "typing":
		s.handleTypingFrame(ctx, sess, &f)
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
	if f.ToUserID == "" || f.ToUserID == sess.claims.Load().UserID {
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
	delivered := s.signal.Forward(ctx, sess.claims.Load().OrgID, sess.claims.Load().UserID, f.ToUserID, frame)
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
func (s *Server) handleTypingFrame(ctx context.Context, sess *session, f *clientFrame) {
	if s.signal == nil {
		return
	}
	if !sess.rtcRate.Allow(time.Now()) {
		return
	}
	if f.ToUserID == "" || f.ToUserID == sess.claims.Load().UserID {
		return
	}
	if f.State != "start" && f.State != "stop" {
		return
	}
	_ = s.signal.Forward(ctx, sess.claims.Load().OrgID, sess.claims.Load().UserID, f.ToUserID, signal.Frame{
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
		FromName: sess.claims.Load().Username,
	}
}

// handleCallFrame relays a 1:1 call lifecycle frame (invite/accept/decline/
// cancel/end) to the peer over the same signaling path as rtc.*. The media SDP
// and ICE candidates ride the existing rtc.offer/answer/ice frames (offerId ==
// callId). Only a call.invite to an offline / cross-org / blocked peer echoes
// back a peer.unreachable (reusing the rtc frame with offerId == callId) so
// the caller stops ringing; the rest are best-effort.
//
// call.invite alone also runs the block check (P0-A): a caller who has
// blocked, or been blocked by, the target must never have their ring
// forwarded. accept/decline/cancel/end need no check of their own — they only
// exist in response to an invite that already had to pass this gate, and the
// high-frequency rtc.offer/answer/ice frames that carry the actual media
// negotiation are deliberately left out of scope (see
// signal.Dispatcher.CallInviteAllowed's doc comment for why a per-frame check
// there would be too expensive).
func (s *Server) handleCallFrame(ctx context.Context, conn *hub.Conn, sess *session, f *clientFrame) {
	if s.signal == nil {
		return
	}
	if !sess.rtcRate.Allow(time.Now()) {
		return
	}
	if f.ToUserID == "" || f.ToUserID == sess.claims.Load().UserID || f.CallID == "" {
		return
	}

	if f.Type == "call.invite" {
		allowed, err := s.signal.CallInviteAllowed(ctx, sess.claims.Load().OrgID, sess.claims.Load().UserID, f.ToUserID)
		if err != nil {
			s.log.Warn("call block check failed", "from", sess.claims.Load().UserID, "to", f.ToUserID, "err", err)
		}
		if err != nil || !allowed {
			// Same "offline" reason a genuinely unreachable peer gets below —
			// a blocked caller must learn nothing from this failure beyond
			// "the call did not go through."
			if raw, uerr := signal.UnreachableFrame(f.CallID, "offline"); uerr == nil {
				select {
				case conn.Send <- raw:
				default:
					conn.Close()
				}
			}
			return
		}
	}

	delivered := s.signal.Forward(ctx, sess.claims.Load().OrgID, sess.claims.Load().UserID, f.ToUserID, callFrameFor(sess, f))
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
		"userId": sess.claims.Load().UserID,
		"orgId":  sess.claims.Load().OrgID,
	}) {
		return
	}

	// Authoritative presence snapshot so a (re)connecting client renders correct
	// online/offline state immediately, rather than waiting for the next 20s poll
	// or for the next transition event from a peer.
	if s.presence != nil {
		if ids, err := s.store.OnlineUserIDs(ctx, sess.claims.Load().OrgID); err == nil {
			if raw, err := s.presence.SnapshotRaw(sess.claims.Load().OrgID, ids); err == nil {
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
	events, err := s.store.Replay(ctx, sess.claims.Load().UserID, seq)
	if err != nil {
		s.log.Error("replay failed", "user", sess.claims.Load().UserID, "err", err)
		return
	}
	for _, raw := range events {
		if !deliverCtx(ctx, conn, raw) {
			return
		}
	}

	// Close the catch-up burst explicitly. Everything above already happened, so
	// a client that announced it would re-toast up to 200 events on every launch
	// and reconnect. The client cannot infer the boundary on its own: events
	// carry SERVER timestamps, and a client whose clock disagrees would either
	// silence live events or announce replayed ones. Sent even when the replay
	// was empty, so the client always leaves catch-up mode.
	s.deliverJSONCtx(ctx, conn, map[string]string{"type": "replay.done"})
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
