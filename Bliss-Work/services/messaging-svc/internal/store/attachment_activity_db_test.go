package store

// MessageKindAttachmentOpened/Downloaded, against a real Postgres with RLS
// enforcing.
//
// ── Why this cannot be a Go-only test ────────────────────────────────────────
// Same reasoning as screenshot_attempt_db_test.go: attachmentActionBody's
// output only proves anything once it is shown to actually reach storage
// instead of the caller-supplied body, and attachmentForActivity's membership
// re-check only proves anything against real RLS-enforced tables. And the
// thread-reuse fix below (ReplyAttachmentActivity vs a bare SendMessage) is
// invisible without real rows: appendMessageTx's "which thread" branch
// depends on a real thread already existing and a real mostRecentThreadID
// lookup finding it.
//
// See calls_lifecycle_db_test.go's header for the harness (opt-in via
// MESSAGING_TEST_DATABASE_URL) reused here.

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedConversationAttachment inserts a minimal, schema-valid attachments row
// scoped to a DM conversation, with a real (non-encrypted) filename column —
// mirrors seedAttachment (attachments_reap_db_test.go), which is scope
// 'channel' only.
func seedConversationAttachment(t *testing.T, s *Store, orgID, convID, uploaderID, filename string) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, filename, sha256, mime, size_bytes, storage_path)
			VALUES ($1, $2, $3, 'conversation', $4, 'file', $5, $6, 'application/pdf', 2048, $7)`,
			id, orgID, uploaderID, convID, filename, "sha-"+id, orgID+"/"+id)
		return err
	}); err != nil {
		t.Fatalf("seed conversation attachment: %v", err)
	}
	return id
}

// seedBareConversation inserts a conversation row with no messages and
// therefore no thread — the state a brand-new DM is in before anyone has
// sent anything, used to prove ReplyAttachmentActivity falls into the same
// "mint the first thread" branch Reply itself does when one doesn't exist yet.
func seedBareConversation(t *testing.T, s *Store, orgID, userA, userB string) string {
	t.Helper()
	ctx := context.Background()
	low, high := orderedPair(userA, userB)
	convID := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO conversations (id, org_id, user_low, user_high) VALUES ($1,$2,$3,$4)`,
			convID, orgID, low, high)
		return err
	}); err != nil {
		t.Fatalf("seed bare conversation: %v", err)
	}
	return convID
}

