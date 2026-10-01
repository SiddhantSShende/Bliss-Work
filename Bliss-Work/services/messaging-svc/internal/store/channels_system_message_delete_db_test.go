package store

// Server-authored channel notices cannot be retracted through delete-for-all.
//
// DeleteChannelMessageForAll / DeleteChannelMessagesForAll authorise "the
// message's sender, or a channel moderator". For a person's own message that is
// right. For a notice the server wrote, sender_id is only the principal that
// caused the write — the creator for the creation notices, the adder for an
// add, the joiner for a self-join — so authorship must not grant the right to
// erase the record. Moderators are refused too: a notice is the channel's
// membership/rename history, and the cases below that most need it (the creator
// and the person who added someone) are channel managers by construction.
//
// Opt-in DB tests — see calls_lifecycle_db_test.go's header for the harness.

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
)

// The classification is the complement of the client-triggerable list, so these
// are facts about the kinds, not a second list to keep in sync.
func TestIsServerAuthoredKind(t *testing.T) {
	for _, kind := range []string{
		MessageKindChannelCreated, MessageKindChannelRenamed, MessageKindChannelMemberAdded,
		MessageKindChannelForwardNotice, MessageKindForwardExternal,
		"a_kind_added_next_year", // default-deny: unknown kinds are protected
	} {
		if !IsServerAuthoredKind(kind) {
			t.Errorf("%q should be server-authored", kind)
		}
	}
	for _, kind := range []string{
		MessageKindText, MessageKindCallMissed, MessageKindScreenshotAttempt,
		MessageKindAttachmentOpened, MessageKindAttachmentDownloaded,
	} {
		if IsServerAuthoredKind(kind) {
			t.Errorf("%q is client-triggerable and must stay deletable by its sender", kind)
		}
		if !ValidMessageKind(kind) {
			t.Errorf("%q should be a valid client kind", kind)
		}
	}
}

// appendKind writes one message of the given kind into the channel the way the
// server paths do, and returns its id.
func appendKind(t *testing.T, s *Store, orgID, channelID, senderID, body, kind string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		id, err = s.appendChannelMessageTx(ctx, tx, orgID, channelID, senderID, body,
			uuid.Must(uuid.NewV7()).String(), channelAppendOpts{kind: kind})
		return err
	}); err != nil {
		t.Fatalf("append %s: %v", kind, err)
	}
	return id
}

