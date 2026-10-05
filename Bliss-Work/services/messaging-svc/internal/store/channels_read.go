package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/crypto"
)

// rawChannelRow holds one channel-list row's columns BEFORE the last-message
// preview is decrypted, so the row cursor can be fully drained before any
// Decrypt query runs on the same tx ("conn busy" otherwise). Shared by
// ListChannels and ListOpenChannels (identical projection).
type rawChannelRow struct {
	d          ChannelDTO
	lastMsg    *string
	lastEnc    []byte
	lastAt     *time.Time
	lastSender string
	// lastSenderID is the last message's raw sender id (NULL when the channel
	// has never had a message) — plaintext, no decrypt needed, unlike
	// lastSender which is a resolved display name.
	lastSenderID *string
	cleared      bool
	unread       int64
}

// scanRawChannelRows drains a channel-list cursor into rawChannelRow values and
// closes it. Pure column copy — no DB calls, safe before decrypt.
func scanRawChannelRows(rows pgx.Rows) ([]rawChannelRow, error) {
	defer rows.Close()
	var out []rawChannelRow
	for rows.Next() {
		var rc rawChannelRow
		// `created_by` predates the column being NOT NULL anywhere, and `role`
		// is NULL for the open-channel listing (no membership row to join), so
		// both are scanned through pointers rather than assumed present.
		var createdBy, role *string
		if err := rows.Scan(&rc.d.ID, &rc.d.Name, &rc.d.MemberCount,
			&rc.lastMsg, &rc.lastEnc, &rc.lastAt, &rc.lastSender, &rc.cleared, &rc.d.IsLocked,
			&createdBy, &role, &rc.unread, &rc.lastSenderID); err != nil {
			return nil, err
		}
		if createdBy != nil {
			rc.d.CreatedBy = *createdBy
		}
		if role != nil {
			rc.d.MyRole = *role
		}
		out = append(out, rc)
	}
	return out, rows.Err()
}

// decryptChannelRowCached resolves the last-message preview (body_enc is the
// source of truth; legacy plaintext is the fallback) and stamps the ISO
// timestamp. Every DEK version the batch needs must already be warm (see
// Cryptor.WarmVersions), and this never touches the database — see the "Batch
// decrypt" section of internal/crypto/crypto.go for why. iAmMember is set by
// the caller (true for ListChannels, false for ListOpenChannels). Used by
// both since Phase 12 — the connection-hold problem Phase 11 fixed for
// ListChannels turned out to affect ListOpenChannels too (proven, not
// assumed — see ListOpenChannels' own comment), so both now decrypt after
// their transaction commits rather than during it.
func decryptChannelRowCached(cr *crypto.Cryptor, orgID string, rc rawChannelRow, iAmMember bool) (ChannelDTO, error) {
	d := rc.d
	if rc.lastEnc != nil {
		dec, derr := cr.DecryptCached(orgID, rc.lastEnc)
		if derr != nil {
			return ChannelDTO{}, derr
		}
		d.LastMessage = &dec
	} else {
		d.LastMessage = rc.lastMsg
	}
	if rc.lastAt != nil {
		iso := rc.lastAt.UTC().Format("2006-01-02T15:04:05.000Z")
		d.LastMessageAt = &iso
	}
	d.LastMessageSender = rc.lastSender
	if rc.lastSenderID != nil {
		d.LastMessageSenderID = *rc.lastSenderID
	}
	d.Cleared = rc.cleared
	d.Unread = rc.unread
	d.IAmMember = iAmMember
	return d, nil
}

