package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/segmentio/kafka-go"

	"github.com/task-board/notification-svc/internal/events"
	"github.com/task-board/notification-svc/internal/outbox"
	"github.com/task-board/shared-kafkaauth"
)

// errMalformed marks a message whose payload could not be unmarshaled. It is the
// only error that routes a message to the dead-letter topic (and then commits);
// every other error is treated as transient and left uncommitted to redeliver.
var errMalformed = errors.New("malformed message")

// Consumer reads task.events.v1 and projects acknowledged/completed events into
// notifications plus a notification.created outbox row.
type Consumer struct {
	pool   *pgxpool.Pool
	reader *kafka.Reader
	dlq    *kafka.Writer
	log    *slog.Logger
	// stop triggers the same graceful shutdown main.go uses for a fatal HTTP
	// listen failure. runBatch calls it whenever a batch is abandoned
	// uncommitted — see runBatch's doc comment for why that must end this
	// process rather than let the loop keep going on the same reader.
	stop func()
}

// New constructs a Consumer subscribed to task.events.v1, auth.events and
// messaging.events.v1 under group "notification-svc".
//
// Each secondary topic is read for exactly one message type:
//   - auth.events → org.deleted. Notifications carry task titles and message
//     previews, so an erased workspace has to take them with it.
//   - messaging.events.v1 → channel.member.joined and message-created events.
//     messaging-svc is the source of these notification-worthy events.
//
// GroupTopics rather than one reader each — a single consumer group covering
// all three keeps offset management and rebalancing in one place.
//
// stop is called if a batch is ever abandoned uncommitted (see runBatch) —
// pass the same signal.NotifyContext stop func main.go uses for its rootCtx,
// so this triggers the identical graceful-shutdown-then-restart path as any
// other fatal condition in the process.
func New(pool *pgxpool.Pool, brokers []string, log *slog.Logger, stop func()) *Consumer {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        "notification-svc",
		GroupTopics:    []string{events.TopicTask, events.TopicAuth, events.TopicMessaging},
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: 0, // commit synchronously after successful handling
		MaxWait:        500 * time.Millisecond,
		// Applies ONLY to a partition this group has never committed an offset
		// for, which in practice means a newly-subscribed topic. The default is
		// FirstOffset, and that default is wrong for a notification service:
		// adding messaging.events.v1 to an existing group would have replayed
		// the whole retained topic and told users they were added to channels
		// days ago, as news. A notification is about what is happening now.
		//
		// It costs nothing on the topics already subscribed — their committed
		// offsets win — and a genuine redelivery there is still caught by the
		// durable consumed_events dedup rather than by this.
		StartOffset: kafka.LastOffset,
		// nil unless KAFKA_SECURITY_PROTOCOL asks for TLS/SASL, which is
		// exactly what ReaderConfig wants for an unauthenticated broker.
		Dialer: kafkaauth.Dialer(),
	})
	// Dead-letter producer for poison (unparseable) messages.
	dlq := &kafka.Writer{
		Addr: kafka.TCP(brokers...),
		// nil for a plaintext broker; kafka-go then uses its own default.
		Transport:    kafkaauth.Transport(),
		Topic:        events.TopicNotificationDLQ,
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		BatchTimeout: 50 * time.Millisecond,
	}
	return &Consumer{pool: pool, reader: r, dlq: dlq, log: log, stop: stop}
}

// Run consumes until ctx is cancelled. The loop body is wrapped so a panic in
// handling logs at ERROR and the loop continues instead of silently killing the
// goroutine.
func (c *Consumer) Run(ctx context.Context) {
	defer c.reader.Close()
	defer c.dlq.Close()
	for ctx.Err() == nil {
		c.runBatch(ctx)
	}
}

