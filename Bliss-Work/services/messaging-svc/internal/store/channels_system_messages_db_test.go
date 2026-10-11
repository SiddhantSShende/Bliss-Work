package store

// The system messages a channel writes about its own membership, against a real
// Postgres with RLS enforcing (opt-in via MESSAGING_TEST_DATABASE_URL — see
// calls_lifecycle_db_test.go's header for the harness).
//
//	creation        "<Creator> created channel <Name>"                  channel_created
//	                "<A>, <B> were added to channel" (ONE message)      channel_member_added
//	added later     "<Actor> added <A>, <B> to the channel" (ONE message) channel_member_added
//	removed         "<Actor> removed <User> from the channel"           channel_member_removed
//	left            "<User> left the channel"                           channel_member_left
//	self-join       "<User> joined the channel"                         channel_member_added
//
// These have to be DB tests: the properties that matter — seq order between the
// two creation messages, exactly-once under a racing double join, history left
// untouched — are facts about rows, not about any Go function's return value.

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

type systemMessage struct {
	seq      int64
	kind     string
	body     string
	senderID string
}

// channelSystemMessages returns every non-text message in the channel in seq
// order, decrypted.
func channelSystemMessages(t *testing.T, s *Store, orgID, channelID string) []systemMessage {
	t.Helper()
	ctx := context.Background()
	var out []systemMessage
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT seq, kind, sender_id::text, body_enc FROM channel_messages
			  WHERE channel_id = $1 AND kind <> 'text' ORDER BY seq`, channelID)
		if err != nil {
			return err
		}
		type raw struct {
			m   systemMessage
			enc []byte
		}
		var raws []raw
		for rows.Next() {
			var r raw
			if err := rows.Scan(&r.m.seq, &r.m.kind, &r.m.senderID, &r.enc); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range raws {
			body, err := s.crypto.Decrypt(ctx, tx, orgID, r.enc)
			if err != nil {
				return err
			}
			r.m.body = body
			out = append(out, r.m)
		}
		return nil
	}); err != nil {
		t.Fatalf("read system messages: %v", err)
	}
	return out
}

func requireMessages(t *testing.T, got []systemMessage, want ...systemMessage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d system messages %+v, want %d %+v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i].kind != want[i].kind || got[i].body != want[i].body {
			t.Errorf("message %d = %s %q, want %s %q", i, got[i].kind, got[i].body, want[i].kind, want[i].body)
		}
		if i > 0 && got[i].seq <= got[i-1].seq {
			t.Errorf("message %d seq %d is not after message %d seq %d", i, got[i].seq, i-1, got[i-1].seq)
		}
	}
}

func created(body string) systemMessage {
	return systemMessage{kind: MessageKindChannelCreated, body: body}
}
func added(body string) systemMessage {
	return systemMessage{kind: MessageKindChannelMemberAdded, body: body}
}

// newUsers seeds one projected user per display name and returns their ids in
// the same order. The ids are minted in the order given, so a test that wants
// "request order != id order" passes the ids in a different order itself.
func newUsers(t *testing.T, s *Store, orgID string, displayNames ...string) []string {
	t.Helper()
	ids := make([]string, len(displayNames))
	for i, name := range displayNames {
		ids[i] = uuid.Must(uuid.NewV7()).String()
		seedUser(t, s, orgID, ids[i], "user"+ids[i][len(ids[i])-6:], name)
	}
	return ids
}

func countChannelRows(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	var n int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, query, args...).Scan(&n)
	}); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// A. Creator only: one message, and no "added" message.
func TestCreateChannelCreatorOnlyWritesOnlyTheCreationMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe")

	ch, err := s.CreateChannel(ctx, orgID, u[0], "solo", false, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID), created("Jordan Doe created channel solo"))

	// The creator listing themselves is still "creator only".
	ch, err = s.CreateChannel(ctx, orgID, u[0], "solo-2", false, []string{u[0]})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID), created("Jordan Doe created channel solo-2"))
}

// B. One extra member: two messages, creation first, singular verb.
func TestCreateChannelOneMemberWritesCreationThenAddedMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee")

	ch, err := s.CreateChannel(ctx, orgID, u[0], "project room", false, []string{u[1]})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Jordan Doe created channel project room"),
		added("Alex Lee was added to channel"))
	for _, m := range msgs {
		if m.senderID != u[0] {
			t.Errorf("%s sender = %s, want the creator %s", m.kind, m.senderID, u[0])
		}
	}
}

// The creation message's event is what notification-svc turns into the "you were
// added to a new channel" notification, so it must name the channel and the
// creator's display name and list every member. Creation emits NO
// channel.member.joined — that event is the later-add path's notification, and
// emitting both would tell each member twice. The "added" message's event carries
// a kind, which notification-svc deliberately never notifies on.
func TestCreateChannelEmitsOneNotifiableCreationEvent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Bea Cho")
	creator, alex, bea := u[0], u[1], u[2]

	ch, err := s.CreateChannel(ctx, orgID, creator, "project room", false, []string{alex, bea})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	type creationEvent struct {
		Kind, ChannelName, SenderDisplayName, SenderID string
		Members                                        []string
	}
	var evs []creationEvent
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT payload->>'kind', COALESCE(payload->>'channelName',''), COALESCE(payload->>'senderDisplayName',''),
			        payload->>'senderId', ARRAY(SELECT jsonb_array_elements_text(payload->'members'))
			   FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2 ORDER BY (payload->>'seq')::bigint`,
			ch.ID, events.TypeChannelMessageCreated)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e creationEvent
			if err := rows.Scan(&e.Kind, &e.ChannelName, &e.SenderDisplayName, &e.SenderID, &e.Members); err != nil {
				return err
			}
			evs = append(evs, e)
		}
		return rows.Err()
	}); err != nil {
		t.Fatalf("read creation events: %v", err)
	}
	if len(evs) != 2 || evs[0].Kind != MessageKindChannelCreated || evs[1].Kind != MessageKindChannelMemberAdded {
		t.Fatalf("channel.message.created events = %+v, want exactly [channel_created, channel_member_added]", evs)
	}
	c := evs[0]
	if c.ChannelName != "project room" || c.SenderDisplayName != "Jordan Doe" || c.SenderID != creator {
		t.Errorf("creation event = %+v, want channel %q, creator %q (%s)", c, "project room", "Jordan Doe", creator)
	}
	if len(c.Members) != 3 {
		t.Errorf("creation event members = %v, want the creator and both added members", c.Members)
	}
	if n := countChannelRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		ch.ID, events.TypeChannelMemberJoined); n != 0 {
		t.Errorf("creation emitted %d channel.member.joined events, want 0 (the creation event notifies instead)", n)
	}
}