func messageIDAtSeq(t *testing.T, s *Store, channelID string, seq int64) string {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT id::text FROM channel_messages WHERE channel_id = $1 AND seq = $2`, channelID, seq).Scan(&id)
	}); err != nil {
		t.Fatalf("message at seq %d: %v", seq, err)
	}
	return id
}

func TestServerAuthoredChannelMessagesCannotBeDeleted(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Bea Cho", "Cy Dunn", "Dee Park", "Ada Admin")
	owner, alex, bea, cy, dee, admin := u[0], u[1], u[2], u[3], u[4], u[5]

	ch, err := s.CreateChannel(ctx, orgID, owner, "notice room", false, []string{alex, dee})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := s.JoinChannel(ctx, orgID, ch.ID, bea); err != nil {
		t.Fatalf("JoinChannel: %v", err)
	}
	if err := s.AddChannelMembers(ctx, orgID, ch.ID, owner, nil, []string{cy}); err != nil {
		t.Fatalf("AddChannelMembers: %v", err)
	}
	if _, err := s.RenameChannel(ctx, orgID, ch.ID, owner, nil, "notice room 2"); err != nil {
		t.Fatalf("RenameChannel: %v", err)
	}

	// The notices a user could previously delete just by being their sender.
	type notice struct {
		name   string
		id     string
		sender string
	}
	var notices []notice
	for _, m := range channelSystemMessages(t, s, orgID, ch.ID) {
		notices = append(notices, notice{m.kind + ": " + m.body, messageIDAtSeq(t, s, ch.ID, m.seq), m.senderID})
	}
	// Server-only kinds written by other paths, sent by a plain (non-manager)
	// member, so that "the sender" is exactly the user the old rule would let in.
	notices = append(notices,
		notice{"channel_forward_notice", appendKind(t, s, orgID, ch.ID, alex, "Alex Lee forwarded a message", MessageKindChannelForwardNotice), alex},
		notice{"forward_external", appendKind(t, s, orgID, ch.ID, alex, "Forwarded to someone", MessageKindForwardExternal), alex},
		notice{"unknown future kind", appendKind(t, s, orgID, ch.ID, alex, "something new", "a_kind_added_next_year"), alex},
	)
	if len(notices) != 8 { // created, added, bea joined, cy joined, renamed + 3 above
		t.Fatalf("expected 8 notices to try, got %d: %+v", len(notices), notices)
	}

	adminRoles := []string{"org_admin"}
	for _, n := range notices {
		// The sender, who the old rule authorised outright — including the
		// creator and the adder, who are also the channel's managers.
		if err := s.DeleteChannelMessageForAll(ctx, orgID, n.sender, n.id, nil); !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: sender single delete = %v, want ErrForbidden", n.name, err)
		}
		res, err := s.DeleteChannelMessagesForAll(ctx, orgID, n.sender, ch.ID, []string{n.id}, nil)
		if err != nil {
			t.Fatalf("%s: sender bulk delete: %v", n.name, err)
		}
		if len(res.Deleted) != 0 || !slices.Equal(res.Skipped, []string{n.id}) {
			t.Errorf("%s: sender bulk delete deleted=%v skipped=%v, want it skipped", n.name, res.Deleted, res.Skipped)
		}

		// An ordinary member, and an org admin who is not even in the channel.
		if err := s.DeleteChannelMessageForAll(ctx, orgID, dee, n.id, nil); !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: member single delete = %v, want ErrForbidden", n.name, err)
		}
		if err := s.DeleteChannelMessageForAll(ctx, orgID, admin, n.id, adminRoles); !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: org_admin single delete = %v, want ErrForbidden", n.name, err)
		}
		res, err = s.DeleteChannelMessagesForAll(ctx, orgID, admin, ch.ID, []string{n.id}, adminRoles)
		if err != nil {
			t.Fatalf("%s: org_admin bulk delete: %v", n.name, err)
		}
		if len(res.Deleted) != 0 || !slices.Equal(res.Skipped, []string{n.id}) {
			t.Errorf("%s: org_admin bulk delete deleted=%v skipped=%v, want it skipped", n.name, res.Deleted, res.Skipped)
		}
	}

	// One mixed batch: the notices are skipped, the person's own text still goes.
	own := appendKind(t, s, orgID, ch.ID, owner, "an ordinary message", MessageKindText)
	ids := []string{own}
	for _, n := range notices {
		ids = append(ids, n.id)
	}
	res, err := s.DeleteChannelMessagesForAll(ctx, orgID, owner, ch.ID, ids, nil)
	if err != nil {
		t.Fatalf("mixed bulk delete: %v", err)
	}
	if !slices.Equal(res.Deleted, []string{own}) || len(res.Skipped) != len(notices) {
		t.Errorf("mixed batch deleted=%v skipped=%d, want only %s deleted and %d skipped", res.Deleted, len(res.Skipped), own, len(notices))
	}

	// Nothing about the notices changed: still live, never tombstoned, and no
	// deletion was announced for any of them.
	for _, n := range notices {
		if c := countChannelRows(t, s,
			`SELECT count(*) FROM channel_messages WHERE id = $1 AND deleted_for_all_at IS NULL AND deleted_by IS NULL`,
			n.id); c != 1 {
			t.Errorf("%s: notice was modified by a refused delete", n.name)
		}
		if c := countChannelRows(t, s,
			`SELECT count(*) FROM outbox WHERE payload->>'type' = $1 AND payload->>'messageId' = $2`,
			events.TypeChannelMessageDeleted, n.id); c != 0 {
			t.Errorf("%s: %d ChannelMessageDeleted events emitted for a refused delete", n.name, c)
		}
	}
}

// The protection is only for server-authored kinds: everything a person can say
// or trigger keeps exactly its old rules — the author may retract it, a
// moderator may remove anyone's, and a bystander may do neither.
func TestChannelDeleteForAllRulesUnchangedForPeoplesMessages(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	u := newUsers(t, s, orgID, "Jordan Doe", "Alex Lee", "Dee Park", "Ada Admin")
	owner, alex, dee, admin := u[0], u[1], u[2], u[3]

	ch, err := s.CreateChannel(ctx, orgID, owner, "people room", false, []string{alex, dee})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	// Author retracts their own text and their own client-triggered notice.
	text := appendKind(t, s, orgID, ch.ID, alex, "hello", MessageKindText)
	missed := appendKind(t, s, orgID, ch.ID, alex, "Missed call", MessageKindCallMissed)
	for name, id := range map[string]string{"text": text, "call_missed": missed} {
		if err := s.DeleteChannelMessageForAll(ctx, orgID, alex, id, nil); err != nil {
			t.Errorf("author deleting own %s: %v, want success", name, err)
		}
	}

	// A bystander may not delete someone else's text.
	text2 := appendKind(t, s, orgID, ch.ID, alex, "hello again", MessageKindText)
	if err := s.DeleteChannelMessageForAll(ctx, orgID, dee, text2, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("bystander deleting another's text = %v, want ErrForbidden", err)
	}
	// A channel owner and an org admin (not in the channel) still can.
	if err := s.DeleteChannelMessageForAll(ctx, orgID, owner, text2, nil); err != nil {
		t.Errorf("channel owner deleting a member's text: %v, want success", err)
	}
	text3 := appendKind(t, s, orgID, ch.ID, alex, "and again", MessageKindText)
	if err := s.DeleteChannelMessageForAll(ctx, orgID, admin, text3, []string{"org_admin"}); err != nil {
		t.Errorf("org_admin deleting a member's text: %v, want success", err)
	}
	res, err := s.DeleteChannelMessagesForAll(ctx, orgID, owner, ch.ID,
		[]string{appendKind(t, s, orgID, ch.ID, alex, "bulk one", MessageKindText)}, nil)
	if err != nil || len(res.Deleted) != 1 {
		t.Errorf("owner bulk-deleting a member's text: res=%+v err=%v, want one deleted", res, err)
	}
}
