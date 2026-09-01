// Package emit publishes sticky.refresh events.
//
// ── Why Kafka and not a direct push to ws-gateway ────────────────────────────
// ws-gateway and delivery-svc already own recipient routing, the Redis replay
// outbox, node lookup and per-node batching. Producing onto task.events.v1 —
// a topic they already consume — makes this service a few hundred lines with no
// Redis client and no push credential. A direct /internal/push client would be
// a second copy of delivery-svc AND would need the gateway's internal token,
// which is the ability to deliver any payload to any connected user.
//
// ── Why there is no transactional outbox here ────────────────────────────────
// Every other producer in this repo writes to an outbox table inside the same
// transaction as its state change. This service has no database and no state
// change: a sticky.refresh is a pure nudge that says "re-fetch", carries no
// content, and is safe to lose — the next sweep sends another. An outbox would
// add a database to a service whose whole point is that it does not need one.
package emit

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/segmentio/kafka-go"
	kafkaauth "github.com/task-board/shared-kafkaauth"
	"github.com/task-board/sticky-relay/internal/sweep"
)

// The topic ws-gateway already consumes and fans out from.
const Topic = "task.events.v1"

// EventType is the discriminant clients switch on. It must stay in lockstep
// with THREE other places or the frame is silently dropped on arrival:
//
//   - services/ws-gateway/internal/contract/contract.go   (server-side routing)
//   - packages/shared/src/types/event-routing-spec.ts     (its TS mirror)
//   - packages/shared/src/types/events.ts                 (the client's Zod union)
//
// The last one is the quiet failure: WsClient drops any frame that does not
// parse, with only a console warning, so a missing schema looks exactly like a
// service that is not running.
const EventType = "sticky.refresh"

// Event is the wire shape. Deliberately minimal: a recipient and a count.
// No task ids and no titles — this path exists to say "look again", and putting
// task content on it would spread PII across a repair channel for no gain.
type Event struct {
	Type       string `json:"type"`
	EventID    string `json:"eventId"`
	OrgID      string `json:"orgId"`
	OccurredAt string `json:"occurredAt"`
	AssigneeID string `json:"assigneeId"`
	PinCount   int    `json:"pinCount"`
}

// Build turns a planned refresh into the event to publish. Separated from the
// write so the wire shape can be asserted in a test without a broker.
func Build(r sweep.Refresh, now time.Time) Event {
	return Event{
		Type:       EventType,
		EventID:    uuid.NewString(),
		OrgID:      r.OrgID,
		OccurredAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
		AssigneeID: r.AssigneeID,
		PinCount:   r.PinCount,
	}
}

// Messages marshals a batch of refreshes into Kafka messages.
//
// The key is the ASSIGNEE id, matching how task-svc keys task events by task
// id: same-key messages land on one partition and therefore stay ordered, so a
// person's nudges can never overtake one another.
func Messages(refreshes []sweep.Refresh, now time.Time) ([]kafka.Message, error) {
	msgs := make([]kafka.Message, 0, len(refreshes))
	for _, r := range refreshes {
		payload, err := json.Marshal(Build(r, now))
		if err != nil {
			return nil, fmt.Errorf("marshal sticky.refresh: %w", err)
		}
		msgs = append(msgs, kafka.Message{
			Topic: Topic,
			Key:   []byte(r.AssigneeID),
			Value: payload,
		})
	}
	return msgs, nil
}

type Producer struct {
	writer *kafka.Writer
	dryRun bool
}

// New builds a producer. `dryRun` publishes nothing and is how this service is
// meant to be rolled out: the first deploy logs the plan for a cycle so the
// blast radius is known before a single nudge is sent.
func New(brokers []string, dryRun bool) *Producer {
	return &Producer{
		writer: &kafka.Writer{
			Addr: kafka.TCP(brokers...),
			// nil for a plaintext broker; kafka-go then uses its own default.
			Transport:    kafkaauth.Transport(),
			Balancer:     &kafka.Hash{},
			RequiredAcks: kafka.RequireAll,
			BatchTimeout: 50 * time.Millisecond,
		},
		dryRun: dryRun,
	}
}

func (p *Producer) DryRun() bool { return p.dryRun }

// Publish writes one sweep's worth of nudges.
func (p *Producer) Publish(ctx context.Context, refreshes []sweep.Refresh, now time.Time) error {
	if len(refreshes) == 0 {
		return nil
	}
	msgs, err := Messages(refreshes, now)
	if err != nil {
		return err
	}
	if p.dryRun {
		return nil
	}
	return p.writer.WriteMessages(ctx, msgs...)
}

func (p *Producer) Close() error { return p.writer.Close() }
