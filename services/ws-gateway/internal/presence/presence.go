// Package presence broadcasts user online/offline transitions to every other
// member of an org in real time, so a teammate's avatar flips the instant they
// connect or disconnect — instead of waiting up to 20s for the next HTTP poll.
//
// Delivery model (mirrors internal/signal for RTC):
//
//   - On a user's FIRST connection (org-presence absent→present) the gateway
//     calls Online(); on their LAST disconnect (present→absent) it calls
//     Offline(). Each publishes one event to the shared Redis "presence:events"
//     channel.
//   - Every gateway node runs RunSubscriber, which receives each event and fans
//     it out to the locally-connected sockets of all users currently online in
//     that org (Hub.Fanout is a no-op for users not on this node, so the same
//     event addressed org-wide is delivered correctly across N nodes).
//
// Presence is ephemeral: events are never persisted to the replay outbox. A
// reconnecting client receives a fresh presence.snapshot on hello (see
// server.onHello), which is authoritative, so it can never act on stale state.
package presence

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/task-board/ws-gateway/internal/hub"
	"github.com/task-board/ws-gateway/internal/store"
)

// Event types pushed to clients. These mirror the PresenceOnline/PresenceOffline
// /PresenceSnapshot zod schemas in packages/shared/src/types/events.ts.
const (
	typeOnline   = "presence.online"
	typeOffline  = "presence.offline"
	typeSnapshot = "presence.snapshot"
)

// event is the wire envelope for the online/offline transitions. It matches the
// shared zod `envelope` (eventId, orgId, occurredAt) plus userId. The snapshot
// uses its own struct (below) because its `online` array must ALWAYS be present
// — omitempty would drop an empty set and break the client's z.array() parse.
type event struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	UserID     string `json:"userId"`
}

// snapshotEvent matches the PresenceSnapshot zod schema. `online` has NO
// omitempty so an empty org online set serializes to [] (never null/absent).
type snapshotEvent struct {
	Type       string   `json:"type"`
	EventID    string   `json:"eventId"`
	OrgID      string   `json:"orgId"`
	OccurredAt string   `json:"occurredAt"`
	Online     []string `json:"online"`
}

// Broadcaster publishes presence transitions and fans received ones out locally.
type Broadcaster struct {
	hub   *hub.Hub
	store *store.Store
	log   *slog.Logger
}

// New constructs a Broadcaster.
func New(h *hub.Hub, st *store.Store, log *slog.Logger) *Broadcaster {
	return &Broadcaster{hub: h, store: st, log: log}
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// Online publishes a presence.online transition for userID within orgID.
func (b *Broadcaster) Online(ctx context.Context, orgID, userID string) {
	b.publish(ctx, typeOnline, orgID, userID)
}

// Offline publishes a presence.offline transition for userID within orgID.
func (b *Broadcaster) Offline(ctx context.Context, orgID, userID string) {
	b.publish(ctx, typeOffline, orgID, userID)
}

func (b *Broadcaster) publish(ctx context.Context, typ, orgID, userID string) {
	ev := event{
		Type:       typ,
		EventID:    uuid.NewString(),
		OrgID:      orgID,
		OccurredAt: nowRFC3339(),
		UserID:     userID,
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if err := b.store.PublishPresence(ctx, raw); err != nil {
		b.log.Warn("presence publish failed", "type", typ, "user", userID, "err", err)
	}
}

// SnapshotRaw builds a presence.snapshot frame carrying the org's full online
// set. Sent directly to a single socket on hello (not via pub/sub).
func (b *Broadcaster) SnapshotRaw(orgID string, online []string) ([]byte, error) {
	if online == nil {
		online = []string{}
	}
	return json.Marshal(snapshotEvent{
		Type:       typeSnapshot,
		EventID:    uuid.NewString(),
		OrgID:      orgID,
		OccurredAt: nowRFC3339(),
		Online:     online,
	})
}

// RunSubscriber consumes the shared presence channel and fans each transition
// out to the locally-connected members of the affected org. Blocks until ctx is
// done; started once per process from cmd/ws-gateway/main.go.
func (b *Broadcaster) RunSubscriber(ctx context.Context) {
	b.store.SubscribePresence(ctx, func(raw []byte) {
		var ev event
		if err := json.Unmarshal(raw, &ev); err != nil {
			return
		}
		// Recipients = everyone currently online in the org. For a presence.offline
		// the subject has already been removed from the set, so it is naturally
		// excluded; remaining members still get the event and flip the avatar.
		ids, err := b.store.OnlineUserIDs(ctx, ev.OrgID)
		if err != nil {
			b.log.Warn("presence recipients lookup failed", "org", ev.OrgID, "err", err)
			return
		}
		for _, uid := range ids {
			if b.hub.HasUser(uid) {
				b.hub.Fanout(uid, raw)
			}
		}
	})
}