// ListChannels returns the channels the caller is a member of, with member count
// and last-message preview, ordered by most recent activity. IsLocked is
// surfaced so the UI can show a 🔒 next to invite-only channels.
//
// The query + row scan + DEK warm run inside one RLS-scoped tx; the decrypt
// itself (CPU-bound, no DB access on a warm cache — see PeekVersion/
// WarmVersions/DecryptCached) runs AFTER that tx commits and its pooled
// connection is released. Phase 11 found ~260 goroutines piled up waiting on
// pgxpool.Acquire under load: this endpoint's own connections were held open
// through the AES-GCM/JSON work on top of the query, well past what the query
// itself needed, against a pool deliberately capped at 10 (see store.go's
// comment on the platform-wide connection budget) — not raised here.
func (s *Store) ListChannels(ctx context.Context, orgID, callerID string) ([]ChannelDTO, error) {
	var raws []rawChannelRow
	// RLS: channel listing runs under app.org_id; so does the DEK warm-up
	// below (org_keys is RLS-protected too), which is why it stays inside
	// this same closure even though the query itself is already done.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// The member count is aggregated ONCE for the whole result, not once per
		// row. It used to be a correlated subquery in the select list —
		// `(SELECT count(*) ... WHERE cm2.channel_id = c.id)` — which Postgres
		// runs as a SubPlan per output row: a user in fifty channels of ten
		// thousand members each counted half a million index entries every time
		// they loaded the channel list.
		//
		// `mine` is materialised first so both the aggregate and the outer join
		// are restricted to the caller's own channels; without that the count
		// CTE would aggregate every membership in the org to answer a question
		// about a handful of channels.
		rows, err := tx.Query(ctx, `
			WITH mine AS (
			    SELECT channel_id, role, last_read_seq
			    FROM channel_members
			    WHERE user_id = $2
			),
			counts AS (
			    SELECT cm.channel_id, count(*) AS n
			    FROM channel_members cm
			    JOIN mine ON mine.channel_id = cm.channel_id
			    GROUP BY cm.channel_id
			)
			SELECT
			    c.id,
			    c.name,
			    COALESCE(counts.n, 0) AS member_count,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    COALESCE(NULLIF(up.display_name, ''), up.username, '') AS last_message_sender,
			    -- True when the caller has hidden every message up to the newest one
			    -- (Clear Chat, or hiding each message individually) but the channel
			    -- genuinely has history — distinct from a channel that has never had
			    -- a message at all, which keeps its usual member-count placeholder
			    -- client-side. last_msg_at is set once, on the first message
			    -- (append_channel.go/channels.go), and clearing never resets it, so
			    -- "not null" is a free stand-in for "has ever had a message".
			    (lm.body IS NULL AND lm.body_enc IS NULL AND c.last_msg_at IS NOT NULL) AS cleared,
			    c.is_locked,
			    c.created_by,
			    mine.role,
			    -- Same read-cursor mechanism 0028_channel_read_receipts.sql added for
			    -- "Seen by" — mine.last_read_seq — turned into a count, mirroring
			    -- ListConversations' own unread subquery exactly, including its
			    -- exclusion of messages this caller cleared or hid: those only ever
			    -- insert into message_hides and never move the cursor, so once every
			    -- message is hidden nothing is left for the client to mark read and
			    -- the badge would be stuck for good.
			    COALESCE((
			        SELECT count(*) FROM channel_messages m2
			        WHERE m2.channel_id = c.id
			          AND m2.sender_id <> $2
			          AND m2.seq > mine.last_read_seq
			          AND NOT EXISTS (
			              SELECT 1 FROM message_hides h
			              WHERE h.message_id = m2.id AND h.user_id = $2
			          )
			    ), 0) AS unread,
			    lm.sender_id AS last_message_sender_id
			FROM channels c
			JOIN mine ON mine.channel_id = c.id
			LEFT JOIN counts ON counts.channel_id = c.id
			LEFT JOIN LATERAL (
			    SELECT body, body_enc, sender_id FROM channel_messages m
			    WHERE m.channel_id = c.id
			      -- Unsent messages keep their body_enc; skip them (see ListConversations).
			      AND m.deleted_for_all_at IS NULL
			      -- Skips messages THIS caller cleared/hid, so the preview shows the
			      -- newest message the caller can actually still see rather than one
			      -- they deliberately hid (see ClearChannel/HideChannelMessage).
			      AND NOT EXISTS (
			          SELECT 1 FROM message_hides h
			          WHERE h.message_id = m.id AND h.user_id = $2
			      )
			    ORDER BY m.seq DESC LIMIT 1
			) lm ON true
			LEFT JOIN user_projection up ON up.user_id = lm.sender_id
			WHERE c.org_id = $1
			ORDER BY c.last_msg_at DESC NULLS LAST, c.created_at DESC`,
			orgID, callerID)
		if err != nil {
			return err
		}
		var scanErr error
		raws, scanErr = scanRawChannelRows(rows)
		if scanErr != nil {
			return scanErr
		}

		versions := map[int]struct{}{}
		for _, rc := range raws {
			if v, ok := s.crypto.PeekVersion(rc.lastEnc); ok {
				versions[v] = struct{}{}
			}
		}
		return s.crypto.WarmVersions(ctx, tx, orgID, versions)
	})
	if err != nil {
		return nil, err
	}

	out := make([]ChannelDTO, 0, len(raws))
	for _, rc := range raws {
		d, derr := decryptChannelRowCached(s.crypto, orgID, rc, true)
		if derr != nil {
			return nil, derr
		}
		out = append(out, d)
	}
	return out, nil
}