// C. Several members: still ONE added message, in request order, untruncated,
// and the creator is neither listed nor duplicated when they appear in the
// request or a member is repeated.
func TestCreateChannelManyMembersWritesOneAddedMessageInRequestOrder(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	// Minted alphabetically, requested as Zed, Amy, Bob — so neither id order
	// nor name order can accidentally produce the expected text.
	u := newUsers(t, s, orgID, "Jordan Doe", "Amy Adams", "Bob Brown", "Zed Zimmer")
	creator, amy, bob, zed := u[0], u[1], u[2], u[3]

	ch, err := s.CreateChannel(ctx, orgID, creator, "big room", false, []string{zed, amy, creator, bob, amy})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID),
		created("Jordan Doe created channel big room"),
		added("Zed Zimmer, Amy Adams, Bob Brown were added to channel"))
	if n := countChannelRows(t, s, `SELECT count(*) FROM channel_members WHERE channel_id = $1`, ch.ID); n != 4 {
		t.Errorf("channel members = %d, want 4", n)
	}

	// Not truncated: 60 members all appear.
	many := make([]string, 60)
	names := make([]string, 60)
	for i := range many {
		names[i] = "Member " + uuid.NewString()[:8]
	}
	ids := newUsers(t, s, orgID, names...)
	copy(many, ids)
	ch, err = s.CreateChannel(ctx, orgID, creator, "huge room", false, many)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	if len(msgs) != 2 {
		t.Fatalf("got %d system messages, want 2", len(msgs))
	}
	for _, n := range names {
		if !strings.Contains(msgs[1].body, n) {
			t.Fatalf("member %q missing from %q", n, msgs[1].body)
		}
	}
}

// A seeded member with no projection row yet reads as "Someone" — the same
// fallback as every other system message — rather than blocking creation.
func TestCreateChannelUnprojectedMemberReadsAsSomeone(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee")
	ghost := uuid.Must(uuid.NewV7()).String()
	// verifyMembersInOrg needs the member to exist in the org's projection, so
	// project the ghost with empty names.
	seedUser(t, s, orgID, ghost, "", "")

	ch, err := s.CreateChannel(ctx, orgID, u[0], "mixed", false, []string{u[1], ghost})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID),
		created("Jordan Doe created channel mixed"),
		added("Alex Lee, Someone were added to channel"))
}