func seedChannelAttachment(t *testing.T, s *Store, orgID, channelID, uploaderID, filename string) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, filename, sha256, mime, size_bytes, storage_path)
			VALUES ($1, $2, $3, 'channel', $4, 'file', $5, $6, 'application/pdf', 2048, $7)`,
			id, orgID, uploaderID, channelID, filename, "sha-"+id, orgID+"/"+id)
		return err
	}); err != nil {
		t.Fatalf("seed channel attachment: %v", err)
	}
	return id
}

// ── The fix: attachment activity in a DM must not mint a new thread ─────────
//
// SendMessage's top-level-send branch always creates a brand-new thread; a
// file can be opened or downloaded far more often than the rare event
// MessageKindScreenshotAttempt was designed for, and minting one per
// occurrence would also hijack Reply's most-recent-thread fallback, nesting
// the user's next real chat message under a throwaway activity notice.
// ReplyAttachmentActivity exists specifically to avoid that.
func TestReplyAttachmentActivity_UsesConversationsExistingThread(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	root, err := s.SendMessage(ctx, orgID, alice, bob, "here's the report", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	attID := seedConversationAttachment(t, s, orgID, root.ConversationID, alice, "Report.pdf")

	opened, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID,
		MessageKindAttachmentOpened, attID, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ReplyAttachmentActivity (opened): %v", err)
	}
	if opened.ThreadID != root.ThreadID {
		t.Fatalf("attachment_opened landed in thread %s, want the conversation's existing thread %s",
			opened.ThreadID, root.ThreadID)
	}

	downloaded, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID,
		MessageKindAttachmentDownloaded, attID, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ReplyAttachmentActivity (downloaded): %v", err)
	}
	if downloaded.ThreadID != root.ThreadID {
		t.Fatalf("attachment_downloaded landed in thread %s, want the conversation's existing thread %s",
			downloaded.ThreadID, root.ThreadID)
	}

	// The regression this guards: an ordinary reply sent AFTER the activity
	// messages must still land in the real conversation thread, not get
	// nested under a one-message thread the activity notice minted.
	nextChat, err := s.Reply(ctx, orgID, alice, root.ConversationID, "did you see it?", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if nextChat.ThreadID != root.ThreadID {
		t.Fatalf("the next ordinary chat message landed in thread %s, want %s — it followed a throwaway activity thread instead of the real conversation",
			nextChat.ThreadID, root.ThreadID)
	}
}

// ── Body and filename are server-authored, never the client's ───────────────
//
// There is no body parameter on ReplyAttachmentActivity at all — this proves
// appendMessageTx still calls attachmentActionBody with the attachment's REAL
// filename and the sender's REAL projected name, not anything a forging
// client could have supplied elsewhere.
func TestReplyAttachmentActivity_BodyIsServerAuthored(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	root, err := s.SendMessage(ctx, orgID, alice, bob, "shared a file", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	attID := seedConversationAttachment(t, s, orgID, root.ConversationID, alice, "Confidential Salary Review.xlsx")

	res, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID,
		MessageKindAttachmentDownloaded, attID, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ReplyAttachmentActivity: %v", err)
	}

	got := decryptedBody(t, s, orgID, "messages", "id", res.MessageID)
	want := "Bob downloaded Confidential Salary Review.xlsx"
	if got != want {
		t.Errorf("stored body = %q, want %q", got, want)
	}
}

// ── Authorization: cannot claim activity on a file outside your own scope ───
//
// A member of one conversation must not be able to post "X opened FILE" for
// an attachment that lives in a DIFFERENT conversation they are not in —
// attachmentForActivity's requireScopeMember check is what this proves.
func TestReplyAttachmentActivity_RejectsAttachmentOutsideCallersScope(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)
	eve := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, eve, "eve", "Eve")

	// alice/bob's conversation and its attachment — eve is a member of neither.
	root, err := s.SendMessage(ctx, orgID, alice, bob, "private", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	attID := seedConversationAttachment(t, s, orgID, root.ConversationID, alice, "Private.pdf")

	// eve's OWN conversation with alice, unrelated to the attachment above.
	eveConv, err := s.SendMessage(ctx, orgID, eve, alice, "hi", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage (eve/alice): %v", err)
	}

	_, err = s.ReplyAttachmentActivity(ctx, orgID, eve, eveConv.ConversationID,
		MessageKindAttachmentOpened, attID, uuid.Must(uuid.NewV7()).String())
	if err == nil {
		t.Fatal("ReplyAttachmentActivity succeeded for an attachment outside the caller's conversation; want an authorization error")
	}
}

// ── Idempotency: a retried open/download must not double-post ───────────────
func TestReplyAttachmentActivity_IsIdempotentOnClientMsgID(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	root, err := s.SendMessage(ctx, orgID, alice, bob, "root", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	attID := seedConversationAttachment(t, s, orgID, root.ConversationID, alice, "Report.pdf")
	clientMsgID := uuid.Must(uuid.NewV7()).String()

	first, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID, MessageKindAttachmentOpened, attID, clientMsgID)
	if err != nil {
		t.Fatalf("first ReplyAttachmentActivity: %v", err)
	}
	second, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID, MessageKindAttachmentOpened, attID, clientMsgID)
	if err != nil {
		t.Fatalf("second ReplyAttachmentActivity: %v", err)
	}
	if second.MessageID != first.MessageID {
		t.Fatalf("retried open with the same clientMsgId produced a second message: %s vs %s", second.MessageID, first.MessageID)
	}

	// A genuinely later, separate open (a fresh clientMsgId) must still be
	// recorded — dedup must key on the id, not silently drop repeats of the
	// same kind/attachment.
	third, err := s.ReplyAttachmentActivity(ctx, orgID, bob, root.ConversationID, MessageKindAttachmentOpened, attID, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("third ReplyAttachmentActivity: %v", err)
	}
	if third.MessageID == first.MessageID {
		t.Fatal("a genuinely separate open (new clientMsgId) was collapsed into the first one")
	}
}

// ── Channel path: server-authored body (was implemented but never tested) ───
func TestSendChannelMessageAttachmentActivityBodyIsServerAuthored(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	senderID := uuid.Must(uuid.NewV7()).String()
	channelID := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, senderID, "priya", "Priya Nair")

	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			channelID, orgID, "general", senderID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelID, orgID, senderID)
		return err
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	attID := seedChannelAttachment(t, s, orgID, channelID, senderID, "Roadmap.key")

	res, err := s.SendChannelMessage(ctx, orgID, channelID, senderID,
		"ignored — a forged body must never reach storage for this kind",
		uuid.Must(uuid.NewV7()).String(), MessageKindAttachmentOpened, "", attID)
	if err != nil {
		t.Fatalf("SendChannelMessage: %v", err)
	}

	got := decryptedBody(t, s, orgID, "channel_messages", "id", res.MessageID)
	want := "Priya Nair opened Roadmap.key"
	if got != want {
		t.Errorf("stored body = %q, want %q", got, want)
	}
}

// ── Channel authorization: cannot claim activity on a file outside your own
// channel, even though you ARE a member of SOME channel ────────────────────
func TestSendChannelMessageAttachmentActivity_RejectsAttachmentOutsideCallersScope(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	owner := uuid.Must(uuid.NewV7()).String()
	outsider := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, owner, "owner", "Owner")
	seedUser(t, s, orgID, outsider, "outsider", "Outsider")

	channelA := uuid.Must(uuid.NewV7()).String()
	channelB := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		for _, ch := range []string{channelA, channelB} {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
				ch, orgID, "chan-"+ch, owner); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
				ch, orgID, owner); err != nil {
				return err
			}
		}
		// outsider is a member of B only — not A, where the attachment lives.
		_, err := tx.Exec(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
			channelB, orgID, outsider)
		return err
	}); err != nil {
		t.Fatalf("seed channels: %v", err)
	}

	attID := seedChannelAttachment(t, s, orgID, channelA, owner, "Private.pdf")

	_, err := s.SendChannelMessage(ctx, orgID, channelB, outsider,
		"ignored", uuid.Must(uuid.NewV7()).String(), MessageKindAttachmentOpened, "", attID)
	if err == nil {
		t.Fatal("SendChannelMessage succeeded for an attachment outside the caller's channel; want an authorization error")
	}
}

// ── No thread yet: a conversation's genuinely first-ever action ─────────────
//
// This is an edge case in practice (an attachment can only exist because SOME
// message already shared it, which would already have created a thread), but
// the code path itself — appendMessageTx's "no threadIDHint, no parent" branch
// — must still behave correctly if ever reached: mint the ONE thread the
// conversation needs, exactly like Reply's own doc comment says it does for a
// conversation's real first message.
func TestReplyAttachmentActivity_NoExistingThread_MintsOne(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	convID := seedBareConversation(t, s, orgID, alice, bob)
	attID := seedConversationAttachment(t, s, orgID, convID, alice, "Report.pdf")

	res, err := s.ReplyAttachmentActivity(ctx, orgID, bob, convID, MessageKindAttachmentOpened, attID, uuid.Must(uuid.NewV7()).String())
	if err != nil {
		t.Fatalf("ReplyAttachmentActivity: %v", err)
	}
	if res.ThreadID == "" {
		t.Fatal("ReplyAttachmentActivity on a conversation with no thread yet returned no ThreadID")
	}

	// The conversation's first ORDINARY reply afterwards must land in that
	// SAME thread, not mint a second one.
	next, err := s.Reply(ctx, orgID, alice, convID, "hey", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if next.ThreadID != res.ThreadID {
		t.Fatalf("first ordinary reply landed in thread %s, want the one the activity post minted (%s)", next.ThreadID, res.ThreadID)
	}
}

// ── Multiple existing threads + repeated activity ────────────────────────────
//
// Two independent regressions in one test: (1) with more than one thread
// already in the conversation, activity must land in the MOST RECENT one, not
// an arbitrary one; (2) posting activity for the SAME file multiple times
// (genuinely separate actions — a fresh clientMsgId each) must never mint a
// new thread per occurrence, however many times it happens.
func TestReplyAttachmentActivity_MultipleThreads_RepeatedActivityStaysInTheMostRecentOne(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)

	// SendMessage always mints a new thread — two calls give this
	// conversation two REAL, independent threads, B strictly more recent.
	threadA, err := s.SendMessage(ctx, orgID, alice, bob, "first thread", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage (thread A): %v", err)
	}
	threadB, err := s.SendMessage(ctx, orgID, alice, bob, "second thread", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage (thread B): %v", err)
	}
	if threadB.ThreadID == threadA.ThreadID {
		t.Fatalf("test setup: two top-level SendMessage calls landed in the same thread")
	}

	attID := seedConversationAttachment(t, s, orgID, threadB.ConversationID, alice, "Notes.pdf")

	for i := 0; i < 3; i++ {
		res, err := s.ReplyAttachmentActivity(ctx, orgID, bob, threadB.ConversationID,
			MessageKindAttachmentOpened, attID, uuid.Must(uuid.NewV7()).String())
		if err != nil {
			t.Fatalf("open #%d: %v", i, err)
		}
		if res.ThreadID != threadB.ThreadID {
			t.Fatalf("open #%d landed in thread %s, want the most recent thread B (%s)", i, res.ThreadID, threadB.ThreadID)
		}
	}

	// The next ordinary reply must ALSO land in thread B — none of the three
	// activity posts above may have nudged "most recent" onto a thread of
	// their own.
	nextChat, err := s.Reply(ctx, orgID, alice, threadB.ConversationID, "did you see it?", uuid.Must(uuid.NewV7()).String(), "")
	if err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if nextChat.ThreadID != threadB.ThreadID {
		t.Fatalf("next ordinary reply landed in thread %s, want thread B (%s)", nextChat.ThreadID, threadB.ThreadID)
	}

	// Exactly two threads for this conversation, ever — the two genuine
	// top-level sends. Three attachment posts + one reply must not have
	// minted any more.
	var threadCount int
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM threads WHERE conversation_id = $1`, threadB.ConversationID).Scan(&threadCount)
	}); err != nil {
		t.Fatalf("count threads: %v", err)
	}
	if threadCount != 2 {
		t.Fatalf("conversation has %d threads, want exactly 2 — the activity posts must not have minted their own", threadCount)
	}
}

