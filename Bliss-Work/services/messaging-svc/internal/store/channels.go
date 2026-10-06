package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/events"
	"github.com/task-board/messaging-svc/internal/readcache"
)

// CreateChannel creates a group channel owned by creator and seeds its members.
// The creator is always included as a member.
//
// `isLocked` decides the visibility model: false means anyone in the org can
// later self-join via /channels/{id}/join; true means new members can only be
// added by an existing member via /channels/{id}/members (the legacy invite
// path).
func (s *Store) CreateChannel(ctx context.Context, orgID, creatorID, name string, isLocked bool, memberIDs []string) (*ChannelDTO, error) {
	members := dedupeMembers(creatorID, memberIDs)
	chanID := uuid.Must(uuid.NewV7()).String()

	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		// Every member id the caller is asking to seed the channel with must
		// actually belong to this org — see verifyMembersInOrg's doc comment for
		// why. creatorID is deliberately NOT included in this check: it is the
		// caller's own JWT-verified identity, not "provided" input, and a
		// brand-new account can call this before its own user_projection row has
		// been projected from user.created (see cachedUserNames' comment on the
		// same gap).
		if err := verifyMembersInOrg(ctx, tx, orgID, memberIDs); err != nil {
			return err
		}

		_, err = tx.Exec(ctx,
			`INSERT INTO channels (id, org_id, name, is_locked, created_by) VALUES ($1, $2, $3, $4, $5)`,
			chanID, orgID, name, isLocked, creatorID)
		if err != nil {
			return err
		}

		// The creator is the OWNER, and saying so here is the whole of channel
		// moderation working.
		//
		// 0012_channel_roles introduced roles and backfilled owners from
		// `channels.created_by` for the channels that already existed — but this
		// insert was never updated, so every channel created SINCE has had no owner
		// at all. Nobody could add a member, change a role, kick or block in it: the
		// creator saw no "Add people" (the client hides what would 403) and an org
		// admin was the only person on earth who could moderate it.
		for _, uid := range members {
			role := RoleMember
			if uid == creatorID {
				role = RoleOwner
			}
			if err := s.insertChannelMember(ctx, tx, chanID, orgID, uid, role); err != nil {
				return err
			}
		}
		creatorUsername, creatorDisplayName, err := s.cachedUserNames(ctx, tx, orgID, creatorID)
		if err != nil {
			return err
		}
		creatorName := userDisplayName(creatorDisplayName, creatorUsername)
		body := fmt.Sprintf("%s created channel %s", creatorName, name)
		clientMsgID := uuid.NewMD5(uuid.Nil, []byte("channel-created:"+chanID)).String()
		// This message's event is what notification-svc turns into the "you were
		// added to a new channel" notification for every member, so it carries the
		// names that notification reads — see channelAppendOpts.channelName.
		if _, err := s.appendChannelMessageTx(ctx, tx, orgID, chanID, creatorID, body, clientMsgID,
			channelAppendOpts{kind: MessageKindChannelCreated, channelName: name, senderDisplayName: creatorName}); err != nil {
			return err
		}

		// One message naming everyone seeded with the channel, appended AFTER the
		// creation message in this same transaction — appendChannelMessageTx hands
		// out seq in call order, so "created" always sorts before "added". The
		// creator is members[0] (see dedupeMembers) and is not "added" to their own
		// channel; a creator-only channel gets no second message.
		//
		// Its sender_id is the CREATOR, not the people it names: it is one row about
		// several users, and sender_id is the principal who caused the write (see
		// the note in AddChannelMembers for what that column drives).
		if initial := members[1:]; len(initial) > 0 {
			names, err := usernames(ctx, tx, initial)
			if err != nil {
				return err
			}
			addedBody := initialMembersBody(initial, names)
			addedClientMsgID := uuid.NewMD5(uuid.Nil, []byte("channel-members-added:"+chanID)).String()
			if _, err := s.appendChannelMessageTx(ctx, tx, orgID, chanID, creatorID, addedBody, addedClientMsgID,
				channelAppendOpts{kind: MessageKindChannelMemberAdded}); err != nil {
				return err
			}
		}

		return tx.Commit(ctx)
	})
	if err != nil {
		return nil, err
	}
	return &ChannelDTO{
		ID:          chanID,
		Name:        name,
		MemberCount: len(members),
		IsLocked:    isLocked,
		IAmMember:   true,
		// Echoed so the client can render the manage affordances immediately,
		// rather than only after the channel list refetches.
		MyRole: RoleOwner,
	}, nil
}