// Batch sizing.
//
// ── Why this consumer batches at all ────────────────────────────────────────
// This loop used to be strictly one message at a time: FetchMessage, a DB
// transaction, then a SYNCHRONOUS offset commit (CommitInterval is 0, and
// deliberately so). That is roughly three network round trips per event with no
// pipelining whatsoever, which caps a replica at a few hundred events/sec — on
// the topic that fans out to every subscriber of every event, and is therefore
// the highest-volume stream in the platform by orders of magnitude.
//
// Worse, the cap could not be lifted by adding replicas: consumer-group
// parallelism is bounded by partition count, so the ceiling was
// partitions × few-hundred no matter how many pods were running.
//
// Batching amortizes both fixed costs. One transaction and one offset commit
// now cover up to maxBatchSize events, so the round trips scale with batches
// instead of with messages.
const (
	// maxBatchSize bounds one transaction's worth of work. Larger batches
	// amortize better but hold row locks and an open transaction for longer,
	// and a transient failure re-does the whole batch — so this is chosen to
	// keep a retry cheap rather than to maximize throughput.
	maxBatchSize = 200

	// batchLinger is how long the loop waits for a batch to FILL once it has at
	// least one message. It is a latency budget, not a throughput knob: an idle
	// consumer still processes a lone event within this much of it arriving.
	//
	// Notifications surface in a UI, so this stays small. 25ms is far below the
	// threshold at which a person perceives a notification as delayed, and it
	// is enough to collect a large batch under the bursty load that actually
	// matters — a task fan-out arrives as a burst, not as a trickle.
	batchLinger = 25 * time.Millisecond
)

// runBatch fetches a batch of messages and processes them in ONE transaction,
// with panic recovery.
//
// The delivery guarantees are unchanged from the per-message version, which is
// the point — batching is an efficiency change and must not become a
// correctness one:
//
//   - Offsets are committed only after the batch's transaction commits, so a
//     crash anywhere before that redelivers the whole batch. Every event is
//     dedup-claimed by event_id inside the same transaction, so redelivery is
//     idempotent — reprocessing writes nothing the second time.
//   - A transient error abandons the ENTIRE batch uncommitted rather than the
//     successful prefix. That is a deliberate trade: it re-does work, and the
//     dedup makes re-doing it free, whereas committing a prefix would need
//     per-message offset tracking to stay correct.
//   - A malformed message is dead-lettered and its offset still committed, so a
//     poison pill cannot block the partition — and one poison message no longer
//     costs the whole batch, because it is skipped rather than failed.
//
// "Abandon and redeliver" only actually redelivers if the NEXT fetch starts
// from where this batch started. It does not: kafka-go's FetchMessage already
// advanced this reader's in-memory read position past every message in the
// batch the instant it returned them, regardless of whether they are ever
// committed — and a GroupID reader like this one cannot be rewound with
// SetOffset. So once a batch is abandoned, any LATER batch on this same
// reader that DOES commit successfully would commit past the abandoned
// offsets too (CommitMessages advances to the highest offset it is given),
// silently discarding the gap forever. The only sound recovery is to never
// let that later commit happen on this reader again: every abandon path
// below calls c.stop (the same shutdown func the HTTP listen-failure path in
// main.go already uses) to trigger a full graceful shutdown. The process
// exits, the container's restart policy brings up a fresh one, and a new
// reader resumes each partition from the group's last TRULY committed
// broker offset — which is exactly the abandoned batch, now genuinely
// redelivered.
func (c *Consumer) runBatch(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			c.log.Error("consumer panic recovered; batch abandoned, restarting for redelivery", "panic", rec)
			c.stop()
		}
	}()

	batch := c.fetchBatch(ctx)
	if len(batch) == 0 {
		return
	}

	// One transaction for the whole batch; see projectBatch (poison.go) for how
	// a message the database permanently rejects is isolated and dead-lettered
	// instead of being mistaken for a transient failure.
	poison, err := c.projectBatch(ctx, batch)
	if err != nil {
		c.stop()
		return
	}

	// Durable now. Dead-letter the poison, and only then advance offsets — if
	// the DLQ produce fails the batch redelivers, which is the safe direction.
	for _, m := range poison {
		if derr := c.deadLetter(ctx, m); derr != nil {
			c.log.Error("dead-letter produce failed; batch abandoned, restarting for redelivery", "error", derr)
			c.stop()
			return
		}
		c.log.Warn("dlq: poison message dead-lettered",
			"topic", events.TopicNotificationDLQ, "bytes", len(m.Value))
	}

	// One commit for the whole batch. CommitMessages advances each partition to
	// the highest offset it sees, so passing the batch is correct even when it
	// spans partitions or topics.
	//
	// A failure here still needs the same restart-for-redelivery treatment as
	// every other abandon path, even though this batch's DB work already
	// committed: this reader's in-memory read position has already moved past
	// these messages, so if a LATER batch on this same reader commits
	// successfully, it would commit past this batch's offsets too and this
	// notification would never show as committed. Reprocessing it after
	// restart is a safe no-op (dedup), so restarting is strictly safer than
	// continuing.
	if err := c.reader.CommitMessages(ctx, batch...); err != nil {
		c.log.Error("commit messages failed; restarting for redelivery", "error", err, "batch", len(batch))
		c.stop()
	}
}

