package store

// The system messages a channel writes when its membership changes, end to end
// at the database: persisted in the channel's own message store, exactly when
// the change itself committed, once, and addressed (via the outbox event the
// realtime gateway fans out) to the right people.
//
//	created   "<Actor> created channel <Name>"             channel_created
//	added     "<Actor> added <A>, <B> to the channel"      channel_member_added   (ONE per request)
//	removed   "<Actor> removed <User> from the channel"    channel_member_removed (kick, block)
//	left      "<User> left the channel"                    channel_member_left
//
// Opt-in against a real Postgres, non-superuser role — see
// calls_lifecycle_db_test.go's header. Uses the helpers of
// channels_system_messages_db_test.go.

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

func removed(body string) systemMessage {
	return systemMessage{kind: MessageKindChannelMemberRemoved, body: body}
}
func left(body string) systemMessage {
	return systemMessage{kind: MessageKindChannelMemberLeft, body: body}
}

// realtimeRecipients is who the outbox event for the message at seq addresses —
// the list ws-gateway delivers channel.message.created to — plus the event's
// kind and body, which is what the client renders from.
func realtimeRecipients(t *testing.T, s *Store, channelID string, seq int64) (members []string, kind, body string) {
	t.Helper()
	ctx := context.Background()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		var raw []string
		err := tx.QueryRow(ctx, `
			SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(payload->'members')), '{}'),
			       COALESCE(payload->>'kind', ''), payload->>'body'
			  FROM outbox
			 WHERE kafka_key = $1 AND payload->>'type' = $2 AND (payload->>'seq')::bigint = $3`,
			channelID, events.TypeChannelMessageCreated, seq).Scan(&raw, &kind, &body)
		members = raw
		return err
	}); err != nil {
		t.Fatalf("read realtime event for seq %d: %v", seq, err)
	}
	return members, kind, body
}

func sameSet(a, b []string) bool {
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}

func noticeCount(t *testing.T, s *Store, channelID string) int {
	t.Helper()
	return countChannelRows(t, s,
		`SELECT count(*) FROM channel_messages WHERE channel_id = $1 AND kind <> 'text'`, channelID)
}

func isMember(t *testing.T, s *Store, channelID, userID string) bool {
	t.Helper()
	return countChannelRows(t, s,
		`SELECT count(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2`, channelID, userID) == 1
}

// A + H. Creation: the channel, its members and the creation message are one
// transaction, so the message is there the first time any member opens it — read
// here through the same ChannelMessages a client calls — and is still there on
// every later read, in order, for every initial member.
func TestChannelCreationMessageIsPersistedAndVisibleToEveryInitialMember(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy")
	piyush, rahul, sam := u[0], u[1], u[2]

	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, []string{rahul, sam})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if !isMember(t, s, ch.ID, piyush) || !isMember(t, s, ch.ID, rahul) || !isMember(t, s, ch.ID, sam) {
		t.Fatal("not every initial member was seated")
	}

	for _, viewer := range []string{piyush, rahul, sam} {
		for reload := 0; reload < 2; reload++ { // open, then reopen
			msgs, err := s.ChannelMessages(ctx, orgID, ch.ID, viewer, 0, 50)
			if err != nil {
				t.Fatalf("ChannelMessages as %s: %v", viewer, err)
			}
			if len(msgs) != 2 || msgs[0].Kind != MessageKindChannelCreated ||
				msgs[0].Body != "Piyush Shah created channel test" || msgs[0].SenderID != piyush {
				t.Fatalf("as %s (read %d): %+v, want the creation message first, from the creator", viewer, reload, msgs)
			}
			if msgs[1].Seq <= msgs[0].Seq {
				t.Errorf("messages out of order: %d then %d", msgs[0].Seq, msgs[1].Seq)
			}
		}
	}
	// Realtime: the creation event addresses every initial member.
	members, kind, body := realtimeRecipients(t, s, ch.ID, 1)
	if !sameSet(members, []string{piyush, rahul, sam}) || kind != MessageKindChannelCreated ||
		body != "Piyush Shah created channel test" {
		t.Errorf("creation event = members %v kind %q body %q", members, kind, body)
	}
}

