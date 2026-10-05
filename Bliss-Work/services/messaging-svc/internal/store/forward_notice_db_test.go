package store

// The "<Forwarder> forwarded a message from this channel" notice a LOCKED
// channel gets when something that originated in it is forwarded, against a real
// Postgres with RLS enforcing (opt-in via MESSAGING_TEST_DATABASE_URL — see
// calls_lifecycle_db_test.go's header for the harness).
//
// These are DB tests because the properties that matter are facts about rows:
// exactly one notice per request however many destinations took part, none when
// the forward itself was refused or rolled back, and the chain walk that finds
// the ROOT's channel. The batch cases live in forward_notice_batch_db_test.go.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type forwardNoticeFx struct {
	t     *testing.T
	s     *Store
	orgID string
	// fiona forwards. mia is the other member of the private channel. olga is in
	// no channel. dan is the DM destination.
	fiona, mia, olga, dan string
	// priv is a LOCKED channel (fiona + mia); pub is an OPEN one (fiona + mia).
	priv, pub string
}

func newForwardNoticeFx(t *testing.T) *forwardNoticeFx {
	t.Helper()
	s := lifecycleStore(t)
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Fiona Forwarder", "Mia Member", "Olga Outsider", "Dan Dest")
	f := &forwardNoticeFx{t: t, s: s, orgID: orgID, fiona: u[0], mia: u[1], olga: u[2], dan: u[3]}
	f.priv = f.channel("security team", true, f.mia, f.fiona)
	f.pub = f.channel("town square", false, f.mia, f.fiona)
	return f
}

func (f *forwardNoticeFx) channel(name string, locked bool, creator string, members ...string) string {
	f.t.Helper()
	ch, err := f.s.CreateChannel(context.Background(), f.orgID, creator, name, locked, members)
	if err != nil {
		f.t.Fatalf("CreateChannel %s: %v", name, err)
	}
	return ch.ID
}

// post sends a plain message into a channel and returns its id.
func (f *forwardNoticeFx) post(channelID, sender, body string) string {
	f.t.Helper()
	res, err := f.s.SendChannelMessage(context.Background(), f.orgID, channelID, sender, body,
		uuid.Must(uuid.NewV7()).String(), "", "", "")
	if err != nil {
		f.t.Fatalf("SendChannelMessage: %v", err)
	}
	return res.MessageID
}

// notices is every forward notice in the channel, in seq order.
func (f *forwardNoticeFx) notices(channelID string) []systemMessage {
	f.t.Helper()
	var out []systemMessage
	for _, m := range channelSystemMessages(f.t, f.s, f.orgID, channelID) {
		if m.kind == MessageKindChannelForwardNotice {
			out = append(out, m)
		}
	}
	return out
}

func (f *forwardNoticeFx) wantNotices(channelID string, senders ...string) {
	f.t.Helper()
	got := f.notices(channelID)
	if len(got) != len(senders) {
		f.t.Fatalf("channel %s has %d forward notices %+v, want %d", channelID, len(got), got, len(senders))
	}
	for i, sender := range senders {
		if got[i].senderID != sender {
			f.t.Errorf("notice %d sender = %s, want %s", i, got[i].senderID, sender)
		}
		if !strings.HasSuffix(got[i].body, " forwarded a message from this channel") {
			f.t.Errorf("notice %d body = %q", i, got[i].body)
		}
	}
}

func (f *forwardNoticeFx) forward(forwarder, src string, target ForwardTarget, clientMsgID string) (*ForwardResult, error) {
	return f.s.ForwardMessage(context.Background(), f.orgID, forwarder, src, target, clientMsgID)
}

func chanTarget(id string) ForwardTarget { return ForwardTarget{Kind: ForwardTargetChannel, ID: id} }
func userTarget(id string) ForwardTarget { return ForwardTarget{Kind: ForwardTargetUser, ID: id} }
func newID() string                      { return uuid.Must(uuid.NewV7()).String() }

// A. A forward out of a locked channel posts exactly one notice, naming the
// forwarder, in that channel.
func TestForwardNotice_PrivateChannelPostsOneNotice(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	dest := f.channel("elsewhere", false, f.fiona)

	res, err := f.forward(f.fiona, src, chanTarget(dest), newID())
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	if res.MessageID == "" {
		t.Fatal("the forward itself did not deliver")
	}
	f.wantNotices(f.priv, f.fiona)
	if got := f.notices(f.priv)[0].body; got != "Fiona Forwarder forwarded a message from this channel" {
		t.Errorf("body = %q", got)
	}
	f.wantNotices(dest) // the destination is told nothing extra
}

// B. An open channel's messages keep their existing behaviour: no notice.
func TestForwardNotice_OpenChannelPostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.pub, f.mia, "town hall at 3")
	dest := f.channel("elsewhere", false, f.fiona)

	if _, err := f.forward(f.fiona, src, chanTarget(dest), newID()); err != nil {
		t.Fatalf("forward: %v", err)
	}
	f.wantNotices(f.pub)
}