// fetchBatch blocks for the first message, then collects whatever else is
// already waiting, up to maxBatchSize or batchLinger — whichever comes first.
//
// The first fetch is deliberately unbounded: an idle consumer must park on the
// broker rather than spin. Only once there IS work does the linger apply, so
// the batching costs latency exclusively when there is something to batch with.
func (c *Consumer) fetchBatch(ctx context.Context) []kafka.Message {
	first, err := c.reader.FetchMessage(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		c.log.Error("fetch message failed", "error", err)
		time.Sleep(time.Second)
		return nil
	}

	batch := make([]kafka.Message, 0, maxBatchSize)
	batch = append(batch, first)

	linger, cancel := context.WithTimeout(ctx, batchLinger)
	defer cancel()
	for len(batch) < maxBatchSize {
		m, err := c.reader.FetchMessage(linger)
		if err != nil {
			// Deadline reached (the batch is as full as it is going to get) or
			// shutdown. Either way, process what we have — the messages already
			// in hand are not dropped.
			break
		}
		batch = append(batch, m)
	}
	return batch
}

// deadLetter produces the original raw message bytes to the dead-letter topic,
// preserving the source key so partitioning is stable.
func (c *Consumer) deadLetter(ctx context.Context, m kafka.Message) error {
	return c.dlq.WriteMessages(ctx, kafka.Message{
		Key:   m.Key,
		Value: m.Value,
	})
}

