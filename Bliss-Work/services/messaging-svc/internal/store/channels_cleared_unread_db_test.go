package store

// Clearing or hiding a channel's messages must clear their share of the unread
// badge, against a real Postgres with RLS enforcing.
//
// ClearChannel and HideChannelMessage only insert into message_hides — they never
// move the reader's read cursor, and once every message is hidden the client has
// nothing left to call markChannelRead with. The DM unread count already excludes
// hidden messages for exactly this reason; the channel count (in ListChannels and
// in the sidebar-badge total) did not, so a cleared channel kept its unread number
// with no message left that could ever clear it.
//
// Opt-in on MESSAGING_TEST_DATABASE_URL; see calls_lifecycle_db_test.go's
// header for how to run it.

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestChannelUnread_ExcludesMessagesTheCallerCleared(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	author, reader := seedMessageUsers(t, s, orgID)
	channelID := seedChannelWithRoles(t, s, orgID, author, map[string]string{reader: "member"})

	var lastMsgID string
	for _, body := range []string{"one", "two", "three"} {
		msg, err := s.SendChannelMessage(ctx, orgID, channelID, author, body, newClientID(), "", "")
		if err != nil {
			t.Fatalf("send %q: %v", body, err)
		}
		lastMsgID = msg.MessageID
	}

	unread := func() (listed, total int64) {
		t.Helper()
		chans, err := s.ListChannels(ctx, orgID, reader)
		if err != nil {
			t.Fatalf("ListChannels: %v", err)
		}
		for _, c := range chans {
			if c.ID == channelID {
				listed = c.Unread
			}
		}
		counts, err := s.UnreadCounts(ctx, orgID, reader)
		if err != nil {
			t.Fatalf("UnreadCounts: %v", err)
		}
		return listed, counts.Channels
	}

	if listed, total := unread(); listed != 3 || total != 3 {
		t.Fatalf("control: unread before clearing = (list %d, badge %d), want 3 and 3", listed, total)
	}

	// Hiding ONE message takes exactly that message off the count.
	if err := s.HideChannelMessage(ctx, orgID, reader, lastMsgID); err != nil {
		t.Fatalf("hide: %v", err)
	}
	if listed, total := unread(); listed != 2 || total != 2 {
		t.Errorf("unread after hiding one of three = (list %d, badge %d), want 2 and 2", listed, total)
	}

	// Clearing the channel hides the rest: nothing is left to read.
	if err := s.ClearChannel(ctx, orgID, channelID, reader); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if listed, total := unread(); listed != 0 || total != 0 {
		t.Errorf("unread after clearing the channel = (list %d, badge %d), want 0 and 0", listed, total)
	}
}