// RenameChannel changes the channel name for a channel manager.
func (s *Store) RenameChannel(ctx context.Context, orgID, channelID, callerID string, roles []string, name string) (*ChannelDTO, error) {
	var out ChannelDTO
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, roles); err != nil {
			return err
		}
		var oldName string
		if err := tx.QueryRow(ctx, `SELECT name FROM channels WHERE id = $1 FOR UPDATE`, channelID).Scan(&oldName); err != nil {
			return err
		}
		if oldName != name {
			if _, err := tx.Exec(ctx, `UPDATE channels SET name = $2 WHERE id = $1`, channelID, name); err != nil {
				return err
			}
			username, displayName, err := s.cachedUserNames(ctx, tx, orgID, callerID)
			if err != nil {
				return err
			}
			if displayName == "" {
				displayName = username
			}
			clientMsgID := uuid.NewMD5(uuid.Nil, fmt.Appendf(nil, "channel-rename:%s:%s:%s", channelID, oldName, name))
			body := fmt.Sprintf("%s renamed channel from %s to %s", displayName, oldName, name)
			if _, err := s.appendChannelMessageTx(
				ctx,
				tx,
				orgID,
				channelID,
				callerID,
				body,
				clientMsgID.String(),
				channelAppendOpts{kind: MessageKindChannelRenamed},
			); err != nil {
				return err
			}
		}
		return tx.QueryRow(ctx, `SELECT id, name, (SELECT count(*) FROM channel_members WHERE channel_id = $1), is_locked, created_by FROM channels WHERE id = $1`, channelID).
			Scan(&out.ID, &out.Name, &out.MemberCount, &out.IsLocked, &out.CreatedBy)
	})
	return &out, err
}