// handle projects ONE event onto the caller's transaction.
//
// It does not own the transaction and must not commit it: the caller batches
// many events into a single tx (see runBatch), which is what keeps the DB round
// trips proportional to batches rather than to messages.
func (c *Consumer) handle(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.TaskEvent
	if err := json.Unmarshal(value, &ev); err != nil {
		// Malformed payload: signal the caller to dead-letter (then commit) so a
		// poison pill cannot block the partition.
		c.log.Warn("unparseable task event", "error", err)
		return errMalformed
	}

	// The workspace is gone; its notifications go with it. Handled before the
	// task switch because it arrives on a different topic and shares none of
	// the task-event shape beyond the envelope.
	if ev.Type == events.TypeOrgDeleted {
		return c.purgeOrg(ctx, tx, ev.OrgID)
	}

	// Same reasoning: a different topic and a different shape, so it re-reads
	// the raw bytes rather than pretending to be a task event.
	if ev.Type == events.TypeChannelMemberJoined {
		return c.channelMemberJoined(ctx, tx, value)
	}
	if ev.Type == events.TypeMessageCreated {
		return c.messageCreated(ctx, tx, value)
	}
	if ev.Type == events.TypeChannelMessageCreated {
		return c.channelMessageCreated(ctx, tx, value)
	}
	// The call events that tell a PERSON something about a meeting: scheduled (or
	// edited), invited, starting, cancelled. call.participant_added is addressed to
	// the whole room as a "refresh who is here" signal and always accompanies a
	// call.ring for the newcomer: persisting it too gave the newcomer two identical
	// invitations and told everyone already in the call they were invited to it.
	// The other call events (ended, waiting, left, screen shares) are signals for
	// live clients, not news.
	switch ev.Type {
	case events.TypeCallScheduled, events.TypeCallRing, events.TypeCallStarted, events.TypeCallEnded:
		return c.callNotification(ctx, tx, value)
	}

	var kind, text string
	switch ev.Type {
	case events.TypeTaskAssigned:
		kind = events.KindTaskAssigned
		text = taskAssignedText(ev.SenderUsername, ev.Title)
	case events.TypeTaskAcknowledged:
		kind = events.KindTaskAcknowledged
		text = "Task acknowledged by " + ev.AssigneeUsername
	case events.TypeTaskCompleted:
		kind = events.KindTaskCompleted
		text = "Task completed by " + ev.AssigneeUsername
	case events.TypeTaskIgnored:
		kind = events.KindTaskIgnored
		text = "Task ignored by " + ev.AssigneeUsername
	case events.TypeTaskLeft:
		kind = events.KindTaskLeft
		text = "Task left by " + ev.AssigneeUsername
	case events.TypeTaskWithdrawn:
		kind = events.KindTaskWithdrawn
		text = "Task allocation withdrawn"
	default:
		return nil // ignore other event types
	}

	var taskID *string
	if ev.TaskID != "" {
		t := ev.TaskID
		taskID = &t
	}

	recipientID := ev.SenderID
	if ev.Type == events.TypeTaskAssigned {
		recipientID = ev.AssigneeID
	}
	if ev.Type == events.TypeTaskWithdrawn {
		recipientID = ev.AssigneeID
	}
	return c.create(ctx, tx, notification{
		sourceEventID: ev.EventID,
		sourceType:    ev.Type,
		orgID:         ev.OrgID,
		recipientID:   recipientID,
		kind:          kind,
		text:          text,
		taskID:        taskID,
	})
}

func taskAssignedText(sender, title string) string {
	if sender == "" {
		sender = "Someone"
	}
	if title == "" {
		return "New task from " + sender
	}
	return "New task from " + sender + ": " + title
}

// channelMemberJoined turns "somebody added you to a channel" into a
// notification. Emitted by messaging-svc on every join, so the two cases it has
// to tell apart are the whole job:
//
//   - Added BY SOMEONE ELSE — actorId != userId. The user has no other way of
//     finding out; a channel simply appears in their sidebar. This is the case
//     the notification exists for.
//   - SELF-join of an open channel — actorId == userId. They clicked Join.
//     Telling them about it is noise.
//
// An absent actorId means a producer older than the field. Treated as "unknown,
// so stay quiet", because the alternative is announcing to users that they were
// added to channels they joined themselves.
func (c *Consumer) channelMemberJoined(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.ChannelMemberJoined
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable channel.member.joined", "error", err)
		return errMalformed
	}
	if ev.UserID == "" || ev.ActorID == "" || ev.ActorID == ev.UserID {
		return nil
	}

	return c.create(ctx, tx, notification{
		sourceEventID: ev.EventID,
		sourceType:    ev.Type,
		orgID:         ev.OrgID,
		recipientID:   ev.UserID,
		kind:          events.KindChannelAdded,
		text:          channelAddedText(ev.ActorDisplayName, ev.ChannelName),
		channelID:     &ev.ChannelID,
	})
}