// D, E, F. Members added later: ONE "<actor> added …" message per request,
// naming only the genuinely new members; re-adding an existing member (alone or
// mixed into a batch) adds nothing, and a request that adds nobody writes nothing.
func TestAddChannelMembersWritesOneMessageNamingEveryNewMember(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Bea Cho", "Cy Dunn")
	owner, alex, bea, cy := u[0], u[1], u[2], u[3]

	ch, err := s.CreateChannel(ctx, orgID, owner, "locked room", true, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	base := created("Jordan Doe created channel locked room")

	// D. One member.
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, owner, nil, []string{alex}); err != nil {
		t.Fatalf("AddChannelMembers: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID), base, added("Jordan Doe added Alex Lee to the channel"))

	// F. Re-adding the existing member writes nothing.
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, owner, nil, []string{alex}); err != nil {
		t.Fatalf("duplicate AddChannelMembers: %v", err)
	}
	requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID), base, added("Jordan Doe added Alex Lee to the channel"))

	// E + F. Two new members and one existing one: exactly ONE new message,
	// naming the two new people (in request order) and not the existing one.
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, owner, nil, []string{bea, alex, cy}); err != nil {
		t.Fatalf("batch AddChannelMembers: %v", err)
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs, base,
		added("Jordan Doe added Alex Lee to the channel"),
		added("Jordan Doe added Bea Cho, Cy Dunn to the channel"))

	// One ChannelMemberJoined (task fan-out) event per genuinely new member —
	// unchanged by the new messages.
	if n := countChannelRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		ch.ID, events.TypeChannelMemberJoined); n != 3 {
		t.Errorf("ChannelMemberJoined events = %d, want 3", n)
	}
}

// G. Self-join writes "<User> joined the channel", sent by the joiner, in the
// same transaction as the membership row and with the live-fan-out event every
// other message has — and ONLY system kinds, so notification-svc stays quiet.
func TestJoinChannelWritesJoinedMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee")

	ch, err := s.CreateChannel(ctx, orgID, u[0], "open room", false, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := s.JoinChannel(ctx, orgID, ch.ID, u[1]); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Jordan Doe created channel open room"),
		added("Alex Lee joined the channel"))
	if msgs[1].senderID != u[1] {
		t.Errorf("join message sender = %s, want the joiner %s", msgs[1].senderID, u[1])
	}
	// The joiner is already a member when the live event is built, so they see
	// their own join.
	if n := countChannelRows(t, s,
		`SELECT count(*) FROM outbox
		  WHERE kafka_key = $1 AND payload->>'type' = $2 AND payload->>'kind' = $3
		    AND payload->'members' @> jsonb_build_array($4::text)`,
		ch.ID, events.TypeChannelMessageCreated, MessageKindChannelMemberAdded, u[1]); n != 1 {
		t.Errorf("join message fan-out rows reaching the joiner = %d, want 1", n)
	}

	// Joining again is a no-op: no second message, no second event.
	if err := s.JoinChannel(ctx, orgID, ch.ID, u[1]); err != nil {
		t.Fatalf("repeat JoinChannel: %v", err)
	}
	if got := channelSystemMessages(t, s, orgID, ch.ID); len(got) != 2 {
		t.Errorf("repeat join left %d system messages, want 2", len(got))
	}
	if n := countChannelRows(t, s,
		`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
		ch.ID, events.TypeChannelMemberJoined); n != 1 {
		t.Errorf("ChannelMemberJoined events = %d, want 1", n)
	}

	// Leave and join again is a new join, so it is announced again.
	if err := s.LeaveChannel(ctx, orgID, ch.ID, u[1]); err != nil {
		t.Fatalf("LeaveChannel: %v", err)
	}
	if err := s.JoinChannel(ctx, orgID, ch.ID, u[1]); err != nil {
		t.Fatalf("re-JoinChannel: %v", err)
	}
	got := channelSystemMessages(t, s, orgID, ch.ID)
	last := got[len(got)-1]
	if last.body != "Alex Lee joined the channel" || last.kind != MessageKindChannelMemberAdded {
		t.Errorf("rejoin last message = %s %q", last.kind, last.body)
	}
	joined := 0
	for _, m := range got {
		if m.body == "Alex Lee joined the channel" {
			joined++
		}
	}
	if joined != 2 {
		t.Errorf("join messages after leave+rejoin = %d, want 2", joined)
	}
}

// H. A racing double (or eight-fold) self-join: one membership, one message,
// one fan-out event. The pre-INSERT existence check cannot give this — every
// racer reads "not a member" — only the INSERT's own affected-row count can.
func TestJoinChannelConcurrentDoubleJoinWritesOneMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee")

	for round := 0; round < 5; round++ {
		ch, err := s.CreateChannel(ctx, orgID, u[0], "race room", false, nil)
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		const racers = 8
		start := make(chan struct{})
		errs := make([]error, racers)
		var wg sync.WaitGroup
		for i := 0; i < racers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				errs[i] = s.JoinChannel(ctx, orgID, ch.ID, u[1])
			}(i)
		}
		close(start)
		wg.Wait()
		for i, err := range errs {
			if err != nil {
				t.Fatalf("round %d racer %d: %v", round, i, err)
			}
		}

		if n := countChannelRows(t, s,
			`SELECT count(*) FROM channel_members WHERE channel_id = $1 AND user_id = $2`, ch.ID, u[1]); n != 1 {
			t.Fatalf("round %d: memberships = %d, want 1", round, n)
		}
		requireMessages(t, channelSystemMessages(t, s, orgID, ch.ID),
			created("Jordan Doe created channel race room"),
			added("Alex Lee joined the channel"))
		if n := countChannelRows(t, s,
			`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
			ch.ID, events.TypeChannelMemberJoined); n != 1 {
			t.Fatalf("round %d: ChannelMemberJoined events = %d, want 1", round, n)
		}
	}
}