// DeleteChannel permanently removes a channel and all of its messages.
// Returns the sha256 of every attachment blob that is no longer referenced
// by any other row in the org, so the caller can unlink each from blob
// storage (fs/S3) — the same row-then-blob pattern RemoveDraftAttachment
// uses. Without this, a deleted channel's attachment rows vanish but their
// blob bytes never do: ReapExpiredAttachments only reclaims a blob whose row
// still exists with an expired timestamp, so once the row is gone here, the
// content is orphaned on disk/in the bucket for good.
func (s *Store) DeleteChannel(ctx context.Context, orgID, channelID, callerID string, roles []string) (unreferencedSHAs []string, err error) {
	err = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, roles); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM channel_messages WHERE channel_id = $1)`, channelID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM message_hides WHERE message_id IN (SELECT id FROM channel_messages WHERE channel_id = $1)`, channelID); err != nil {
			return err
		}
		// Attachments scoped to this channel (attachments.go: ScopeChannel rows
		// have scope_id = the channel id).
		rows, qerr := tx.Query(ctx,
			`DELETE FROM attachments WHERE scope = $2 AND scope_id = $1 RETURNING sha256`, channelID, ScopeChannel)
		if qerr != nil {
			return qerr
		}
		seen := map[string]bool{}
		var shas []string
		for rows.Next() {
			var sha string
			if serr := rows.Scan(&sha); serr != nil {
				rows.Close()
				return serr
			}
			if !seen[sha] {
				seen[sha] = true
				shas = append(shas, sha)
			}
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}
		for _, sha := range shas {
			var stillReferenced bool
			if cerr := tx.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM attachments WHERE org_id = $1 AND sha256 = $2)`,
				orgID, sha).Scan(&stillReferenced); cerr != nil {
				return cerr
			}
			if !stillReferenced {
				unreferencedSHAs = append(unreferencedSHAs, sha)
			}
		}
		for _, table := range []string{"channel_member_history", "channel_blocks", "channel_members", "channel_messages"} {
			if _, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE channel_id = $1`, channelID); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1 AND org_id = $2`, channelID, orgID)
		return err
	})
	return unreferencedSHAs, err
}

// AddChannelMembers adds members to a channel; caller must be a channel
// manager (its owner, one of its admins, or an org_admin) — the same
// requirement as RenameChannel and DeleteChannel. Emits ChannelMemberJoined
// for every member that was actually new (re-adding an existing member is a
// no-op and emits nothing).
func (s *Store) AddChannelMembers(ctx context.Context, orgID, channelID, callerID string, claimRoles []string, memberIDs []string) error {
	return RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		if err := requireChannelManager(ctx, tx, orgID, channelID, callerID, claimRoles); err != nil {
			return err
		}

		ids := dedupeMembers("", memberIDs)
		if len(ids) == 0 {
			return tx.Commit(ctx)
		}

		// Every provided user id must actually belong to this org before being
		// trusted as a member — see verifyMembersInOrg's doc comment. Rejects the
		// whole request rather than silently dropping the bad id, the same
		// all-or-nothing rule the blocked-user check below applies.
		if err := verifyMembersInOrg(ctx, tx, orgID, ids); err != nil {
			return err
		}

		// The channel's name, for the "You were added to #general" notification the
		// joined event carries. One lookup for the whole request, not one per
		// member — the same reasoning as every other step below.
		var channelName string
		if err := tx.QueryRow(ctx,
			`SELECT name FROM channels WHERE id = $1`, channelID).Scan(&channelName); err != nil {
			return err
		}

		// ── Set-based, not row-by-row ────────────────────────────────────────────
		//
		// This used to loop, and each iteration cost four round trips: a block
		// check, an existence check, the insert, and an outbox insert for the ones
		// that were new. Adding a department to a channel — 500 people — was
		// therefore ~2,000 sequential statements inside ONE transaction, holding
		// its locks and its snapshot open for the whole time.
		//
		// That is expensive twice over. The latency is the obvious half; the half
		// that matters at scale is that a long-lived transaction holds back the
		// xmin horizon, so autovacuum cannot reclaim dead tuples anywhere in the
		// database while it runs. A bulk membership change became a vacuum stall.
		//
		// Every step below is one statement over the whole list, so the cost is
		// four round trips total rather than four per member.

		// 1. Blocks. Re-adding a blocked user would silently undo a moderation
		//    decision, so this is 403 for the whole request rather than skipping
		//    the individual — the caller asked for something it may not have, and
		//    partially honouring it would be worse than refusing.
		var blockedCount int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM channel_blocks WHERE channel_id = $1 AND user_id = ANY($2)`,
			channelID, ids).Scan(&blockedCount); err != nil {
			return err
		}
		if blockedCount > 0 {
			return ErrForbidden
		}

		// 2. Insert, and let Postgres tell us which rows were actually new.
		//    RETURNING on an ON CONFLICT DO NOTHING yields ONLY the inserted rows,
		//    which is exactly the "was this a new member" answer the old existence
		//    check was making a separate query for — and it is race-free, where two
		//    concurrent adds of the same person could both have read "not a member"
		//    and both emitted a joined event.
		rows, err := tx.Query(ctx,
			`INSERT INTO channel_members (channel_id, org_id, user_id)
			 SELECT $1, $2, unnest($3::uuid[])
			 ON CONFLICT (channel_id, user_id) DO NOTHING
			 RETURNING user_id::text`,
			channelID, orgID, ids)
		if err != nil {
			return err
		}
		var added []string
		for rows.Next() {
			var uid string
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				return err
			}
			added = append(added, uid)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(added) == 0 {
			return tx.Commit(ctx) // everyone was already a member; nothing to announce
		}

		// 3. Names for the new members, in one lookup rather than one each.
		names, err := usernames(ctx, tx, added)
		if err != nil {
			return err
		}
		actorUsername, actorDisplay, err := s.cachedUserNames(ctx, tx, orgID, callerID)
		if err != nil {
			return err
		}
		actorName := userDisplayName(actorDisplay, actorUsername)
		bodies := make([]string, 0, len(added))
		clientMsgIDs := make([]string, 0, len(added))
		// The text names the user who joined; sender_id stays the CALLER who added
		// them, deliberately. sender_id is the authenticated principal that caused
		// the write, and everything keyed on it assumes that: telemetry records a
		// "channel.message.sent" for the sender (a member who was merely added would
		// be credited with an action they never took), delete-for-all lets a
		// message's sender retract it without moderator rights (an added member
		// could erase the notice of their own addition), and the unread/last-sender
		// queries treat the sender as the one who just acted. The joined user is
		// still named in the body, and the ChannelMemberJoined event below carries
		// userId (who joined) and actorId (who added them) separately.
		for _, uid := range added {
			addedName := userDisplayName(names[uid].displayName, names[uid].username)
			bodies = append(bodies, fmt.Sprintf("%s joined the channel", addedName))
			clientMsgIDs = append(clientMsgIDs, uuid.Must(uuid.NewV7()).String())
		}
		if err := s.appendChannelMessagesTx(ctx, tx, orgID, channelID, callerID,
			bodies, clientMsgIDs, MessageKindChannelMemberAdded); err != nil {
			return err
		}

		// 4. One outbox row per genuinely-new member, inserted together. The events
		//    stay individual — each names one person, and a consumer that had to
		//    unpack a batch would be a contract change for no benefit — but they no
		//    longer cost a round trip each.
		if err := insertOutboxBatch(ctx, tx, channelID,
			memberJoinedEvents(orgID, channelID, channelName, callerID, actorName, added, names)); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
}