// B + G. Adding people: one message per request naming them all, from the actor;
// the new members read it from the history and the live event reaches them and
// the people already there.
func TestAddingMembersWritesOneActorMessageAndDeliversItToEveryone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy", "Tia Ng")
	piyush, rahul, sam, tia := u[0], u[1], u[2], u[3]

	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, []string{tia})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{rahul}); err != nil {
		t.Fatalf("add one: %v", err)
	}
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{rahul, sam}); err != nil { // rahul again + sam
		t.Fatalf("add two: %v", err)
	}
	if !isMember(t, s, ch.ID, rahul) || !isMember(t, s, ch.ID, sam) {
		t.Fatal("membership did not change")
	}

	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Piyush Shah created channel test"),
		added("Tia Ng was added to channel"),
		added("Piyush Shah added Rahul Rao to the channel"),
		added("Piyush Shah added Sam Roy to the channel"))
	for _, m := range msgs[2:] {
		if m.senderID != piyush {
			t.Errorf("%q sender = %s, want the actor %s", m.body, m.senderID, piyush)
		}
	}

	// Several people in one request: ONE message.
	extra := newUsers(t, s, orgID, "Una Vo", "Vik Wu")
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, extra); err != nil {
		t.Fatalf("add many: %v", err)
	}
	msgs = channelSystemMessages(t, s, orgID, ch.ID)
	if len(msgs) != 5 || msgs[4].body != "Piyush Shah added Una Vo, Vik Wu to the channel" {
		t.Fatalf("multi-add messages = %+v, want one new message naming both", msgs)
	}

	// Realtime: tia (already there) and the newcomers all get the live event.
	members, kind, body := realtimeRecipients(t, s, ch.ID, msgs[4].seq)
	want := append([]string{piyush, rahul, sam, tia}, extra...)
	if !sameSet(members, want) || kind != MessageKindChannelMemberAdded || body != msgs[4].body {
		t.Errorf("add event = members %v kind %q body %q", members, kind, body)
	}
	// A newcomer opening the channel sees it, in order, after what came before.
	hist, err := s.ChannelMessages(ctx, orgID, ch.ID, extra[0], 0, 50)
	if err != nil {
		t.Fatalf("ChannelMessages as newcomer: %v", err)
	}
	if len(hist) != 5 || hist[4].Body != msgs[4].body || !slices.IsSortedFunc(hist, func(a, b ChannelMessageDTO) int { return int(a.Seq - b.Seq) }) {
		t.Errorf("history as newcomer = %+v", hist)
	}
}