// Attribution. sender_id is the authenticated principal that CAUSED the write,
// because telemetry credits it with a "channel.message.sent", delete-for-all
// lets it retract the row without moderator rights, and the unread and
// last-sender queries treat it as the one who just acted. So:
//
//	creation notices     sender = the creator (both of them)
//	added by someone     sender = the adder; the added user is named in the text
//	                     and as userId/actorId on the ChannelMemberJoined event
//	self-join            sender = the joiner (they are the caller)
//
// Making an added user the sender of "<Actor> added <User> to the channel" would credit
// them with an action they never took and hand them the right to delete the
// notice of their own addition; the second half of this test pins that.
func TestSystemMessageSenderIsThePrincipalWhoCausedTheWrite(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Bea Cho", "Cy Dunn")
	owner, alex, bea, cy := u[0], u[1], u[2], u[3]

	// Creation: both notices are the creator's, even when several users are named.
	ch, err := s.CreateChannel(ctx, orgID, owner, "attrib room", true, []string{alex, bea})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgs := channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Jordan Doe created channel attrib room"),
		added("Alex Lee, Bea Cho were added to channel"))
	for _, m := range msgs {
		if m.senderID != owner {
			t.Errorf("%s sender = %s, want the creator %s", m.kind, m.senderID, owner)
		}
	}

	// Added by someone else: sender is the adder, the subject is Cy.
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, owner, nil, []string{cy}); err != nil {
		t.Fatalf("AddChannelMembers: %v", err)
	}
	msgs = channelSystemMessages(t, s, orgID, ch.ID)
	requireMessages(t, msgs,
		created("Jordan Doe created channel attrib room"),
		added("Alex Lee, Bea Cho were added to channel"),
		added("Jordan Doe added Cy Dunn to the channel"))
	join := msgs[2]
	if join.senderID != owner {
		t.Errorf("added-by-other join message sender = %s, want the adder %s (not the added user %s)", join.senderID, owner, cy)
	}
	var evUser, evActor, evSender string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT payload->>'userId', payload->>'actorId' FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2 AND payload->>'userId' = $3`,
			ch.ID, events.TypeChannelMemberJoined, cy).Scan(&evUser, &evActor); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT payload->>'senderId' FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2 AND payload->>'seq' = $3`,
			ch.ID, events.TypeChannelMessageCreated, strconv.FormatInt(join.seq, 10)).Scan(&evSender)
	}); err != nil {
		t.Fatalf("read events: %v", err)
	}
	if evUser != cy || evActor != owner {
		t.Errorf("ChannelMemberJoined userId/actorId = %s/%s, want %s/%s", evUser, evActor, cy, owner)
	}
	if evSender != owner {
		t.Errorf("live message event senderId = %s, want the adder %s", evSender, owner)
	}

	// The added user cannot retract the notice of their own addition: it is not
	// theirs. (Had they been its sender, this plain-member batch would delete it.)
	var joinID string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT id::text FROM channel_messages WHERE channel_id = $1 AND seq = $2`, ch.ID, join.seq).Scan(&joinID)
	}); err != nil {
		t.Fatalf("read join message id: %v", err)
	}
	res, err := s.DeleteChannelMessagesForAll(ctx, orgID, cy, ch.ID, []string{joinID}, []string{})
	if err != nil {
		t.Fatalf("DeleteChannelMessagesForAll: %v", err)
	}
	if len(res.Deleted) != 0 || len(res.Skipped) != 1 {
		t.Errorf("added user's delete of their own join notice: deleted=%v skipped=%v, want it skipped", res.Deleted, res.Skipped)
	}

	// Self-join: the joiner is the caller, so the joiner is the sender, and the
	// event's actor is the user themselves (which notification-svc reads as "quiet").
	open, err := s.CreateChannel(ctx, orgID, owner, "open attrib room", false, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := s.JoinChannel(ctx, orgID, open.ID, alex); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	got := channelSystemMessages(t, s, orgID, open.ID)
	requireMessages(t, got,
		created("Jordan Doe created channel open attrib room"),
		added("Alex Lee joined the channel"))
	if got[0].senderID != owner || got[1].senderID != alex {
		t.Errorf("senders = %s/%s, want creator %s / joiner %s", got[0].senderID, got[1].senderID, owner, alex)
	}
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT payload->>'userId', payload->>'actorId' FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2`,
			open.ID, events.TypeChannelMemberJoined).Scan(&evUser, &evActor)
	}); err != nil {
		t.Fatalf("read self-join event: %v", err)
	}
	if evUser != alex || evActor != alex {
		t.Errorf("self-join userId/actorId = %s/%s, want both %s", evUser, evActor, alex)
	}
}