// initialMembersBody is the text of the single system message that names every
// user a channel was created with: "A was added to channel" for one,
// "A, B, C were added to channel" for several. The names follow the request
// order and are never truncated. A user with no projection row yet reads as
// "Someone", the same fallback every other system message uses.
func initialMembersBody(userIDs []string, names map[string]projectedUserNames) string {
	display := make([]string, len(userIDs))
	for i, uid := range userIDs {
		display[i] = userDisplayName(names[uid].displayName, names[uid].username)
	}
	verb := "were"
	if len(display) == 1 {
		verb = "was"
	}
	return fmt.Sprintf("%s %s added to channel", strings.Join(display, ", "), verb)
}

// memberJoinedEvents builds one ChannelMemberJoined per newly-added member.
//
// `actorID` is the caller who added them, and is what makes this path
// notifiable where the self-join path is not — see the event's doc comment.
func memberJoinedEvents(orgID, channelID, channelName, actorID, actorDisplayName string, userIDs []string, names map[string]projectedUserNames) []any {
	out := make([]any, 0, len(userIDs))
	for _, uid := range userIDs {
		out = append(out, events.ChannelMemberJoined{
			Type:             events.TypeChannelMemberJoined,
			EventID:          uuid.Must(uuid.NewV7()).String(),
			OrgID:            orgID,
			OccurredAt:       nowISO(),
			ChannelID:        channelID,
			ChannelName:      channelName,
			UserID:           uid,
			Username:         names[uid].username,
			ActorID:          actorID,
			ActorDisplayName: actorDisplayName,
		})
	}
	return out
}