// C. Removing a member: the notice is the actor's, and goes to the people who
// remain — not to the person it is about, who is no longer in the channel.
func TestRemovingAMemberWritesTheNoticeForTheRemainingMembers(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy")
	piyush, rahul, sam := u[0], u[1], u[2]
	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, []string{rahul, sam})
	if err != nil {
		t.Fatal(err)
	}

	if err := s.KickChannelMember(ctx, orgID, ch.ID, piyush, rahul, nil); err != nil {
		t.Fatalf("KickChannelMember: %v", err)
	}
	if isMember(t, s, ch.ID, rahul) {
		t.Fatal("rahul is still a member")
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Piyush Shah created channel test"),
		added("Rahul Rao, Sam Roy were added to channel"),
		removed("Piyush Shah removed Rahul Rao from the channel"))
	if msgs[2].senderID != piyush {
		t.Errorf("removal notice sender = %s, want the actor %s", msgs[2].senderID, piyush)
	}
	members, kind, body := realtimeRecipients(t, s, ch.ID, msgs[2].seq)
	if !sameSet(members, []string{piyush, sam}) || kind != MessageKindChannelMemberRemoved || body != msgs[2].body {
		t.Errorf("removal event = members %v kind %q body %q, want delivery to piyush+sam only", members, kind, body)
	}
	// The removed user can no longer read the channel at all.
	if _, err := s.ChannelMessages(ctx, orgID, ch.ID, rahul, 0, 50); !errors.Is(err, ErrForbidden) {
		t.Errorf("removed member reading the channel = %v, want ErrForbidden", err)
	}
	// The remaining members read it back, still in order, after a "reload".
	hist, err := s.ChannelMessages(ctx, orgID, ch.ID, sam, 0, 50)
	if err != nil || len(hist) != 3 || hist[2].Kind != MessageKindChannelMemberRemoved {
		t.Fatalf("history as sam = %+v, %v", hist, err)
	}

	// Blocking removes too, and says so the same way.
	if err := s.BlockFromChannel(ctx, orgID, ch.ID, piyush, sam, "spam", nil); err != nil {
		t.Fatalf("BlockFromChannel: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID),
		created("Piyush Shah created channel test"),
		added("Rahul Rao, Sam Roy were added to channel"),
		removed("Piyush Shah removed Rahul Rao from the channel"),
		removed("Piyush Shah removed Sam Roy from the channel"))
	// Blocking someone who is not a member removes nobody and says nothing.
	if err := s.BlockFromChannel(ctx, orgID, ch.ID, piyush, rahul, "again", nil); err != nil {
		t.Fatalf("block non-member: %v", err)
	}
	if n := noticeCount(t, s, ch.ID); n != 4 {
		t.Errorf("notices after blocking a non-member = %d, want 4", n)
	}
}

// D. Leaving: "<member> left the channel", from the leaver, delivered to whoever
// is still in the channel (and not to the leaver).
func TestLeavingWritesTheNoticeForTheRemainingMembers(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy")
	piyush, rahul, sam := u[0], u[1], u[2]
	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", false, []string{rahul, sam})
	if err != nil {
		t.Fatal(err)
	}

	if err := s.LeaveChannel(ctx, orgID, ch.ID, rahul); err != nil {
		t.Fatalf("LeaveChannel: %v", err)
	}
	if isMember(t, s, ch.ID, rahul) {
		t.Fatal("rahul is still a member")
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Piyush Shah created channel test"),
		added("Rahul Rao, Sam Roy were added to channel"),
		left("Rahul Rao left the channel"))
	if msgs[2].senderID != rahul {
		t.Errorf("leave notice sender = %s, want the leaver %s", msgs[2].senderID, rahul)
	}
	members, kind, body := realtimeRecipients(t, s, ch.ID, msgs[2].seq)
	if !sameSet(members, []string{piyush, sam}) || kind != MessageKindChannelMemberLeft || body != "Rahul Rao left the channel" {
		t.Errorf("leave event = members %v kind %q body %q, want piyush+sam only", members, kind, body)
	}
	hist, err := s.ChannelMessages(ctx, orgID, ch.ID, piyush, 0, 50)
	if err != nil || len(hist) != 3 || hist[2].Body != "Rahul Rao left the channel" {
		t.Fatalf("history as piyush = %+v, %v", hist, err)
	}

	// Rejoining and leaving again is a genuinely new departure: a second notice.
	if err := s.JoinChannel(ctx, orgID, ch.ID, rahul); err != nil {
		t.Fatal(err)
	}
	if err := s.LeaveChannel(ctx, orgID, ch.ID, rahul); err != nil {
		t.Fatal(err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID),
		created("Piyush Shah created channel test"),
		added("Rahul Rao, Sam Roy were added to channel"),
		left("Rahul Rao left the channel"),
		added("Rahul Rao joined the channel"),
		left("Rahul Rao left the channel"))
}