// A DM message is not channel-originated either.
func TestForwardNotice_DMSourcePostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	seed, err := f.s.SendMessage(context.Background(), f.orgID, f.fiona, f.dan, "hi", newID(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := f.forward(f.fiona, seed.MessageID, chanTarget(f.pub), newID()); err != nil {
		t.Fatalf("forward: %v", err)
	}
	f.wantNotices(f.priv)
	f.wantNotices(f.pub)
}

// C. The notice goes to the channel the chain ORIGINATED in, however far the
// message has travelled, and never to an intermediate stop.
func TestForwardNotice_ChainThroughDMNotifiesOriginalPrivateChannel(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")

	// Hop 1: private channel -> Dan's DM.
	hop1, err := f.forward(f.fiona, src, userTarget(f.dan), newID())
	if err != nil {
		t.Fatalf("hop 1: %v", err)
	}
	f.wantNotices(f.priv, f.fiona)

	// Hop 2: the clone in that DM -> an open channel. Its own source is a DM,
	// and the open channel is a plain destination — but the root is private.
	dest := f.channel("elsewhere", false, f.fiona)
	if _, err := f.forward(f.fiona, hop1.MessageID, chanTarget(dest), newID()); err != nil {
		t.Fatalf("hop 2: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.fiona)
	f.wantNotices(dest) // no notice at the destination
	if n := countChannelRows(t, f.s,
		`SELECT count(*) FROM messages WHERE conversation_id = $1 AND kind = $2`,
		hop1.ConversationID, MessageKindChannelForwardNotice); n != 0 {
		t.Errorf("the intermediate DM got %d forward notices, want 0", n)
	}
}

// C'. A different person forwarding the clone onward is named, and is still not
// let into the private channel by doing so.
func TestForwardNotice_ChainHopByNonMemberNamesThemAndLeaksNothing(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	hop1, err := f.forward(f.fiona, src, userTarget(f.dan), newID())
	if err != nil {
		t.Fatalf("hop 1: %v", err)
	}

	// Dan is a party to that DM, not a member of priv.
	dest := f.channel("dans room", false, f.dan)
	if _, err := f.forward(f.dan, hop1.MessageID, chanTarget(dest), newID()); err != nil {
		t.Fatalf("hop 2 by dan: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.dan)
	if got := f.notices(f.priv)[1].body; got != "Dan Dest forwarded a message from this channel" {
		t.Errorf("body = %q", got)
	}
	if _, err := f.s.ChannelMessages(context.Background(), f.orgID, f.priv, f.dan, 0, 50); !errors.Is(err, ErrForbidden) {
		t.Errorf("a non-member read the private channel: err = %v", err)
	}
}

// C”. An OPEN channel in the middle of a chain that began in a locked one is not
// notified; one that began in an open channel never notifies anyone.
func TestForwardNotice_ChainThroughOpenChannelNotifiesOnlyTheRoot(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	hop1, err := f.forward(f.fiona, src, chanTarget(f.pub), newID())
	if err != nil {
		t.Fatalf("hop 1: %v", err)
	}
	dest := f.channel("elsewhere", false, f.fiona)
	if _, err := f.forward(f.fiona, hop1.MessageID, chanTarget(dest), newID()); err != nil {
		t.Fatalf("hop 2: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.fiona)
	f.wantNotices(f.pub)
	f.wantNotices(dest)

	// And the reverse: root in an open channel, intermediate stop locked.
	pubSrc := f.post(f.pub, f.mia, "lunch?")
	h1, err := f.forward(f.fiona, pubSrc, chanTarget(f.priv), newID())
	if err != nil {
		t.Fatalf("open->locked: %v", err)
	}
	if _, err := f.forward(f.fiona, h1.MessageID, chanTarget(dest), newID()); err != nil {
		t.Fatalf("locked->out: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.fiona) // unchanged: the root was open
}

// I. A retried single forward posts no second notice; a separate forward does.
func TestForwardNotice_RetryIsIdempotent(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	dest := f.channel("elsewhere", false, f.fiona)

	cmid := newID()
	first, err := f.forward(f.fiona, src, chanTarget(dest), cmid)
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	for i := 0; i < 3; i++ {
		again, err := f.forward(f.fiona, src, chanTarget(dest), cmid)
		if err != nil {
			t.Fatalf("retry %d: %v", i, err)
		}
		if again.MessageID != first.MessageID {
			t.Errorf("retry delivered a second clone")
		}
	}
	f.wantNotices(f.priv, f.fiona)

	// A genuinely new forward (new clientMsgId) is a new event and is announced.
	if _, err := f.forward(f.fiona, src, chanTarget(dest), newID()); err != nil {
		t.Fatalf("second forward: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.fiona)
}

// G. A refused forward — unauthorized source or destination — posts nothing.
func TestForwardNotice_RefusedForwardPostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")
	notMine := f.channel("not fiona's", false, f.mia)

	// Fiona may read the source but is not in the destination.
	if _, err := f.forward(f.fiona, src, chanTarget(notMine), newID()); !errors.Is(err, ErrForbidden) {
		t.Fatalf("forward to a channel she is not in: err = %v, want ErrForbidden", err)
	}
	// A user id from nowhere.
	if _, err := f.forward(f.fiona, src, userTarget(newID()), newID()); !errors.Is(err, ErrForbidden) {
		t.Fatalf("forward to an unknown user: err = %v, want ErrForbidden", err)
	}
	// Olga is not in the private channel, so she cannot forward from it at all —
	// and so cannot make it post anything.
	if _, err := f.forward(f.olga, src, userTarget(f.dan), newID()); !errors.Is(err, ErrForbidden) {
		t.Fatalf("outsider forward: err = %v, want ErrForbidden", err)
	}
	f.wantNotices(f.priv)
}

// J. Forwarding a message back into the channel it came from tells that channel
// nothing it cannot already see.
func TestForwardNotice_DestinationIsTheOriginalChannelPostsNone(t *testing.T) {
	f := newForwardNoticeFx(t)
	src := f.post(f.priv, f.mia, "the launch codes")

	res, err := f.forward(f.fiona, src, chanTarget(f.priv), newID())
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	if res.MessageID == "" {
		t.Fatal("the forward itself did not deliver")
	}
	f.wantNotices(f.priv)
}