// SendChannelMessage appends a message to a channel. Caller must be a member.
// Idempotent on (channel, sender, clientMsgId).
//
// kind is a MessageKind* constant ("" → text), whitelisted by the caller via
// ValidMessageKind exactly as sendMessage does for DMs — see store.go.
//
// attachmentID is required when kind is MessageKindAttachmentOpened or
// MessageKindAttachmentDownloaded — see attachmentForActivity. Ignored
// otherwise.
func (s *Store) SendChannelMessage(ctx context.Context, orgID, channelID, senderID, body, clientMsgID, kind, replyToID, attachmentID string) (*ChannelSendResult, error) {
	var out *ChannelSendResult
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)

		// RLS: scope this tx to the caller's org before any RLS table is touched.
		if err := setOrgGUC(ctx, tx, orgID); err != nil {
			return err
		}

		if err := requireChannelMember(ctx, tx, orgID, channelID, senderID); err != nil {
			return err
		}
		// A block WITHOUT a kick is a mute: the member keeps their row and keeps
		// reading, but cannot post. Checked on the send path for the same reason the
		// DM block is (messages.go) — the authoritative gate belongs where the write
		// happens, not only where the UI hides a button.
		if blocked, err := isBlocked(ctx, tx, channelID, senderID); err != nil {
			return err
		} else if blocked {
			return ErrForbidden
		}

		// Idempotency fast path: return the existing message if this
		// client_msg_id was already seen. This SELECT is an optimisation, not
		// the correctness mechanism — see the INSERT below, which is what
		// actually closes the race two genuinely concurrent sends of the same
		// (channel, sender, client_msg_id) could otherwise hit: both could pass
		// this SELECT before either one's INSERT had committed.
		var existingID string
		var existingSeq int64
		err = tx.QueryRow(ctx,
			`SELECT id, seq FROM channel_messages
			 WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
			channelID, senderID, clientMsgID).Scan(&existingID, &existingSeq)
		if err == nil {
			if cerr := tx.Commit(ctx); cerr != nil {
				return cerr
			}
			out = &ChannelSendResult{MessageID: existingID, Seq: existingSeq}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		// Allocate the next seq atomically and bump last activity.
		var seq int64
		err = tx.QueryRow(ctx,
			`UPDATE channels SET seq_counter = seq_counter + 1, last_msg_at = now()
			 WHERE id = $1 RETURNING seq_counter`, channelID).Scan(&seq)
		if err != nil {
			return err
		}

		// Both names travel on the event so a message arriving over the socket
		// renders the same as one that came back from a refetch. Sending only the
		// username made a live message flip from "Jane Okafor" to "j.okafor" until
		// the next fetch. Resolved before the encrypt/insert below because
		// MessageKindScreenshotAttempt needs it to author the body itself.
		senderName, senderDisplay, err := s.cachedUserNames(ctx, tx, orgID, senderID)
		if err != nil {
			return err
		}
		if kind == MessageKindScreenshotAttempt {
			body = screenshotAttemptBody(senderDisplay, senderName)
		}
		if kind == MessageKindAttachmentOpened || kind == MessageKindAttachmentDownloaded {
			if attachmentID == "" {
				return ErrForbidden
			}
			filename, ferr := s.attachmentForActivity(ctx, tx, orgID, attachmentID, senderID, ScopeChannel, channelID)
			if ferr != nil {
				return ferr
			}
			body = attachmentActionBody(kind, senderDisplay, senderName, filename)
		}

		// Encrypt the body under the org DEK (created lazily in THIS tx); the
		// plaintext body column is left NULL.
		bodyEnc, err := s.crypto.Encrypt(ctx, tx, orgID, body)
		if err != nil {
			return err
		}
		msgID := uuid.Must(uuid.NewV7()).String()
		// reply_to_id is DISTINCT from any Gmail-style threading concept (channels
		// have none) — it is "this bubble quotes that bubble", same as the DM
		// column it mirrors (messages.go). No FK, so a dangling id is left for the
		// client to render as "Original message".
		var replyToArg *string
		if replyToID != "" {
			replyToArg = &replyToID
		}
		// INSERT ... ON CONFLICT DO NOTHING, not a bare INSERT: the SELECT above
		// already handles the common case (an ordinary retried send), but it
		// cannot close the window where two concurrent sends of the same
		// (channel, sender, client_msg_id) both pass it before either commits.
		// The UNIQUE constraint is the real backstop, and letting Postgres
		// resolve the conflict here is what keeps the loser's response an
		// idempotent 2xx instead of a raw 500: unique violations (23505) are
		// deliberately excluded from RetryOnSerializationFailure (retry.go) and
		// have no case in mapStoreError (api/errors.go), so an unguarded
		// constraint violation would have reached the caller unmapped.
		tag, err := tx.Exec(ctx,
			`INSERT INTO channel_messages (id, org_id, channel_id, seq, sender_id, body, body_enc, client_msg_id, kind, reply_to_id)
			 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)
			 ON CONFLICT (channel_id, sender_id, client_msg_id) DO NOTHING`,
			msgID, orgID, channelID, seq, senderID, bodyEnc, clientMsgID, channelAppendOpts{kind: kind}.kindArg(), replyToArg)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			// Lost the race: some other transaction's insert of this exact
			// (channel, sender, client_msg_id) won. Their row — not msgID/seq
			// above, which are simply discarded — is the idempotent answer; the
			// unused seq value is the same kind of harmless gap a deleted
			// message already leaves in the sequence.
			if err := tx.QueryRow(ctx,
				`SELECT id, seq FROM channel_messages
				 WHERE channel_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
				channelID, senderID, clientMsgID).Scan(&existingID, &existingSeq); err != nil {
				return err
			}
			if cerr := tx.Commit(ctx); cerr != nil {
				return cerr
			}
			out = &ChannelSendResult{MessageID: existingID, Seq: existingSeq}
			return nil
		}

		members, err := channelMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		var channelName string
		if err := tx.QueryRow(ctx, `SELECT name FROM channels WHERE id = $1`, channelID).Scan(&channelName); err != nil {
			return err
		}

		evt := events.ChannelMessageCreated{
			Type:              events.TypeChannelMessageCreated,
			EventID:           uuid.Must(uuid.NewV7()).String(),
			OrgID:             orgID,
			OccurredAt:        nowISO(),
			ChannelID:         channelID,
			MessageID:         msgID,
			Seq:               seq,
			SenderID:          senderID,
			SenderUsername:    senderName,
			SenderDisplayName: senderDisplay,
			ChannelName:       channelName,
			Body:              body,
			Members:           members,
			Kind:              kind,
			ReplyToID:         replyToID,
		}
		if err := insertOutbox(ctx, tx, channelID, evt); err != nil {
			return err
		}

		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = &ChannelSendResult{MessageID: msgID, Seq: seq}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