// I. Existing channels keep their history byte for byte: a legacy-worded
// message is neither rewritten nor re-sequenced by later membership changes.
func TestMembershipChangesLeaveExistingHistoryUntouched(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Bea Cho")
	owner, alex, bea := u[0], u[1], u[2]

	// A channel as it existed before this change: old wording, old per-user
	// "added" wording, written straight into the tables.
	chanID := uuid.Must(uuid.NewV7()).String()
	legacy := []struct{ kind, body string }{
		{MessageKindChannelCreated, "Jordan Doe created channel legacy room"},
		{MessageKindChannelMemberAdded, "Jordan Doe added Someone to the channel"},
	}
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, is_locked, created_by, seq_counter) VALUES ($1,$2,'legacy room',false,$3,$4)`,
			chanID, orgID, owner, len(legacy)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id, role) VALUES ($1,$2,$3,'owner')`,
			chanID, orgID, owner); err != nil {
			return err
		}
		for i, m := range legacy {
			enc, err := s.crypto.Encrypt(ctx, tx, orgID, m.body)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, body_enc, client_msg_id, kind)
				 VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)`,
				uuid.Must(uuid.NewV7()).String(), orgID, chanID, i+1, owner, enc,
				uuid.Must(uuid.NewV7()).String(), m.kind); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed legacy channel: %v", err)
	}

	snapshot := func() []string {
		var rows []string
		if err := s.withBypass(ctx, func(tx pgx.Tx) error {
			r, err := tx.Query(ctx,
				`SELECT id::text || '|' || seq || '|' || kind || '|' || sender_id::text || '|' || client_msg_id::text || '|' || encode(body_enc, 'hex')
				   FROM channel_messages WHERE channel_id = $1 AND seq <= $2 ORDER BY seq`, chanID, len(legacy))
			if err != nil {
				return err
			}
			defer r.Close()
			for r.Next() {
				var row string
				if err := r.Scan(&row); err != nil {
					return err
				}
				rows = append(rows, row)
			}
			return r.Err()
		}); err != nil {
			t.Fatalf("snapshot: %v", err)
		}
		return rows
	}
	before := snapshot()
	if len(before) != len(legacy) {
		t.Fatalf("seeded %d legacy rows, want %d", len(before), len(legacy))
	}

	if err := s.AddChannelMembers(ctx, orgID, chanID, owner, nil, []string{alex}); err != nil {
		t.Fatalf("AddChannelMembers: %v", err)
	}
	if err := s.JoinChannel(ctx, orgID, chanID, bea); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}

	after := snapshot()
	for i := range before {
		if before[i] != after[i] {
			t.Errorf("legacy message %d changed:\n before %s\n after  %s", i+1, before[i], after[i])
		}
	}
	got := channelSystemMessages(t, s, orgID, chanID)
	requireMessages(t, got, created(legacy[0].body), added(legacy[1].body),
		added("Jordan Doe added Alex Lee to the channel"), added("Bea Cho joined the channel"))
}