// ChannelMessages returns one page of a channel's messages, ascending by seq,
// resolving sender usernames. The caller must be a member.
//
// beforeSeq is an exclusive upper bound (0 = start from the newest), served as a
// keyset walk by idx_channel_messages_channel_seq.
//
// Channels were the worse half of the unbounded-read problem: a conversation's
// full history is paid by two people, but a channel's is paid by every member,
// on every open, forever.
func (s *Store) ChannelMessages(
	ctx context.Context, orgID, channelID, callerID string,
	beforeSeq int64, limit int,
) ([]ChannelMessageDTO, error) {
	limit = clampMessagePage(limit)
	beforeSeq = beforeSeqOrNewest(beforeSeq)

	var out []ChannelMessageDTO
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

		if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
			return err
		}

		rows, err := tx.Query(ctx,
			// display_name alongside username: `username` is the email local-part, so
			// on its own it renders "j.okafor" over every channel message.
			//
			// NOT EXISTS on message_hides drops the caller's "Delete for me" rows.
			// A filter rather than a flag: a hidden message is one this reader has
			// said they do not want to see, so shipping it with a boolean would put
			// the body on their device for the client to be trusted to conceal.
			//
			// A message deleted for everyone is still SELECTED — it renders as a
			// tombstone, and the body is dropped below rather than here, because
			// `seq` ordering and the "this message was deleted" placeholder both
			// need the row to survive.
			`SELECT m.id, m.channel_id, m.seq, m.sender_id,
			        COALESCE(up.username, ''), COALESCE(up.display_name, ''),
			        m.body, m.body_enc, m.created_at, m.kind, m.is_forward, m.forward_platform,
			        m.deleted_for_all_at IS NOT NULL AS deleted_for_all,
			        m.pinned_at IS NOT NULL AS pinned, m.reply_to_id
			 FROM channel_messages m
			 LEFT JOIN user_projection up ON up.user_id = m.sender_id
			 WHERE m.channel_id = $1 AND m.seq < $2
			   AND NOT EXISTS (
			       SELECT 1 FROM message_hides h
			       WHERE h.message_id = m.id AND h.user_id = $4
			   )
			 ORDER BY m.seq DESC
			 LIMIT $3`, channelID, beforeSeq, limit, callerID)
		if err != nil {
			return err
		}

		// Buffer raw rows, then close the cursor BEFORE decrypting on the same tx
		// (a Decrypt query while rows is open would error with "conn busy").
		type rawChMsg struct {
			m               ChannelMessageDTO
			created         time.Time
			bodyTxt         *string
			bodyEnc         []byte
			kind            string
			replyToID       *string
			forwardPlatform *string
		}
		var raws []rawChMsg
		for rows.Next() {
			var r rawChMsg
			if err := rows.Scan(&r.m.ID, &r.m.ChannelID, &r.m.Seq, &r.m.SenderID,
				&r.m.SenderUsername, &r.m.SenderDisplayName,
				&r.bodyTxt, &r.bodyEnc, &r.created, &r.kind, &r.m.IsForward, &r.forwardPlatform,
				&r.m.DeletedForAll, &r.m.Pinned, &r.replyToID); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		// Selected newest-first so the index could serve the LIMIT; the wire format
		// is oldest-first.
		reverseRaw(raws)

		result := []ChannelMessageDTO{}
		for _, r := range raws {
			m := r.m
			if r.replyToID != nil {
				m.ReplyToID = *r.replyToID
			}
			if r.forwardPlatform != nil {
				m.ForwardPlatform = *r.forwardPlatform
			}
			// A tombstone never ships its body. Skipping the decrypt IS the point:
			// "deleted" that still sends the text to every client and hides it in
			// CSS is not deletion. Same rule as decryptMessage on the DM side.
			if m.DeletedForAll {
				m.Body = ""
				m.CreatedAt = r.created.UTC().Format("2006-01-02T15:04:05.000Z")
				result = append(result, m)
				continue
			}
			// body_enc is the source of truth; legacy plaintext body is the fallback.
			if r.bodyEnc != nil {
				dec, derr := s.crypto.Decrypt(ctx, tx, orgID, r.bodyEnc)
				if derr != nil {
					return derr
				}
				m.Body = dec
			} else if r.bodyTxt != nil {
				m.Body = *r.bodyTxt
			}
			// 'text' is the overwhelming majority; omit it so an ordinary channel
			// message serializes exactly as it did before kinds existed here.
			if r.kind != MessageKindText {
				m.Kind = r.kind
			}
			m.CreatedAt = r.created.UTC().Format("2006-01-02T15:04:05.000Z")
			result = append(result, m)
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		out = result
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