// seedActivityChannel inserts a channel with the given members.
func seedActivityChannel(t *testing.T, s *Store, orgID, createdBy string, members ...string) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.Must(uuid.NewV7()).String()
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, created_by) VALUES ($1,$2,$3,$4)`,
			id, orgID, "chan-"+id, createdBy); err != nil {
			return err
		}
		for _, m := range members {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ($1,$2,$3)`,
				id, orgID, m); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
	return id
}

// activityRows counts attachment_opened/attachment_downloaded rows stored in
// one conversation ("messages") or channel ("channel_messages").
func activityRows(t *testing.T, s *Store, table, scopeCol, scopeID string) int {
	t.Helper()
	ctx := context.Background()
	var n int
	q := `SELECT count(*) FROM ` + table + ` WHERE ` + scopeCol + ` = $1 AND kind IN ('attachment_opened','attachment_downloaded')`
	if err := s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, q, scopeID).Scan(&n)
	}); err != nil {
		t.Fatalf("count activity rows in %s: %v", table, err)
	}
	return n
}

// ── Destination scope: being in BOTH places is not enough ───────────────────
//
// The tests above only prove a NON-member is refused. The hole this guards is
// the other one: the caller may read the attachment (they are in the scope it
// lives in) AND may post where they are posting (they are in that scope too),
// yet the two are different places. Without the destination check the pill
// "X opened <file>" lands in a room whose members were never shown that file,
// disclosing its name. The caller here is a member of EVERY scope involved, so
// the membership checks alone pass every case and only the destination check
// can reject them.
func TestAttachmentActivity_RejectsAttachmentFromAnotherScopeTheCallerIsIn(t *testing.T) {
	s := lifecycleStore(t)
	ctx := context.Background()
	orgID := uuid.Must(uuid.NewV7()).String()
	alice, bob := seedMessageUsers(t, s, orgID)
	carol := uuid.Must(uuid.NewV7()).String()
	seedUser(t, s, orgID, carol, "carol", "Carol")

	// Alice is in two DMs (with bob, with carol) and two channels.
	dmA, err := s.SendMessage(ctx, orgID, alice, bob, "hi bob", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage (alice/bob): %v", err)
	}
	dmB, err := s.SendMessage(ctx, orgID, alice, carol, "hi carol", uuid.Must(uuid.NewV7()).String(), SendOptions{})
	if err != nil {
		t.Fatalf("SendMessage (alice/carol): %v", err)
	}
	chanA := seedActivityChannel(t, s, orgID, alice, alice)
	chanB := seedActivityChannel(t, s, orgID, alice, alice)

	fileInDMB := seedConversationAttachment(t, s, orgID, dmB.ConversationID, alice, "Only-For-Carol.pdf")
	fileInChanA := seedChannelAttachment(t, s, orgID, chanA, alice, "Only-In-Channel-A.pdf")

	postDM := func(kind, attID string) error {
		_, err := s.ReplyAttachmentActivity(ctx, orgID, alice, dmA.ConversationID, kind, attID, uuid.Must(uuid.NewV7()).String())
		return err
	}
	postChan := func(kind, attID string) error {
		_, err := s.SendChannelMessage(ctx, orgID, chanB, alice, "ignored", uuid.Must(uuid.NewV7()).String(), kind, "", attID)
		return err
	}

	for _, kind := range []string{MessageKindAttachmentOpened, MessageKindAttachmentDownloaded} {
		if err := postDM(kind, fileInDMB); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: a file from another DM, posted into this DM: err = %v, want ErrNotFound", kind, err)
		}
		if err := postDM(kind, fileInChanA); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: a channel file, posted into a DM: err = %v, want ErrNotFound", kind, err)
		}
		if err := postChan(kind, fileInChanA); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: a file from another channel, posted into this channel: err = %v, want ErrNotFound", kind, err)
		}
		if err := postChan(kind, fileInDMB); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: a DM file, posted into a channel: err = %v, want ErrNotFound", kind, err)
		}
	}

	// A refusal must leave nothing behind, not a half-written pill.
	if n := activityRows(t, s, "messages", "conversation_id", dmA.ConversationID); n != 0 {
		t.Errorf("DM A holds %d activity rows after only refused posts, want 0", n)
	}
	if n := activityRows(t, s, "channel_messages", "channel_id", chanB); n != 0 {
		t.Errorf("channel B holds %d activity rows after only refused posts, want 0", n)
	}

	// Control: the SAME callers, posting for a file that does live where they
	// post, still succeed — so the refusals above are the destination check and
	// not some broader breakage.
	fileInDMA := seedConversationAttachment(t, s, orgID, dmA.ConversationID, alice, "Shared-With-Bob.pdf")
	fileInChanB := seedChannelAttachment(t, s, orgID, chanB, alice, "Shared-In-Channel-B.pdf")
	if err := postDM(MessageKindAttachmentOpened, fileInDMA); err != nil {
		t.Errorf("same-conversation file refused: %v", err)
	}
	if err := postChan(MessageKindAttachmentDownloaded, fileInChanB); err != nil {
		t.Errorf("same-channel file refused: %v", err)
	}
	if n := activityRows(t, s, "messages", "conversation_id", dmA.ConversationID); n != 1 {
		t.Errorf("DM A holds %d activity rows after one accepted post, want 1", n)
	}
	if n := activityRows(t, s, "channel_messages", "channel_id", chanB); n != 1 {
		t.Errorf("channel B holds %d activity rows after one accepted post, want 1", n)
	}
}
