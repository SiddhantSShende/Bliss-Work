package store

// Batch forwarding and the forward notice — see forward_notice_db_test.go for
// the single-forward cases and the harness. The rule under test: ONE notice per
// original private channel per batch, however many messages and destinations,
// and none unless at least one destination actually took the forward.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

func (f *forwardNoticeFx) batch(forwarder string, ids []string, batchID string, targets ...ForwardTarget) ([]ForwardDestinationResult, error) {
	return f.s.ForwardMessages(context.Background(), f.orgID, forwarder, ids, targets, batchID)
}

// D + E. N messages x M destinations from one private channel: one notice.
func TestForwardNotice_BatchPostsOneNoticeNotNxM(t *testing.T) {
	f := newForwardNoticeFx(t)
	ids := []string{
		f.post(f.priv, f.mia, "one"), f.post(f.priv, f.mia, "two"), f.post(f.priv, f.mia, "three"),
	}
	targets := []ForwardTarget{
		chanTarget(f.channel("d1", false, f.fiona)), chanTarget(f.channel("d2", false, f.fiona)),
		chanTarget(f.channel("d3", false, f.fiona)), userTarget(f.dan),
	}

	results, err := f.batch(f.fiona, ids, newID(), targets...)
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	for _, r := range results {
		if r.Err != nil || len(r.MessageIDs) != 3 {
			t.Fatalf("destination %+v did not take all three", r)
		}
	}
	f.wantNotices(f.priv, f.fiona)
}

// D. One message to several destinations is one notice too.
func TestForwardNotice_OneMessageManyDestinationsPostsOne(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	if _, err := f.batch(f.fiona, []string{src}, newID(),
		chanTarget(f.channel("d1", false, f.fiona)), chanTarget(f.channel("d2", false, f.fiona)),
		userTarget(f.dan)); err != nil {
		t.Fatalf("batch: %v", err)
	}
	f.wantNotices(f.priv, f.fiona)
}

// F. A batch must come from ONE chat or channel, but the clones in that channel
// can trace back to different private channels: one notice per distinct root.
func TestForwardNotice_BatchWithTwoOriginalPrivateChannelsPostsOneEach(t *testing.T) {
	f := newForwardNoticeFx(t)
	priv2 := f.channel("finance", true, f.mia, f.fiona)
	hub := f.channel("hub", false, f.fiona)

	a, err := f.forward(f.fiona, f.post(f.priv, f.mia, "from security"), chanTarget(hub), newID())
	if err != nil {
		t.Fatalf("seed a: %v", err)
	}
	b, err := f.forward(f.fiona, f.post(priv2, f.mia, "from finance"), chanTarget(hub), newID())
	if err != nil {
		t.Fatalf("seed b: %v", err)
	}
	f.wantNotices(f.priv, f.fiona)
	f.wantNotices(priv2, f.fiona)

	if _, err := f.batch(f.fiona, []string{a.MessageID, b.MessageID}, newID(),
		chanTarget(f.channel("d1", false, f.fiona)), userTarget(f.dan)); err != nil {
		t.Fatalf("batch: %v", err)
	}
	// +1 each — not +2 (per message) and not +4 (per message x destination).
	f.wantNotices(f.priv, f.fiona, f.fiona)
	f.wantNotices(priv2, f.fiona, f.fiona)
	f.wantNotices(hub)
}

// G. Every destination failing posts nothing.
func TestForwardNotice_BatchWhereEveryDestinationFailsPostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	notMine := f.channel("not fiona's", false, f.mia)

	results, err := f.batch(f.fiona, []string{src}, newID(), chanTarget(notMine), userTarget(newID()))
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	for _, r := range results {
		if !errors.Is(r.Err, ErrForbidden) {
			t.Fatalf("destination %+v: err = %v, want ErrForbidden", r.Target, r.Err)
		}
	}
	f.wantNotices(f.priv)
}