// channelAddedText is what the user reads in the bell.
//
// Actor and channel names are snapshots taken by the producer. Older events
// can lack the actor name, so retain a backward-compatible fallback.
func channelAddedText(actorDisplayName, channelName string) string {
	if actorDisplayName != "" && channelName != "" {
		return actorDisplayName + " added you to the channel " + channelName
	}
	if actorDisplayName != "" {
		return actorDisplayName + " added you to a channel"
	}
	if channelName == "" {
		return "You were added to a channel"
	}
	return "You were added to #" + channelName
}

func (c *Consumer) messageCreated(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.MessageCreated
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable message.created", "error", err)
		return errMalformed
	}
	if ev.Origin == "mail" || ev.Kind != "" || ev.SenderID == "" || ev.RecipientID == "" || ev.SenderID == ev.RecipientID {
		return nil
	}
	name := ev.SenderDisplayName
	if name == "" {
		name = ev.SenderUsername
	}
	conversationID, messageID := ev.ConversationID, ev.MessageID
	return c.create(ctx, tx, notification{
		sourceEventID:  ev.EventID,
		sourceType:     ev.Type,
		orgID:          ev.OrgID,
		recipientID:    ev.RecipientID,
		kind:           events.KindDMMessage,
		text:           messageText(name, ev.Body),
		conversationID: &conversationID,
		messageID:      &messageID,
	})
}

