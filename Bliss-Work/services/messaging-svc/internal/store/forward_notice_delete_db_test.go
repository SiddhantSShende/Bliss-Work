package store

// The forward notice, produced by a REAL forward, against the delete-for-all
// authorization (see channels_system_message_delete_db_test.go for the whole
// server-authored-kind matrix and forward_notice_db_test.go for the harness).
//
// The notice's sender_id is the forwarder — someone who caused the write, not
// someone who said anything — so authorship must not let them erase it. That
// matters most for a forwarder who is NOT a member of the private channel (a
// later hop of a chain): DeleteChannelMessageForAll reads the row without a
// membership gate, so before the kind check an author-match alone would let an
// outsider delete a notice from a channel they cannot even read.

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/task-board/messaging-svc/internal/events"
)

func (f *forwardNoticeFx) wantNoticeUntouched(id string) {
	f.t.Helper()
	if n := countChannelRows(f.t, f.s,
		`SELECT count(*) FROM channel_messages WHERE id = $1 AND deleted_for_all_at IS NULL AND deleted_by IS NULL`, id); n != 1 {
		f.t.Errorf("notice %s was tombstoned by a refused delete", id)
	}
	if n := countChannelRows(f.t, f.s,
		`SELECT count(*) FROM outbox WHERE payload->>'type' = $1 AND payload->>'messageId' = $2`,
		events.TypeChannelMessageDeleted, id); n != 0 {
		f.t.Errorf("%d ChannelMessageDeleted events were emitted for a refused delete of %s", n, id)
	}
}

func (f *forwardNoticeFx) noticeID(channelID string, index int) string {
	f.t.Helper()
	got := f.notices(channelID)
	if index >= len(got) {
		f.t.Fatalf("channel has %d notices, wanted index %d", len(got), index)
	}
	return messageIDAtSeq(f.t, f.s, channelID, got[index].seq)
}

// 1 + 2. The forwarder — a member, and a non-member later in the chain — cannot
// delete their own notice, singly or in bulk; neither can an ordinary member.
func TestForwardNotice_SenderAndOthersCannotDeleteIt(t *testing.T) {
	f := newForwardNoticeFx(t)
	ctx := context.Background()
	src := f.post(f.priv, f.mia, "the launch codes")

	// Fiona (a member) forwards it to Dan; Dan (NOT a member) forwards that clone
	// on. Two notices, sent by two different users.
	hop1, err := f.forward(f.fiona, src, userTarget(f.dan), newID())
	if err != nil {
		t.Fatalf("hop 1: %v", err)
	}
	if _, err := f.forward(f.dan, hop1.MessageID, chanTarget(f.channel("dans room", false, f.dan)), newID()); err != nil {
		t.Fatalf("hop 2: %v", err)
	}
	f.wantNotices(f.priv, f.fiona, f.dan)
	byFiona, byDan := f.noticeID(f.priv, 0), f.noticeID(f.priv, 1)

	for _, c := range []struct {
		name, id, caller string
	}{
		{"the member who forwarded", byFiona, f.fiona},
		{"the non-member who forwarded", byDan, f.dan},
		{"an ordinary member, another's notice", byDan, f.fiona},
		{"an outsider", byFiona, f.olga},
	} {
		if err := f.s.DeleteChannelMessageForAll(ctx, f.orgID, c.caller, c.id, nil); !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: single delete = %v, want ErrForbidden", c.name, err)
		}
	}
	// Bulk: both forwarders get their notice SKIPPED. (The bulk path lets a
	// non-member address only messages they authored rather than refusing
	// outright, which is why the non-member's own notice is the one that matters.)
	res, err := f.s.DeleteChannelMessagesForAll(ctx, f.orgID, f.fiona, f.priv, []string{byFiona, byDan}, nil)
	if err != nil {
		t.Fatalf("bulk delete: %v", err)
	}
	if len(res.Deleted) != 0 || !slices.Equal(slices.Sorted(slices.Values(res.Skipped)), slices.Sorted(slices.Values([]string{byFiona, byDan}))) {
		t.Errorf("bulk delete deleted=%v skipped=%v, want both skipped", res.Deleted, res.Skipped)
	}
	res, err = f.s.DeleteChannelMessagesForAll(ctx, f.orgID, f.dan, f.priv, []string{byDan}, nil)
	if err != nil || len(res.Deleted) != 0 || !slices.Equal(res.Skipped, []string{byDan}) {
		t.Errorf("non-member bulk delete: res=%+v err=%v, want it skipped and nothing deleted", res, err)
	}

	f.wantNoticeUntouched(byFiona)
	f.wantNoticeUntouched(byDan)
	f.wantNotices(f.priv, f.fiona, f.dan) // still both there, still readable
}

// 4. The same people keep every ability they had over messages THEY wrote or
// moderate, in the same channel, right next to the notice.
func TestForwardNotice_OrdinaryMessageDeletionIsUnchanged(t *testing.T) {
	f := newForwardNoticeFx(t)
	ctx := context.Background()
	if _, err := f.forward(f.fiona, f.post(f.priv, f.mia, "the launch codes"), chanTarget(f.pub), newID()); err != nil {
		t.Fatalf("forward: %v", err)
	}
	notice := f.noticeID(f.priv, 0)

	// The forwarder retracts her own ordinary message...
	own := f.post(f.priv, f.fiona, "my own words")
	if err := f.s.DeleteChannelMessageForAll(ctx, f.orgID, f.fiona, own, nil); err != nil {
		t.Errorf("author deleting own message: %v, want success", err)
	}
	// ...may not delete someone else's...
	theirs := f.post(f.priv, f.mia, "mia's words")
	if err := f.s.DeleteChannelMessageForAll(ctx, f.orgID, f.fiona, theirs, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("member deleting another's message = %v, want ErrForbidden", err)
	}
	// ...and the channel's owner still moderates it.
	if err := f.s.DeleteChannelMessageForAll(ctx, f.orgID, f.mia, theirs, nil); err != nil {
		t.Errorf("owner deleting a message: %v, want success", err)
	}
	// Bulk is identical: ordinary messages go, the notice in the same request is skipped.
	more := f.post(f.priv, f.fiona, "more of my words")
	res, err := f.s.DeleteChannelMessagesForAll(ctx, f.orgID, f.fiona, f.priv, []string{more, notice}, nil)
	if err != nil {
		t.Fatalf("bulk: %v", err)
	}
	if !slices.Equal(res.Deleted, []string{more}) || !slices.Equal(res.Skipped, []string{notice}) {
		t.Errorf("bulk deleted=%v skipped=%v, want only the ordinary message deleted", res.Deleted, res.Skipped)
	}
	f.wantNoticeUntouched(notice)
}
