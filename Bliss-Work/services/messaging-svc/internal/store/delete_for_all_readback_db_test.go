package store

// "Delete for everyone" must actually make the text unreadable, against a real
// Postgres with RLS enforcing.
//
// ── Why this needs a database ────────────────────────────────────────────────
// Deleting for everyone only stamps deleted_for_all_at and leaves body_enc where
// it is; the message endpoints then render a tombstone. The bug was in the paths
// that read the stored body directly and never looked at that column: the
// conversation and channel list previews (the "last message" line) and the
// forward-source lookup, which decrypts the body to clone it into another chat.
// An unsent message therefore kept showing as the last message to both people,
// and anyone who still had its id could forward it.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to run it.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func newClientID() string { return uuid.Must(uuid.NewV7()).String() }

func TestDeletedForAll_DM_PreviewFallsBackToTheNewestSurvivingMessage(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	first, err := s.SendMessage(ctx, orgID, alice, bob, "lunch at noon?", newClientID(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	secret, err := s.Reply(ctx, orgID, alice, first.ConversationID, "the merger is off, tell nobody", newClientID(), "")
	if err != nil {
		t.Fatalf("reply: %v", err)
	}
	if err := s.DeleteMessageForAll(ctx, orgID, alice, secret.MessageID); err != nil {
		t.Fatalf("delete for all: %v", err)
	}

	for name, viewer := range map[string]string{"sender": alice, "recipient": bob} {
		convs, err := s.ListConversations(ctx, orgID, viewer)
		if err != nil {
			t.Fatalf("%s ListConversations: %v", name, err)
		}
		var preview *string
		for _, c := range convs {
			if c.ID == first.ConversationID {
				preview = c.LastMessage
			}
		}
		if preview == nil {
			t.Fatalf("%s: conversation has no preview at all", name)
		}
		if *preview != "lunch at noon?" {
			t.Errorf("%s sees preview %q after the newest message was unsent, want %q", name, *preview, "lunch at noon?")
		}
	}
}

func TestDeletedForAll_DM_CannotBeForwarded(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	msg, err := s.SendMessage(ctx, orgID, alice, bob, "the merger is off, tell nobody", newClientID(), SendOptions{})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	// Control: while it stands, the recipient can resolve it as a forward source.
	if src, err := s.ForwardSourceResolve(ctx, orgID, bob, msg.MessageID); err != nil || src.Body == "" {
		t.Fatalf("control: resolving a live message = (%+v, %v)", src, err)
	}

	if err := s.DeleteMessageForAll(ctx, orgID, alice, msg.MessageID); err != nil {
		t.Fatalf("delete for all: %v", err)
	}

	src, err := s.ForwardSourceResolve(ctx, orgID, bob, msg.MessageID)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("resolving an unsent message = (%+v, %v), want ErrForbidden", src, err)
	}
}

func TestDeletedForAll_Channel_PreviewAndForward(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner, member := seedMessageUsers(t, s, orgID)
	browser := uuid.Must(uuid.NewV7()).String() // in the org, not in the channel
	seedUser(t, s, orgID, browser, "browser", "Browser")
	channelID := seedChannelWithRoles(t, s, orgID, owner, map[string]string{member: "member"})

	if _, err := s.SendChannelMessage(ctx, orgID, channelID, owner, "standup moved to 10", newClientID(), "", "", ""); err != nil {
		t.Fatalf("send: %v", err)
	}
	secret, err := s.SendChannelMessage(ctx, orgID, channelID, owner, "the merger is off, tell nobody", newClientID(), "", "", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if src, err := s.ForwardSourceResolve(ctx, orgID, member, secret.MessageID); err != nil || src.Body == "" {
		t.Fatalf("control: resolving a live channel message = (%+v, %v)", src, err)
	}

	if err := s.DeleteChannelMessageForAll(ctx, orgID, owner, secret.MessageID, nil); err != nil {
		t.Fatalf("delete for all: %v", err)
	}

	chans, err := s.ListChannels(ctx, orgID, member)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	var preview *string
	for _, c := range chans {
		if c.ID == channelID {
			preview = c.LastMessage
		}
	}
	if preview == nil || *preview != "standup moved to 10" {
		got := "<nil>"
		if preview != nil {
			got = *preview
		}
		t.Errorf("member sees channel preview %q after the newest message was unsent, want %q", got, "standup moved to 10")
	}

	// The Browse directory previews the last message to people who have not joined.
	open, err := s.ListOpenChannels(ctx, orgID, browser, 50, 0)
	if err != nil {
		t.Fatalf("ListOpenChannels: %v", err)
	}
	var browsePreview *string
	for _, c := range open {
		if c.ID == channelID {
			browsePreview = c.LastMessage
		}
	}
	if browsePreview == nil || *browsePreview != "standup moved to 10" {
		got := "<nil>"
		if browsePreview != nil {
			got = *browsePreview
		}
		t.Errorf("a non-member browsing sees preview %q after the newest message was unsent, want %q", got, "standup moved to 10")
	}

	if _, err := s.ForwardSourceResolve(ctx, orgID, member, secret.MessageID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("resolving an unsent channel message: err = %v, want ErrForbidden", err)
	}
}