// insertChannelMember adds a member row with the given role, ignoring
// duplicates.
//
// The role is a parameter rather than the column default because the ONE caller
// that needs a non-default — the creator of a channel, who is its owner — is
// also the caller whose omission left every channel created since
// 0012_channel_roles with nobody able to moderate it. A default is easy to
// forget; an argument is not.
func (s *Store) insertChannelMember(ctx context.Context, tx pgx.Tx, channelID, orgID, userID, role string) error {
	_, err := s.insertChannelMemberIfNew(ctx, tx, channelID, orgID, userID, role)
	return err
}

// insertChannelMemberIfNew is insertChannelMember that also reports whether the
// row was actually created. The answer comes from the INSERT's own affected-row
// count, not from a prior SELECT: under READ COMMITTED two concurrent inserts of
// the same (channel, user) both pass any earlier existence check, but the
// second blocks on the first's unique-key entry and, once it commits, takes the
// DO NOTHING branch with zero rows affected. Exactly one caller sees true.
func (s *Store) insertChannelMemberIfNew(ctx context.Context, tx pgx.Tx, channelID, orgID, userID, role string) (bool, error) {
	tag, err := tx.Exec(ctx,
		`INSERT INTO channel_members (channel_id, org_id, user_id, role) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (channel_id, user_id) DO NOTHING`,
		channelID, orgID, userID, role)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// classifyChannelOrgLookup turns the result of a `SELECT org_id ... FROM
// channels WHERE id = $1` probe into the one thing every channel-scoped
// caller needs from it: ErrForbidden for "no such channel" and "channel
// belongs to another org" alike (a cross-org caller must not be able to tell
// the two apart), the query's own error otherwise, nil when the row is the
// caller's own org's. Shared by requireChannelMember below, channelManagerCheck
// (channels_roles.go), and JoinChannel/LeaveChannel (channels_membership.go) —
// each does this exact probe before anything else it does with the channel.
func classifyChannelOrgLookup(err error, cOrg, orgID string) error {
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return ErrForbidden
	}
	return err
}