// H. One destination succeeding is enough, wherever it sits in the list.
func TestForwardNotice_PartialBatchPostsOneNotice(t *testing.T) {
	f := newForwardNoticeFx(t)
	ids := []string{f.post(f.priv, f.mia, "one"), f.post(f.priv, f.mia, "two")}
	notMine := f.channel("not fiona's", false, f.mia)
	good := f.channel("good", false, f.fiona)

	results, err := f.batch(f.fiona, ids, newID(),
		chanTarget(notMine), chanTarget(good), userTarget(newID()))
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	if results[0].Err == nil || results[1].Err != nil || results[2].Err == nil {
		t.Fatalf("unexpected per-destination outcomes: %+v", results)
	}
	f.wantNotices(f.priv, f.fiona)
}

// I. A retried batch — whole, or after a partial failure — adds no second notice.
func TestForwardNotice_BatchRetryIsIdempotent(t *testing.T) {
	f := newForwardNoticeFx(t)
	ids := []string{f.post(f.priv, f.mia, "one"), f.post(f.priv, f.mia, "two")}
	notMine := f.channel("not fiona's", false, f.mia)
	good := f.channel("good", false, f.fiona)
	other := f.channel("other", false, f.fiona)

	batchID := newID()
	for i := 0; i < 3; i++ {
		if _, err := f.batch(f.fiona, ids, batchID, chanTarget(notMine), chanTarget(good), chanTarget(other)); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	f.wantNotices(f.priv, f.fiona)
	if n := countChannelRows(t, f.s,
		`SELECT count(*) FROM channel_messages WHERE channel_id = $1 AND is_forward`, good); n != 2 {
		t.Errorf("good destination holds %d clones after retries, want 2", n)
	}
}

// J. In a batch, a destination equal to the original channel is skipped for the
// notice, but another destination still earns one.
func TestForwardNotice_BatchIntoTheOriginalChannelAlonePostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")

	if _, err := f.batch(f.fiona, []string{src}, newID(), chanTarget(f.priv)); err != nil {
		t.Fatalf("batch: %v", err)
	}
	f.wantNotices(f.priv)

	if _, err := f.batch(f.fiona, []string{src}, newID(), chanTarget(f.priv), userTarget(f.dan)); err != nil {
		t.Fatalf("batch: %v", err)
	}
	f.wantNotices(f.priv, f.fiona)
}

// K. The notice, and the live event that carries it, say who and nothing more.
func TestForwardNotice_DoesNotRevealTheDestinationAndIsServerOnly(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	destCh := f.channel("secret destination", false, f.fiona)

	results, err := f.batch(f.fiona, []string{src}, newID(), chanTarget(destCh), userTarget(f.dan))
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	f.wantNotices(f.priv, f.fiona)

	// Everything that identifies a destination.
	secrets := []string{destCh, f.dan, "secret destination"}
	for _, r := range results {
		secrets = append(secrets, r.ConversationID, r.ChannelID)
		secrets = append(secrets, r.MessageIDs...)
	}

	if body := f.notices(f.priv)[0].body; body != "Fiona Forwarder forwarded a message from this channel" {
		t.Errorf("body = %q", body)
	}

	var payloads []string
	if err := f.s.withBypass(context.Background(), func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(),
			`SELECT payload::text FROM outbox
			  WHERE payload->>'type' = 'channel.message.created'
			    AND payload->>'channelId' = $1 AND payload->>'kind' = $2`,
			f.priv, MessageKindChannelForwardNotice)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p string
			if err := rows.Scan(&p); err != nil {
				return err
			}
			payloads = append(payloads, p)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	if len(payloads) != 1 {
		t.Fatalf("outbox holds %d notice events, want 1", len(payloads))
	}
	for _, s := range secrets {
		if s != "" && strings.Contains(payloads[0], s) {
			t.Errorf("notice event leaks %q: %s", s, payloads[0])
		}
	}

	// Routed to the private channel's own roster, and no one else.
	var evt struct {
		Members []string `json:"members"`
	}
	if err := json.Unmarshal([]byte(payloads[0]), &evt); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	got := map[string]bool{}
	for _, m := range evt.Members {
		got[m] = true
	}
	if len(got) != 2 || !got[f.fiona] || !got[f.mia] {
		t.Errorf("event members = %v, want exactly fiona and mia", evt.Members)
	}

	// Server-authored only: a client may not post this kind.
	if ValidMessageKind(MessageKindChannelForwardNotice) {
		t.Error("channel_forward_notice must not be client-postable")
	}
}
