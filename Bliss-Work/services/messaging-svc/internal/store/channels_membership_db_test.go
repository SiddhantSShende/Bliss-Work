package store

// TestListOpenChannels: the Browse tab's directory query, against a real
// Postgres.
//
// This has to be a DB test, not a Go unit test, because the bug it exists to
// catch was invisible in Go: ListOpenChannels's SELECT list had drifted out
// of sync with scanRawChannelRows's Scan call — nine columns selected
// against ten destinations, missing last_message_sender. That compiles and
// vets clean; pgx only rejects the mismatch once it actually Scans a row, and
// with zero candidate channels the scan loop never runs, so the bug was
// invisible against an empty table too. Only a query that returns at least
// one real row exposes it — which is exactly this test's shape. See
// calls_lifecycle_db_test.go's header for the harness reused here (opt-in via
// MESSAGING_TEST_DATABASE_URL) and how to run it.
//
// The fixture also covers the two exclusions ListOpenChannels promises, so a
// regression there fails loudly rather than as a silently-too-permissive
// directory: a channel the caller already joined, and a locked channel,
// must both stay out of the result.

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

func TestListOpenChannels(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	memberID := uuid.Must(uuid.NewV7()).String()
	callerID := uuid.Must(uuid.NewV7()).String()

	openID := uuid.Must(uuid.NewV7()).String()   // unlocked, caller not a member — should be listed
	joinedID := uuid.Must(uuid.NewV7()).String() // unlocked, caller already a member — must not be listed
	lockedID := uuid.Must(uuid.NewV7()).String() // locked, caller not a member — must not be listed

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for _, c := range []struct {
			id       string
			isLocked bool
		}{{openID, false}, {joinedID, false}, {lockedID, true}} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channels (id, org_id, name, created_by, is_locked) VALUES ($1,$2,$3,$4,$5)`,
				c.id, orgID, "chan-"+c.id[:8], memberID, c.isLocked); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			openID, orgID, memberID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			joinedID, orgID, callerID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, client_msg_id)
			 VALUES ($1,$2,$3,1,$4,$5,$6)`,
			uuid.Must(uuid.NewV7()).String(), orgID, openID, memberID,
			"hello from the open channel", uuid.Must(uuid.NewV7()).String()); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES ($1,$2,$3,$4)`,
			memberID, orgID, "nadia", "Nadia Member"); err != nil {
			return err
		}
		return nil
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := s.ListOpenChannels(ctx, orgID, callerID, 50, 0)
	if err != nil {
		// This is the failure mode the bug produced: a pgx scan error
		// ("number of field descriptions must equal number of destinations")
		// the moment a candidate row actually needs scanning.
		t.Fatalf("ListOpenChannels: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d open channels, want 1 (the joined and locked channels must be excluded): %+v", len(got), got)
	}

	c := got[0]
	if c.ID != openID {
		t.Errorf("got channel %s, want %s", c.ID, openID)
	}
	if c.LastMessageSender != "Nadia Member" {
		t.Errorf("LastMessageSender = %q, want %q", c.LastMessageSender, "Nadia Member")
	}
	if c.IAmMember {
		t.Error("IAmMember = true for a channel the caller has not joined")
	}
	if c.IsLocked {
		t.Error("IsLocked = true for a channel seeded as unlocked")
	}
}

func TestCreateChannelPersistsSystemMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	creatorID := uuid.Must(uuid.NewV7()).String()
	memberID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, creatorID, "j.doe", "Jordan Doe")
	seedUser(t, s, orgID, memberID, "a.lee", "Alex Lee")

	channel, err := s.CreateChannel(ctx, orgID, creatorID, "project room", false, []string{memberID})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// The creation message only: the seeded member's "was added" message is its
	// own kind and is covered in channels_system_messages_db_test.go.
	var messageID, senderID, kind string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT id::text, sender_id::text, kind FROM channel_messages WHERE channel_id = $1 AND kind = $2`,
			channel.ID, MessageKindChannelCreated).
			Scan(&messageID, &senderID, &kind)
	}); err != nil {
		t.Fatalf("read system message: %v", err)
	}
	if got := decryptedBody(t, s, orgID, "channel_messages", "id", messageID); got != "Jordan Doe created the channel project room" {
		t.Errorf("system message = %q", got)
	}
	if senderID != creatorID || kind != MessageKindChannelCreated {
		t.Errorf("sender/kind = %q/%q, want %q/%q", senderID, kind, creatorID, MessageKindChannelCreated)
	}
	var memberCount int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM channel_members WHERE channel_id = $1`, channel.ID).Scan(&memberCount)
	}); err != nil {
		t.Fatalf("count channel members: %v", err)
	}
	if memberCount != 2 {
		t.Errorf("channel members = %d, want creator and seeded member", memberCount)
	}
	var fanoutCount int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2 AND payload->>'messageId' = $3
		    AND payload->'members' @> jsonb_build_array($4::text)
	    AND payload->'members' @> jsonb_build_array($5::text)`,
			channel.ID, events.TypeChannelMessageCreated, messageID, creatorID, memberID).Scan(&fanoutCount)
	}); err != nil {
		t.Fatalf("read creation-message fanout: %v", err)
	}
	if fanoutCount != 1 {
		t.Errorf("creation message fanout rows = %d, want one reaching every channel member", fanoutCount)
	}
}