// F. Retries and double submits write nothing the second time.
func TestRepeatedMembershipRequestsDoNotDuplicateNotices(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy")
	piyush, rahul, sam := u[0], u[1], u[2]
	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Creation is idempotent on its own deterministic id, too.
	before := noticeCount(t, s, ch.ID)

	for i := 0; i < 3; i++ {
		if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{rahul, sam}); err != nil {
			t.Fatalf("add #%d: %v", i, err)
		}
	}
	if n := noticeCount(t, s, ch.ID) - before; n != 1 {
		t.Errorf("3 identical adds wrote %d notices, want 1", n)
	}
	for i := 0; i < 3; i++ {
		if err := s.KickChannelMember(ctx, orgID, ch.ID, piyush, rahul, nil); err != nil {
			t.Fatalf("kick #%d: %v", i, err)
		}
	}
	if n := noticeCount(t, s, ch.ID) - before; n != 2 {
		t.Errorf("add + 3 identical removals wrote %d notices, want 2", n)
	}
	for i := 0; i < 3; i++ {
		if err := s.LeaveChannel(ctx, orgID, ch.ID, sam); err != nil {
			t.Fatalf("leave #%d: %v", i, err)
		}
	}
	if n := noticeCount(t, s, ch.ID) - before; n != 3 {
		t.Errorf("…and 3 identical leaves wrote %d notices in total, want 3", n)
	}
}

// F, concurrent: two racing leaves, two racing kicks and two racing adds each
// produce exactly one notice.
func TestConcurrentMembershipRequestsProduceOneNoticeEach(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy", "Tia Ng")
	piyush, rahul, sam, tia := u[0], u[1], u[2], u[3]
	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, []string{rahul, sam, tia})
	if err != nil {
		t.Fatal(err)
	}
	before := noticeCount(t, s, ch.ID)

	race := func(f func() error) {
		errs := make(chan error, 2)
		start := make(chan struct{})
		for i := 0; i < 2; i++ {
			go func() { <-start; errs <- f() }()
		}
		close(start)
		for i := 0; i < 2; i++ {
			if err := <-errs; err != nil {
				t.Fatalf("racer: %v", err)
			}
		}
	}
	race(func() error { return s.LeaveChannel(ctx, orgID, ch.ID, rahul) })
	race(func() error { return s.KickChannelMember(ctx, orgID, ch.ID, piyush, sam, nil) })
	race(func() error { return s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{rahul}) })
	if n := noticeCount(t, s, ch.ID) - before; n != 3 {
		t.Errorf("one leave, one removal, one add, each raced twice, wrote %d notices, want 3", n)
	}
}

// E. A change that does not happen leaves no notice behind — and, being one
// transaction, a notice that cannot be written takes its change with it.
func TestFailedMembershipOperationsWriteNoNotice(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy", "Tia Ng")
	piyush, rahul, sam, tia := u[0], u[1], u[2], u[3]
	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, []string{rahul, sam})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.BlockFromChannel(ctx, orgID, ch.ID, piyush, tia, "no", nil); err != nil {
		t.Fatal(err)
	}
	before := noticeCount(t, s, ch.ID)

	outsider := uuid.Must(uuid.NewV7()).String() // no projection row in this org
	// Add: not a manager; a blocked user; a user outside the org. Whole request refused.
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, rahul, nil, []string{tia}); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-manager add = %v, want ErrForbidden", err)
	}
	fresh := newUsers(t, s, orgID, "Una Vo")[0]
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{fresh, tia}); !errors.Is(err, ErrForbidden) {
		t.Errorf("add including a blocked user = %v, want ErrForbidden", err)
	}
	if isMember(t, s, ch.ID, fresh) {
		t.Error("a refused batch still seated its other member")
	}
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{outsider}); err == nil {
		t.Error("add of a user outside the org succeeded")
	}
	// Remove: not a manager; yourself; the owner; an admin by a non-owner.
	if err := s.KickChannelMember(ctx, orgID, ch.ID, rahul, sam, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("non-manager kick = %v, want ErrForbidden", err)
	}
	if err := s.KickChannelMember(ctx, orgID, ch.ID, piyush, piyush, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("self kick = %v, want ErrForbidden", err)
	}
	if err := s.KickChannelMember(ctx, orgID, ch.ID, piyush, outsider, nil); err != nil {
		t.Errorf("kick of a non-member = %v, want a quiet no-op", err)
	}
	// Leave: someone who was never in the channel.
	if err := s.LeaveChannel(ctx, orgID, ch.ID, tia); err != nil {
		t.Errorf("leave by a non-member = %v, want a quiet no-op", err)
	}
	if n := noticeCount(t, s, ch.ID); n != before {
		t.Errorf("failed operations left %d new notices", n-before)
	}

	// Create: a member outside the org fails the whole creation — no channel, and
	// no creation message anywhere for it.
	msgsBefore := countChannelRows(t, s, `SELECT count(*) FROM channel_messages WHERE org_id = $1`, orgID)
	chansBefore := countChannelRows(t, s, `SELECT count(*) FROM channels WHERE org_id = $1`, orgID)
	if _, err := s.CreateChannel(ctx, orgID, piyush, "ghost", true, []string{outsider}); err == nil {
		t.Fatal("creating a channel with an outside member succeeded")
	}
	if n := countChannelRows(t, s, `SELECT count(*) FROM channels WHERE org_id = $1`, orgID); n != chansBefore {
		t.Errorf("failed create left %d channels", n-chansBefore)
	}
	if n := countChannelRows(t, s, `SELECT count(*) FROM channel_messages WHERE org_id = $1`, orgID); n != msgsBefore {
		t.Errorf("failed create left %d messages", n-msgsBefore)
	}
}