func (c *Consumer) channelMessageCreated(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.ChannelMessageCreated
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable channel.message.created", "error", err)
		return errMalformed
	}
	if ev.Kind == "channel_created" {
		return c.channelCreated(ctx, tx, ev)
	}
	if ev.Kind != "" || ev.SenderID == "" {
		return nil
	}
	name := ev.SenderDisplayName
	if name == "" {
		name = ev.SenderUsername
	}
	text := channelMessageText(name, ev.ChannelName, ev.Body)
	for _, memberID := range ev.Members {
		if memberID == "" || memberID == ev.SenderID {
			continue
		}
		channelID, messageID := ev.ChannelID, ev.MessageID
		dedupID := uuid.NewSHA1(uuid.NameSpaceURL, []byte(ev.EventID+":"+memberID)).String()
		if err := c.create(ctx, tx, notification{
			sourceEventID: ev.EventID,
			dedupEventID:  dedupID,
			sourceType:    ev.Type,
			orgID:         ev.OrgID,
			recipientID:   memberID,
			kind:          events.KindChannelMessage,
			text:          text,
			channelID:     &channelID,
			messageID:     &messageID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// channelCreated notifies every member a channel was created with, other than
// its creator, once. The event is the "<creator> created channel <name>" system
// message's, which messaging-svc appends in the same transaction as the members
// themselves, so it lists exactly the people seeded at creation. Creation emits
// no channel.member.joined, so nobody is told twice; the people added LATER are
// told by channelMemberJoined. A redelivered event dedups per (event, member).
func (c *Consumer) channelCreated(ctx context.Context, tx pgx.Tx, ev events.ChannelMessageCreated) error {
	if ev.SenderID == "" {
		return nil
	}
	name := ev.SenderDisplayName
	if name == "" {
		name = ev.SenderUsername
	}
	channelID, messageID := ev.ChannelID, ev.MessageID
	for _, memberID := range ev.Members {
		if memberID == "" || memberID == ev.SenderID {
			continue
		}
		dedupID := uuid.NewSHA1(uuid.NameSpaceURL, []byte(ev.EventID+":"+memberID)).String()
		if err := c.create(ctx, tx, notification{
			sourceEventID: ev.EventID,
			dedupEventID:  dedupID,
			sourceType:    ev.Type,
			orgID:         ev.OrgID,
			recipientID:   memberID,
			kind:          events.KindChannelCreated,
			text:          channelCreatedText(name, ev.ChannelName),
			channelID:     &channelID,
			messageID:     &messageID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// channelCreatedText is what a member reads in the bell for a channel that was
// created with them in it. It says they were ADDED to a NEW channel, which is the
// news; "X created the channel" alone would not tell them it concerns them.
func channelCreatedText(actor, channel string) string {
	if actor == "" {
		actor = "Someone"
	}
	if channel == "" {
		return actor + " added you to a new channel"
	}
	return actor + " added you to the new channel " + channel
}

func (c *Consumer) callNotification(ctx context.Context, tx pgx.Tx, value []byte) error {
	var ev events.CallLifecycle
	if err := json.Unmarshal(value, &ev); err != nil {
		c.log.Warn("unparseable call notification event", "error", err)
		return errMalformed
	}
	kind, text, linksCall := callNotice(ev)
	if kind == "" {
		return nil // e.g. a call that ended normally: nothing to tell anyone
	}
	if ev.CallID == "" || ev.Kind == "" {
		return errMalformed
	}
	var callID *string
	if linksCall {
		id := ev.CallID
		callID = &id
	}
	for _, recipientID := range ev.Members {
		if recipientID == "" || recipientID == ev.ActorID {
			continue
		}
		dedupID := uuid.NewSHA1(uuid.NameSpaceURL, []byte(ev.EventID+":"+recipientID)).String()
		if err := c.create(ctx, tx, notification{
			sourceEventID: ev.EventID,
			dedupEventID:  dedupID,
			sourceType:    ev.Type,
			orgID:         ev.OrgID,
			recipientID:   recipientID,
			kind:          kind,
			text:          text,
			callID:        callID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// callNotice is what a call event says to a person, or "" when it says nothing.
//
// linksCall is false for a cancellation: the cancelled meeting's rows are deleted,
// so a link to its id would open nothing — the notification leads to the meetings
// list instead.
func callNotice(ev events.CallLifecycle) (kind, text string, linksCall bool) {
	switch ev.Type {
	case events.TypeCallScheduled:
		if ev.Change == events.CallChangeUpdated {
			return events.KindMeetingUpdated, callEventText("Meeting updated", ev.Title, ev.ScheduledAt), true
		}
		return events.KindMeetingScheduled, callNotificationText(ev.Title, ev.ScheduledAt), true
	case events.TypeCallRing:
		return events.KindMeetingInvite, callNotificationText(ev.Title, ev.ScheduledAt), true
	case events.TypeCallStarted:
		// Only a call that is actually under way. A started event for anything else
		// is a stale or reordered signal, not "your meeting is starting".
		if ev.Status != events.CallStatusLive {
			return "", "", false
		}
		return events.KindMeetingStarted, callEventText("Meeting started", ev.Title, ""), true
	case events.TypeCallEnded:
		// CANCELLED is a meeting withdrawn before it happened. An ordinary end (a
		// meeting that took place) is not something to notify about.
		if ev.Status != events.CallStatusCancelled {
			return "", "", false
		}
		return events.KindMeetingCancelled, callEventText("Meeting cancelled", ev.Title, ev.ScheduledAt), false
	}
	return "", "", false
}

// callEventText is "<what happened>: <title>[ · <when>]", with the same "Meeting"
// fallback title callNotificationText uses.
func callEventText(what, title, scheduledAt string) string {
	if title == "" {
		title = "Meeting"
	}
	if scheduledAt != "" {
		return what + ": " + title + " · " + scheduledAt
	}
	return what + ": " + title
}

func callNotificationText(title, scheduledAt string) string {
	if title == "" {
		title = "Meeting"
	}
	if scheduledAt != "" {
		return "Meeting scheduled: " + title + " · " + scheduledAt
	}
	return "Meeting invitation: " + title
}

func messageText(sender, body string) string {
	if sender == "" {
		return "New message: " + messagePreview(body)
	}
	return sender + ": " + messagePreview(body)
}

func channelMessageText(sender, channel, body string) string {
	if channel == "" {
		channel = "a channel"
	} else {
		channel = "#" + channel
	}
	if sender == "" {
		return "New message in " + channel + ": " + messagePreview(body)
	}
	return sender + " in " + channel + ": " + messagePreview(body)
}

func messagePreview(body string) string {
	// Before truncating, so the 140 runes are real content. messaging-svc
	// accepts a NUL in a body; Postgres text and jsonb cannot hold one.
	body = sanitizeText(body)
	if index := strings.IndexByte(body, 0x1f); index >= 0 {
		body = body[:index]
	}
	body = strings.TrimSpace(body)
	if body == "" {
		return "Sent an attachment"
	}
	runes := []rune(body)
	if len(runes) > 140 {
		return string(runes[:139]) + "…"
	}
	return body
}

// notification is one row to write plus the outbox event that announces it.
type notification struct {
	// sourceEventID is the id of the event that caused this, and is what the
	// dedup claims — NOT the notification's own id, which is minted here and is
	// therefore different on every redelivery.
	sourceEventID  string
	sourceType     string
	dedupEventID   string
	orgID          string
	recipientID    string
	kind           string
	text           string
	taskID         *string
	channelID      *string
	conversationID *string
	messageID      *string
	callID         *string
}

// create writes the notification row and its outbox event onto the caller's
// transaction, exactly once per source event.
//
// It does NOT commit: the caller batches many events into one tx (see
// runBatch), which is what keeps the round trips proportional to batches rather
// than to messages.
func (c *Consumer) create(ctx context.Context, tx pgx.Tx, n notification) error {
	// The single choke point every notification passes through: n.text is built
	// from producer-controlled strings (names, titles, bodies) and is written to
	// a text column and to the jsonb outbox payload, neither of which can hold a
	// NUL. See sanitizeText.
	n.text = sanitizeText(n.text)

	eventID, err := uuid.Parse(n.sourceEventID)
	if err != nil {
		// Malformed like any other bad payload — route through the same
		// dead-letter-then-commit path (errMalformed), not a silent success.
		// Returning nil here used to make this a full no-op: no DB row, no
		// DLQ entry, nothing but a log line — a producer regression shipping
		// a bad eventId would permanently and silently drop every affected
		// notification with no operational signal at all.
		c.log.Warn("invalid eventId, dead-lettering", "eventId", n.sourceEventID)
		return errMalformed
	}

	// org_id, recipient_id and task_id are all `uuid`-typed columns (see
	// 001_init.sql). A well-formed JSON event with a non-UUID or empty value
	// in any of them used to reach the INSERT below, which Postgres rejects
	// with 22P02 — an error indistinguishable here from a transient DB
	// failure, so runBatch treated it as one: abandon the batch, restart, and
	// redeliver the exact same unparseable value forever. Validating up front
	// and dead-lettering, same as the eventId check above, is what turns that
	// crash-loop into a bounded, logged skip.
	if _, err := uuid.Parse(n.orgID); err != nil {
		c.log.Warn("invalid orgId, dead-lettering", "eventId", n.sourceEventID, "orgId", n.orgID)
		return errMalformed
	}
	if _, err := uuid.Parse(n.recipientID); err != nil {
		c.log.Warn("invalid recipientId, dead-lettering", "eventId", n.sourceEventID, "recipientId", n.recipientID)
		return errMalformed
	}
	if n.taskID != nil {
		if _, err := uuid.Parse(*n.taskID); err != nil {
			c.log.Warn("invalid taskId, dead-lettering", "eventId", n.sourceEventID, "taskId", *n.taskID)
			return errMalformed
		}
	}
	if n.channelID != nil {
		if _, err := uuid.Parse(*n.channelID); err != nil {
			c.log.Warn("invalid channelId, dead-lettering", "eventId", n.sourceEventID, "channelId", *n.channelID)
			return errMalformed
		}
	}
	if n.conversationID != nil {
		if _, err := uuid.Parse(*n.conversationID); err != nil {
			c.log.Warn("invalid conversationId, dead-lettering", "eventId", n.sourceEventID, "conversationId", *n.conversationID)
			return errMalformed
		}
	}
	if n.messageID != nil {
		if _, err := uuid.Parse(*n.messageID); err != nil {
			c.log.Warn("invalid messageId, dead-lettering", "eventId", n.sourceEventID, "messageId", *n.messageID)
			return errMalformed
		}
	}
	if n.callID != nil {
		if _, err := uuid.Parse(*n.callID); err != nil {
			c.log.Warn("invalid callId, dead-lettering", "eventId", n.sourceEventID, "callId", *n.callID)
			return errMalformed
		}
	}
	dedupID := eventID
	if n.dedupEventID != "" {
		dedupID, err = uuid.Parse(n.dedupEventID)
		if err != nil {
			c.log.Warn("invalid dedup event id, dead-lettering", "eventId", n.sourceEventID)
			return errMalformed
		}
	}

	// Dedup: claim this event id. If it already exists, skip. Within a batch
	// this also catches a duplicate that arrived twice in the SAME tx, because
	// the insert is visible to its own transaction.
	tag, err := tx.Exec(ctx,
		`INSERT INTO consumed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		dedupID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		c.log.Info("duplicate event skipped", "eventId", n.sourceEventID)
		return nil
	}

	notifID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO notifications (id, org_id, recipient_id, kind, text, task_id, channel_id, conversation_id, message_id, call_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		notifID, n.orgID, n.recipientID, n.kind, n.text, n.taskID, n.channelID, n.conversationID, n.messageID, n.callID)
	if err != nil {
		return err
	}

	outID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	nc := events.NotificationCreated{
		Type:           events.TypeNotificationCreated,
		EventID:        outID.String(),
		OrgID:          n.orgID,
		OccurredAt:     time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		NotificationID: notifID.String(),
		RecipientID:    n.recipientID,
		Kind:           n.kind,
		Text:           n.text,
		TaskID:         n.taskID,
		ChannelID:      n.channelID,
		ConversationID: n.conversationID,
		MessageID:      n.messageID,
		CallID:         n.callID,
	}
	payload, err := json.Marshal(nc)
	if err != nil {
		return err
	}
	if err := outbox.Enqueue(ctx, tx, outID, events.TopicNotification, n.recipientID, n.orgID, payload); err != nil {
		return err
	}

	// No Commit here — the batch owns it.
	c.log.Info("notification created",
		"type", n.sourceType, "notificationId", notifID.String(), "recipientId", n.recipientID)
	return nil
}

// purgeOrg deletes every notification belonging to a deleted organization.
//
// Idempotent, and deliberately not dedup-guarded: re-running it over an org
// that is already gone deletes nothing, which is a cheaper guarantee than
// tracking whether we have seen the event before.
func (c *Consumer) purgeOrg(ctx context.Context, tx pgx.Tx, orgID string) error {
	if orgID == "" {
		c.log.Warn("org.deleted with no orgId")
		return nil
	}
	tag, err := tx.Exec(ctx, `DELETE FROM notifications WHERE org_id = $1`, orgID)
	if err != nil {
		return err
	}
	// Unpublished outbox rows for this org must go too, or a notification
	// enqueued just before the org was deleted still gets published to
	// notification.events.v1 afterward — see 003_outbox_org_purge.sql. Only
	// unpublished rows: a published one already left the outbox's job behind
	// and is retention's concern, not purge's.
	outboxTag, err := tx.Exec(ctx,
		`DELETE FROM outbox WHERE org_id = $1 AND published_at IS NULL`, orgID)
	if err != nil {
		return err
	}
	c.log.Warn("org purged", "orgId", orgID,
		"notifications", tag.RowsAffected(), "outbox", outboxTag.RowsAffected())
	return nil
}
