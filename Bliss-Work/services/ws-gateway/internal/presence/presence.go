// Package presence broadcasts user online/offline transitions to every other
// member of an org in real time, so a teammate's avatar flips the instant they
// connect or disconnect — instead of waiting up to 20s for the next HTTP poll.
//
// Delivery model (mirrors internal/signal for RTC):
//
//   - On a user's FIRST connection (org-presence absent→present) the gateway
//     calls Online(); on their LAST disconnect (present→absent) it calls
//     Offline().
//   - The recipients — everyone currently online in that org — are resolved
//     ONCE, here, and the event is pushed to the gateway nodes that actually
//     hold them.
//
// ── What this replaced, and why it mattered twice ────────────────────────────
// This used to publish one event to a shared Redis "presence:events" channel
// that every gateway node subscribed to. Each node then called OnlineUserIDs
// for the affected org and fanned out to whichever of those users it held.
//
// That is a broadcast, and it was expensive in two separate ways. Every node
// received every presence transition in the platform — so the message rate
// scaled with node count. And, worse, EVERY NODE ran its own OnlineUserIDs: a
// single avatar flipping in a ten-thousand-person organisation meant twenty
// nodes each reaping and reading a ten-thousand-member sorted set. The Redis
// read amplification was N times the transport amplification.
//
// Resolving recipients once at the publisher collapses both. It also survives
// clustering, which the pub/sub form could not: classic Redis pub/sub is
// delivered to every node of a cluster whatever the channel name hashes to.
//
// The cost moved rather than vanishing — the publisher now pays for the
// recipient lookup on the connect/disconnect path instead of every node paying
// afterwards. That is a strictly smaller total, but it does mean a very large
// organisation makes one large read per transition. Bounding THAT is a
// data-model question (a presence subscription rather than an org-wide
// broadcast), not a transport one, and it is not solved here.
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
	"github.com/task-board/ws-gateway/internal/push"
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

// Broadcaster resolves the audience for a presence transition and delivers it.
type Broadcaster struct {
	hub    *hub.Hub
	store  *store.Store
	fanout *push.Fanout
	log    *slog.Logger
}

// New constructs a Broadcaster. `fanout` may be nil in tests, in which case
// transitions reach only this node's sockets.
func New(h *hub.Hub, st *store.Store, f *push.Fanout, log *slog.Logger) *Broadcaster {
	return &Broadcaster{hub: h, store: st, fanout: f, log: log}
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

	// Recipients = everyone currently online in the org, resolved ONCE. For a
	// presence.offline the subject has already been removed from the set, so
	// they are naturally excluded; everyone else gets the event and flips the
	// avatar.
	ids, err := b.store.OnlineUserIDs(ctx, orgID)
	if err != nil {
		b.log.Warn("presence recipients lookup failed", "org", orgID, "err", err)
		return
	}
	if len(ids) == 0 {
		return
	}
	if b.fanout == nil {
		// Same-node only (tests, or a single-gateway deployment where there is
		// nowhere else a socket could be).
		for _, uid := range ids {
			b.hub.Fanout(uid, raw)
		}
		return
	}
	b.fanout.Deliver(ctx, ids, raw)
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

// NOTE: there is deliberately no RunSubscriber any more.
//
// Every node used to run one, consuming a shared Redis channel that carried
// every presence transition in the platform, and each node then ran its own
// OnlineUserIDs for the affected org. Recipients are now resolved once by the
// publisher and pushed only to the nodes that hold them, so there is nothing
// left for a per-node subscriber to do.