// requireChannelMember returns ErrForbidden unless the user is a member of the
// channel within the given org.
func requireChannelMember(ctx context.Context, tx pgx.Tx, orgID, channelID, userID string) error {
	var cOrg string
	err := tx.QueryRow(ctx, `SELECT org_id FROM channels WHERE id = $1`, channelID).Scan(&cOrg)
	if err := classifyChannelOrgLookup(err, cOrg, orgID); err != nil {
		return err
	}
	var exists bool
	err = tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// verifyMembersInOrg returns ErrForbidden unless every one of userIDs belongs
// to orgID, per user_projection — the org directory, and the same
// authoritative source resolveMailRecipients (mail.go) and the peer/invitee
// org checks in calls.go already scope their own lookups against (`WHERE
// org_id = $1`).
//
// ── Why this check exists ────────────────────────────────────────────────────
// channel_members.user_id carries no foreign key, and the table's RLS policy
// only checks the ROW's own org_id — never that user_id actually belongs to
// it. Without this, a channel manager could add any real user id, including
// one from a completely different org, as a member. That is not just a
// data-integrity gap: channelMemberIDs' comment above explains that
// ws-gateway fans a channel's messages out purely off the event's `members`
// list, so a cross-org id slipped in here is a cross-tenant message leak, not
// merely a bad row.
//
// One round trip for the whole list, same reasoning as resolveMailRecipients:
// checking membership one id at a time would turn a bulk add into one query
// per person.
func verifyMembersInOrg(ctx context.Context, tx pgx.Tx, orgID string, userIDs []string) error {
	unique := make(map[string]struct{}, len(userIDs))
	for _, id := range userIDs {
		unique[id] = struct{}{}
	}
	if len(unique) == 0 {
		return nil
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM user_projection WHERE org_id = $1 AND user_id = ANY($2)`,
		orgID, ids).Scan(&n); err != nil {
		return err
	}
	if n != len(ids) {
		return ErrForbidden
	}
	return nil
}

// maxChannelFanout bounds how many member ids a single channelMemberIDs query
// will ever return.
//
// ── Why this exists ───────────────────────────────────────────────────────
// Every call site below except ChannelMemberIDs (the roster endpoint — see
// channelMemberIDsAll) embeds this list directly into a Kafka outbox event:
// SendChannelMessage on the message-send hot path, appendChannelMessageTx for
// forwards, emitChannelEvent for membership/role changes, and
// DeleteChannelMessageForAll/SetChannelMessagePin/SetChannelReaction for
// per-message moderation. ws-gateway routes purely off `members` in the event
// (packages/shared/src/types/events.ts: "the gateway pushes to each, then
// DROPS this field" — routing depends on it, so there is no cheaper way for a
// consumer to reach every member's socket without messaging-svc handing it
// the list).
//
// Without a ceiling, a large enough channel (an org-wide "general") makes
// every message send embed an unboundedly large array. That does not just add
// latency: kafka/outbox.go's maxPublishBytes (1 MiB) is checked PER EVENT
// before anything is sent, and an event over that limit is DEAD-LETTERED, not
// retried — the sender sees success (the message is already committed) and
// nobody is ever notified. A bounded roster turns that silent failure into a
// push that reaches everyone except the newest joiners past the cap, which is
// a straightforward, honest degradation instead.
//
// ── Why 20,000 ────────────────────────────────────────────────────────────
// Sized to stay comfortably under maxPublishBytes even for the richest
// producer, ChannelMessageCreated, which also carries up to
// api.MaxMessageBodyBytes (8 KiB) of body plus the rest of its envelope
// (call it ~9 KiB total non-members overhead). At ~39 bytes per id (a quoted
// UUID plus its separator), 20,000 ids costs ~780 KB, leaving a wide margin
// below the 1 MiB ceiling rather than sizing exactly to it.
const maxChannelFanout = 20_000

// channelMemberIDs returns member user ids of a channel, oldest-joined-first,
// capped at maxChannelFanout — see that constant's comment for why the cap
// exists. A channel over the cap logs a warning so an operator can see it
// happening rather than only inferring it from missing pushes.
func channelMemberIDs(ctx context.Context, tx pgx.Tx, channelID string) ([]string, error) {
	rows, err := tx.Query(ctx,
		`SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY joined_at LIMIT $2`,
		channelID, maxChannelFanout+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > maxChannelFanout {
		slog.Warn("channel membership exceeds the fan-out cap; event will not reach every member",
			"channelId", channelID, "cap", maxChannelFanout)
		out = out[:maxChannelFanout]
	}
	return out, nil
}

// channelMemberPageSize is the batch size channelMemberIDsAll fetches per
// round trip.
const channelMemberPageSize = 1000

// channelMemberIDsAll returns EVERY member id of a channel — unlike
// channelMemberIDs, it is not subject to maxChannelFanout. It exists for
// ChannelMemberIDs (channels_membership.go), the roster read behind
// GET /channels/{id}/members: the task-creation dialog expands that response
// into individual task assignees, so a silently truncated roster there would
// drop assignees rather than merely delay a live push, which is a materially
// worse failure than what the cap above accepts for fan-out events.
//
// It stays bounded end-to-end anyway: rather than one unbounded query, it
// walks the roster in fixed-size pages keyed on (joined_at, user_id) — the
// same total row count, but no single round trip can return more than
// channelMemberPageSize rows.
func channelMemberIDsAll(ctx context.Context, tx pgx.Tx, channelID string) ([]string, error) {
	out := []string{}
	var afterJoined time.Time
	var afterUser string
	for page := 0; ; page++ {
		var rows pgx.Rows
		var err error
		if page == 0 {
			rows, err = tx.Query(ctx,
				`SELECT user_id, joined_at FROM channel_members
				 WHERE channel_id = $1
				 ORDER BY joined_at, user_id
				 LIMIT $2`,
				channelID, channelMemberPageSize)
		} else {
			rows, err = tx.Query(ctx,
				`SELECT user_id, joined_at FROM channel_members
				 WHERE channel_id = $1 AND (joined_at, user_id) > ($2, $3)
				 ORDER BY joined_at, user_id
				 LIMIT $4`,
				channelID, afterJoined, afterUser, channelMemberPageSize)
		}
		if err != nil {
			return nil, err
		}
		n := 0
		for rows.Next() {
			var id string
			var joined time.Time
			if err := rows.Scan(&id, &joined); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, id)
			afterJoined, afterUser = joined, id
			n++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if n < channelMemberPageSize {
			return out, nil
		}
	}
}

// cachedUserName is a user_projection row as it is cached.
//
// A named struct rather than a tuple because it is serialised into Redis and
// survives across deploys: a field added later is decoded as its zero value by
// an older pod, and an unknown field is ignored by a newer one. A JSON array
// would break on both.
type cachedUserName struct {
	Username    string `json:"u"`
	DisplayName string `json:"d"`
}

// cachedUserNames is userNames, served from the read cache when it can be.
//
// ── Why this path in particular ──────────────────────────────────────────────
// This is the hottest user_projection read in the service: every channel
// message send resolves its sender's names to stamp them onto the outbox event,
// so it runs once per message on the platform's busiest write path. The row is
// two short strings and changes only when somebody is renamed.
//
// ── The org id is a security parameter, not a convenience ────────────────────
// `user_projection` is RLS-protected (0007_rls.sql) and org-scoped, so the
// database's answer depends on WHO IS ASKING — a caller in another org gets no
// row. The cache key therefore has to carry the org, or a value cached for one
// organisation would be served to another. See readcache.UserKey.
//
// orgID here is the caller's verified org from the JWT, the same value already
// used to set the transaction's `app.org_id` GUC — so the cache is keyed on
// exactly the thing that scoped the query it is caching.
//
// A miss, a timeout or an unreachable Redis all fall through to the query,
// which is what would have happened without a cache at all.
func (s *Store) cachedUserNames(
	ctx context.Context, tx pgx.Tx, orgID, userID string,
) (uname, display string, err error) {
	key := readcache.UserKey(orgID, userID)
	if hit, ok := readcache.GetJSON[cachedUserName](ctx, s.cache, key); ok {
		return hit.Username, hit.DisplayName, nil
	}
	uname, display, err = userNames(ctx, tx, userID)
	if err != nil {
		return "", "", err
	}
	// A user with no projection row yields ("", ""), and that IS cached: an
	// unknown user is the steady state for a member whose user.created event
	// has not been consumed yet, and not caching it would send every message
	// they touch to the database. The TTL bounds how long that lasts, and the
	// consumer invalidates the moment the row arrives.
	readcache.SetJSON(ctx, s.cache, key,
		cachedUserName{Username: uname, DisplayName: display}, readcache.UserTTL)
	return uname, display, nil
}

// userNames resolves both projected names for a user; either may be empty if
// unknown. Callers that render a person should prefer displayName and fall back
// to username, which is only the EMAIL LOCAL-PART (see auth-svc signup).
func userNames(ctx context.Context, tx pgx.Tx, userID string) (uname, display string, err error) {
	err = tx.QueryRow(ctx,
		`SELECT COALESCE(username, ''), COALESCE(display_name, '')
		 FROM user_projection WHERE user_id = $1`, userID).Scan(&uname, &display)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return uname, display, err
}

// usernames resolves the username and display-name snapshot for many users in one round trip.
//
// The batch form of `username`, and it exists for the same reason
// AddChannelMembers is now set-based: resolving a name per member turned a bulk
// membership change into one query per person. Users with no projection row are
// simply absent from the map, and callers read a missing key as "" — the same
// answer `username` gives for an unknown user.
type projectedUserNames struct {
	username    string
	displayName string
}

func userDisplayName(displayName, username string) string {
	if displayName != "" {
		return displayName
	}
	if username != "" {
		return username
	}
	return "Someone"
}

func usernames(ctx context.Context, tx pgx.Tx, userIDs []string) (map[string]projectedUserNames, error) {
	out := make(map[string]projectedUserNames, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT user_id::text, COALESCE(username, ''), COALESCE(display_name, '')
		   FROM user_projection WHERE user_id = ANY($1)`, userIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var names projectedUserNames
		if err := rows.Scan(&id, &names.username, &names.displayName); err != nil {
			return nil, err
		}
		out[id] = names
	}
	return out, rows.Err()
}

// username resolves a user_projection username, empty if unknown.
func username(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var name string
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(username, '') FROM user_projection WHERE user_id = $1`, userID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// dedupeMembers returns the de-duplicated union of must (if non-empty) and ids.
func dedupeMembers(must string, ids []string) []string {
	seen := make(map[string]struct{}, len(ids)+1)
	out := make([]string, 0, len(ids)+1)
	add := func(v string) {
		if v == "" {
			return
		}
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	add(must)
	for _, v := range ids {
		add(v)
	}
	return out
}