// H. The whole lifecycle reads back as one ordered history for a member who
// opens the channel fresh — and an ordinary message in the middle is untouched.
func TestMembershipNoticesStayInChronologicalOrderWithNormalMessages(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := newOrg()
	u := newUsers(t, s, orgID, "Piyush Shah", "Rahul Rao", "Sam Roy")
	piyush, rahul, sam := u[0], u[1], u[2]

	ch, err := s.CreateChannel(ctx, orgID, piyush, "test", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	steps := []func() error{
		func() error { return s.AddChannelMembers(ctx, orgID, ch.ID, piyush, nil, []string{rahul, sam}) },
		func() error {
			_, err := s.SendChannelMessage(ctx, orgID, ch.ID, rahul, "hello", uuid.NewString(), "", "", "")
			return err
		},
		func() error { return s.LeaveChannel(ctx, orgID, ch.ID, rahul) },
		func() error { return s.KickChannelMember(ctx, orgID, ch.ID, piyush, sam, nil) },
	}
	for i, step := range steps {
		if err := step(); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	// piyush is the only member left; he reads the lot.
	hist, err := s.ChannelMessages(ctx, orgID, ch.ID, piyush, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct{ kind, body string }{
		{MessageKindChannelCreated, "Piyush Shah created channel test"},
		{MessageKindChannelMemberAdded, "Piyush Shah added Rahul Rao, Sam Roy to the channel"},
		{"", "hello"},
		{MessageKindChannelMemberLeft, "Rahul Rao left the channel"},
		{MessageKindChannelMemberRemoved, "Piyush Shah removed Sam Roy from the channel"},
	}
	if len(hist) != len(want) {
		t.Fatalf("history = %+v, want %d entries", hist, len(want))
	}
	for i, w := range want {
		if hist[i].Body != w.body || hist[i].Kind != w.kind {
			t.Errorf("entry %d = %q %q, want %q %q", i, hist[i].Kind, hist[i].Body, w.kind, w.body)
		}
		if i > 0 && hist[i].Seq != hist[i-1].Seq+1 {
			t.Errorf("entry %d seq %d does not follow %d", i, hist[i].Seq, hist[i-1].Seq)
		}
	}
	// None of the notices can be forged by a client.
	for _, k := range []string{MessageKindChannelMemberRemoved, MessageKindChannelMemberLeft, MessageKindChannelMemberAdded, MessageKindChannelCreated} {
		if ValidMessageKind(k) {
			t.Errorf("%s is client-supplied; it must be server-authored only", k)
		}
	}
}