func TestAddChannelMembersPersistsSingleSystemMessageAndJoinedEvent(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	actorID := uuid.Must(uuid.NewV7()).String()
	addedID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, actorID, "j.doe", "Jordan Doe")
	seedUser(t, s, orgID, addedID, "a.lee", "Alex Lee")

	channel, err := s.CreateChannel(ctx, orgID, actorID, "project room", true, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := s.AddChannelMembers(ctx, orgID, channel.ID, actorID, nil, []string{addedID}); err != nil {
		t.Fatalf("AddChannelMembers: %v", err)
	}
	if err := s.AddChannelMembers(ctx, orgID, channel.ID, actorID, nil, []string{addedID}); err != nil {
		t.Fatalf("duplicate AddChannelMembers: %v", err)
	}

	var messageID, senderID, kind string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT id::text, sender_id::text, kind FROM channel_messages
			  WHERE channel_id = $1 AND kind = $2`, channel.ID, MessageKindChannelMemberAdded).
			Scan(&messageID, &senderID, &kind)
	}); err != nil {
		t.Fatalf("read member-added system message: %v", err)
	}
	if got := decryptedBody(t, s, orgID, "channel_messages", "id", messageID); got != "Alex Lee joined the channel" {
		t.Errorf("system message = %q", got)
	}
	if senderID != actorID || kind != MessageKindChannelMemberAdded {
		t.Errorf("sender/kind = %q/%q, want %q/%q", senderID, kind, actorID, MessageKindChannelMemberAdded)
	}
	var messageCount, joinedCount, fanoutCount int
	var actorIDFromEvent, actorDisplayName, userIDFromEvent, channelName string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM channel_messages WHERE channel_id = $1 AND kind = $2`,
			channel.ID, MessageKindChannelMemberAdded).Scan(&messageCount); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM outbox WHERE kafka_key = $1 AND payload->>'type' = $2`,
			channel.ID, events.TypeChannelMemberJoined).Scan(&joinedCount); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2 AND payload->>'messageId' = $3
		    AND payload->'members' @> jsonb_build_array($4::text)
	    AND payload->'members' @> jsonb_build_array($5::text)`,
			channel.ID, events.TypeChannelMessageCreated, messageID, actorID, addedID).Scan(&fanoutCount); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`SELECT payload->>'actorId', payload->>'actorDisplayName', payload->>'userId', payload->>'channelName' FROM outbox
			  WHERE kafka_key = $1 AND payload->>'type' = $2`, channel.ID, events.TypeChannelMemberJoined).
			Scan(&actorIDFromEvent, &actorDisplayName, &userIDFromEvent, &channelName)
	}); err != nil {
		t.Fatalf("read member-added event state: %v", err)
	}
	if messageCount != 1 || joinedCount != 1 {
		t.Errorf("duplicate add wrote %d system messages and %d member events; want one each", messageCount, joinedCount)
	}
	if fanoutCount != 1 {
		t.Errorf("member-added message fanout rows = %d, want one reaching all channel members", fanoutCount)
	}
	if actorIDFromEvent != actorID || actorDisplayName != "Jordan Doe" || userIDFromEvent != addedID || channelName != "project room" {
		t.Errorf("event actor/name/user/channel = %q/%q/%q/%q", actorIDFromEvent, actorDisplayName, userIDFromEvent, channelName)
	}
}

// TestInternalChannelMembershipRequiresCallerMembership: task-svc's
// channel-mode task creation calls this to resolve fan-out recipients. It
// used to trust ANY channel id under the internal token alone — no check
// that the calling end user was a member of it — so any org member could
// name a private/locked channel they never joined and get a task (and its
// member roster) fanned out to it. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md.
func TestInternalChannelMembershipRequiresCallerMembership(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()

	orgID := uuid.Must(uuid.NewV7()).String()
	otherOrgID := uuid.Must(uuid.NewV7()).String()
	memberID := uuid.Must(uuid.NewV7()).String()
	outsiderID := uuid.Must(uuid.NewV7()).String() // same org, never joined the channel
	lockedChanID := uuid.Must(uuid.NewV7()).String()

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by, is_locked) VALUES ($1,$2,$3,$4,true)`,
			lockedChanID, orgID, "private-eng", memberID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			lockedChanID, orgID, memberID)
		return err
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// A genuine member can still resolve the roster (locked just means
	// "no self-join", not "hidden from its own members").
	got, err := s.InternalChannelMembership(ctx, orgID, lockedChanID, memberID)
	if err != nil {
		t.Fatalf("member resolving their own locked channel: %v", err)
	}
	if !got.IsLocked || len(got.MemberIDs) != 1 || got.MemberIDs[0] != memberID {
		t.Errorf("got %+v, want the single member and IsLocked=true", got)
	}

	// Same org, but never joined this channel — must be refused, not handed
	// the member list.
	if _, err := s.InternalChannelMembership(ctx, orgID, lockedChanID, outsiderID); err != ErrForbidden {
		t.Errorf("non-member same-org caller: got err %v, want ErrForbidden", err)
	}

	// A caller asserting the WRONG org for a real member of the channel must
	// also be refused — orgID is trusted from the caller's own JWT (via
	// task-svc), not derived from the channel row, so this is the check that
	// stops a cross-org probe.
	if _, err := s.InternalChannelMembership(ctx, otherOrgID, lockedChanID, memberID); err != ErrForbidden {
		t.Errorf("wrong-org caller: got err %v, want ErrForbidden", err)
	}

	// An id that isn't a channel at all in either org.
	if _, err := s.InternalChannelMembership(ctx, orgID, uuid.Must(uuid.NewV7()).String(), memberID); err != ErrForbidden {
		t.Errorf("nonexistent channel: got err %v, want ErrForbidden", err)
	}
}
