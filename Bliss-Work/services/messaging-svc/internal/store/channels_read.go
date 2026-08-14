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
	d       ChannelDTO
	lastMsg *string
	lastEnc []byte
	lastAt  *time.Time
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
			&rc.lastMsg, &rc.lastEnc, &rc.lastAt, &rc.d.IsLocked,
			&createdBy, &role); err != nil {
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

// decryptChannelRow resolves the last-message preview (body_enc is the source of
// truth; legacy plaintext is the fallback) and stamps the ISO timestamp. q must
// be the RLS-scoped tx so the org_keys lookup is visible. iAmMember is set by
// the caller (true for ListChannels, false for ListOpenChannels).
func (s *Store) decryptChannelRow(ctx context.Context, q crypto.Querier, orgID string, rc rawChannelRow, iAmMember bool) (ChannelDTO, error) {
	d := rc.d
	if rc.lastEnc != nil {
		dec, derr := s.crypto.Decrypt(ctx, q, orgID, rc.lastEnc)
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
	d.IAmMember = iAmMember
	return d, nil
}

// ListChannels returns the channels the caller is a member of, with member count
// and last-message preview, ordered by most recent activity. IsLocked is
// surfaced so the UI can show a 🔒 next to invite-only channels.
func (s *Store) ListChannels(ctx context.Context, orgID, callerID string) ([]ChannelDTO, error) {
	out := []ChannelDTO{}
	// RLS: channel listing + per-row last-message decrypt run under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT
			    c.id,
			    c.name,
			    (SELECT count(*) FROM channel_members cm2 WHERE cm2.channel_id = c.id) AS member_count,
			    lm.body,
			    lm.body_enc,
			    c.last_msg_at,
			    c.is_locked,
			    c.created_by,
			    cm.role
			FROM channels c
			JOIN channel_members cm
			    ON cm.channel_id = c.id AND cm.user_id = $2
			LEFT JOIN LATERAL (
			    SELECT body, body_enc FROM channel_messages m
			    WHERE m.channel_id = c.id
			    ORDER BY m.seq DESC LIMIT 1
			) lm ON true
			WHERE c.org_id = $1
			ORDER BY c.last_msg_at DESC NULLS LAST, c.created_at DESC`,
			orgID, callerID)
		if err != nil {
			return err
		}
		raws, err := scanRawChannelRows(rows)
		if err != nil {
			return err
		}
		for _, rc := range raws {
			d, derr := s.decryptChannelRow(ctx, tx, orgID, rc, true)
			if derr != nil {
				return derr
			}
			out = append(out, d)
		}
		return nil
	})
	if err != nil {
		return nil, err
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

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// RLS: scope this tx to the caller's org before any RLS table is touched.
	if err := setOrgGUC(ctx, tx, orgID); err != nil {
		return nil, err
	}

	if err := requireChannelMember(ctx, tx, orgID, channelID, callerID); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx,
		// display_name alongside username: `username` is the email local-part, so
		// on its own it renders "j.okafor" over every channel message.
		`SELECT m.id, m.channel_id, m.seq, m.sender_id,
		        COALESCE(up.username, ''), COALESCE(up.display_name, ''),
		        m.body, m.body_enc, m.created_at, m.kind
		 FROM channel_messages m
		 LEFT JOIN user_projection up ON up.user_id = m.sender_id
		 WHERE m.channel_id = $1 AND m.seq < $2
		 ORDER BY m.seq DESC
		 LIMIT $3`, channelID, beforeSeq, limit)
	if err != nil {
		return nil, err
	}

	// Buffer raw rows, then close the cursor BEFORE decrypting on the same tx
	// (a Decrypt query while rows is open would error with "conn busy").
	type rawChMsg struct {
		m       ChannelMessageDTO
		created time.Time
		bodyTxt *string
		bodyEnc []byte
		kind    string
	}
	var raws []rawChMsg
	for rows.Next() {
		var r rawChMsg
		if err := rows.Scan(&r.m.ID, &r.m.ChannelID, &r.m.Seq, &r.m.SenderID,
			&r.m.SenderUsername, &r.m.SenderDisplayName,
			&r.bodyTxt, &r.bodyEnc, &r.created, &r.kind); err != nil {
			rows.Close()
			return nil, err
		}
		raws = append(raws, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Selected newest-first so the index could serve the LIMIT; the wire format
	// is oldest-first.
	reverseRaw(raws)

	out := []ChannelMessageDTO{}
	for _, r := range raws {
		m := r.m
		// body_enc is the source of truth; legacy plaintext body is the fallback.
		if r.bodyEnc != nil {
			dec, derr := s.crypto.Decrypt(ctx, tx, orgID, r.bodyEnc)
			if derr != nil {
				return nil, derr
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
		out = append(out, m)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
