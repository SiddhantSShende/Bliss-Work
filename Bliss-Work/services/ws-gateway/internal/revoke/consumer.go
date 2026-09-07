// Package revoke closes a locally-connected WebSocket the moment its session
// (refresh-token family) is revoked, instead of leaving it live for the rest
// of its access token's TTL — the gap server/conn.go's writeLoop documents at
// length ("The JWT is verified once, at the handshake..."). This is an
// ADDITIONAL enforcement layer, not the source of truth: the revoke itself
// (auth-svc's refresh_tokens.revoked) is what actually ends the session; this
// only shortens how long an already-open socket keeps working after that.
package revoke

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/segmentio/kafka-go"

	"github.com/task-board/shared-kafkaauth"
	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/metrics"
)

// Topic is auth-svc's existing session/audit event stream (see
// services/auth-svc/app/routes/session_events.py) — not a new topic. Every
// event type on it other than "session.revoked" is ignored by handle below;
// contract.go's FanoutTopics deliberately excludes this topic entirely, since
// nothing here is ever forwarded to a client as an app-level frame.
const Topic = "auth.events"

// event is the minimal shape this consumer reads out of an otherwise-varied
// stream (login/logout/org-switch/session-revoked all share the topic).
// Fields absent on other event types simply decode as zero values, which is
// why handle filters on Type before trusting UserID/SessionID.
type event struct {
	Type      string `json:"type"`
	UserID    string `json:"userId"`
	SessionID string `json:"sessionId"`
}

// Consumer reads Topic and force-closes any locally-connected socket whose
// (userID, sessionID) matches a session.revoked event.
type Consumer struct {
	reader *kafka.Reader
	hub    *hub.Hub
	log    *slog.Logger
}

// New builds a Consumer.
//
// groupID must be unique per NODE — every node needs the entire stream, since
// the socket belonging to a just-revoked session could be on ANY node, not
// just the one that happened to process the revoke API call. Unlike
// fanout.New's broadcast consumer, it does NOT need to be STABLE across
// restarts: this consumer writes nothing durable (no replay outbox — a
// missed event here just means an already-open socket stays open a little
// longer, and it is already bounded by its own token's TTL/expiry check
// regardless), so there is nothing to resume and no harm starting fresh at
// the tip on every boot. Callers pass nodeID for this reason rather than
// config.BroadcastGroupID's hostname-derived, restart-stable identity.
func New(brokers []string, nodeID string, h *hub.Hub, log *slog.Logger) *Consumer {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "ws-gateway-session-revoke-" + nodeID,
		Topic:          Topic,
		MinBytes:       1,
		MaxBytes:       1e6,
		MaxWait:        250 * time.Millisecond,
		StartOffset:    kafka.LastOffset,
		CommitInterval: time.Second,
		Dialer:         kafkaauth.Dialer(),
	})
	return &Consumer{reader: reader, hub: h, log: log}
}

// Run consumes until ctx is cancelled. No tracing span, unlike fanout.Consumer
// and router.Consumer: those matter because a message TAKES TIME to reach a
// client and a trace shows where; this either closes a socket in-process
// within microseconds or does nothing, and there is no producer-side span to
// chain onto since auth-svc's outbox poller does not inject one for this topic.
func (c *Consumer) Run(ctx context.Context) {
	defer func() { _ = c.reader.Close() }()
	c.log.Info("session-revocation consumer started", "topic", Topic)
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Error("kafka read failed", "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			continue
		}
		c.handle(msg.Value)
		if err := c.reader.CommitMessages(ctx, msg); err != nil && ctx.Err() == nil {
			c.log.Warn("kafka commit failed; event will be re-read",
				"partition", msg.Partition, "offset", msg.Offset, "err", err)
		}
	}
}

func (c *Consumer) handle(raw []byte) {
	var ev event
	if err := json.Unmarshal(raw, &ev); err != nil {
		c.log.Warn("skip unparseable auth event", "err", err)
		return
	}
	if ev.Type != "session.revoked" {
		return
	}
	// Do not trust a partial event into closing something it did not name —
	// hub.CloseSession also refuses an empty sessionID, this is belt and
	// suspenders plus a log line that is actionable (a malformed producer),
	// where CloseSession's own silent no-op would not be.
	if ev.UserID == "" || ev.SessionID == "" {
		c.log.Warn("session.revoked event missing userId/sessionId; ignoring")
		return
	}
	closed := c.hub.CloseSession(ev.UserID, ev.SessionID)
	metrics.SessionRevokeEventsTotal.Inc()
	if closed > 0 {
		metrics.SessionRevokeDisconnectsTotal.Add(float64(closed))
		c.log.Info("closed socket(s) for revoked session",
			"user", ev.UserID, "session", ev.SessionID, "sockets", closed)
	}
}
