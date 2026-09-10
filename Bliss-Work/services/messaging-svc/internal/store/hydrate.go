package store

import "context"

// HydratedMessage is a server-side-reconstructed message.created event,
// rebuilt from a compact Redis outbox reference (eventId + messageId) per
// docs/REDIS-REPLAY-RECORD-OPTIMIZATION.md sections H/S. orgId and
// clientMsgId are deliberately absent from this shape — both were confirmed
// unused by every client this report traced (packages/shared/src/ws-client/
// WsClient.ts and its consumers across web/mobile/desktop); every other
// field the original wire event carried is reconstructed faithfully since
// they were NOT all individually confirmed droppable.
type HydratedMessage struct {
	MessageID       string
	ConversationID  string
	ThreadID        string
	ParentMessageID string
	IsThreadRoot    bool
	Seq             int64
	SenderID        string
	RecipientID     string
	Body            string
	OccurredAt      string
	Kind            string
	Origin          string
	ReplyToID       string
	IsForward       bool
	ForwardPlatform string
}

// HydrateMessages reconstructs full message.created content for a batch of
// message IDs, keyed by messageId. An id that is missing, or whose message
// was deleted-for-all, is simply absent from the result — mirrors
// fetchDeliveryCandidatesTx's "unknown ids are simply absent" posture rather
// than failing the whole batch over one bad/stale reference.
//
// RLS bypass, same posture and reasoning as MarkDelivered (receipts.go):
// this is a trusted internal service-to-service path (ws-gateway replay)
// with no single caller org in scope — a user's replay outbox can carry
// references spanning however many orgs they belong to, so each row's org
// is resolved from the message itself, not from a caller-supplied org.
//
// Connection-hold-safe by construction: decrypts happen AFTER the
// transaction below commits and its pooled connection is released,
// following the same Warm-then-release split ListConversations uses (see
// its own doc comment) — and which ListMessages/ListThreadMessages, the
// REST backfill endpoints, do NOT yet use (a gap the optimization report's
// section I flagged; this function does not inherit it).
func (s *Store) HydrateMessages(ctx context.Context, messageIDs []string) (map[string]HydratedMessage, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	var (
		orgByMsg  map[string]string
		raws      []rawMessage
		threadIDs []string
	)

	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		orgByMsg = map[string]string{}
		raws = nil
		threadIDs = nil

		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setBypassGUC(ctx, tx); err != nil {
			return err
		}

		// Org lookup is a separate, narrow query rather than folded into the
		// messageColumns SELECT below: messageColumns/scanRawMessage is a
		// shared, fixed-order contract with two other readers (conversations,
		// threads), and prepending a column there would silently break their
		// scan order — the exact bug class threads.go's own comment on
		// messageColumns warns about. Two cheap `= ANY($1)` queries in one
		// transaction is a better trade than touching a shared constant.
		orgRows, err := tx.Query(ctx, `SELECT id, org_id FROM messages WHERE id = ANY($1)`, messageIDs)
		if err != nil {
			return err
		}
		for orgRows.Next() {
			var id, orgID string
			if err := orgRows.Scan(&id, &orgID); err != nil {
				orgRows.Close()
				return err
			}
			orgByMsg[id] = orgID
		}
		orgRows.Close()
		if err := orgRows.Err(); err != nil {
			return err
		}

		rows, err := tx.Query(ctx, `SELECT `+messageColumns+`
			FROM messages m `+messageDeliveryJoin+`
			WHERE m.id = ANY($1)`, messageIDs)
		if err != nil {
			return err
		}
		seenThread := map[string]struct{}{}
		for rows.Next() {
			r, err := scanRawMessage(rows)
			if err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
			if r.m.ThreadID != "" {
				if _, ok := seenThread[r.m.ThreadID]; !ok {
					seenThread[r.m.ThreadID] = struct{}{}
					threadIDs = append(threadIDs, r.m.ThreadID)
				}
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// Warm every DEK version this batch needs WHILE the connection is
		// still open — grouped per org, since a DEK cache is per-org and this
		// batch may legitimately span more than one (see doc comment above).
		versionsByOrg := map[string]map[int]struct{}{}
		for _, r := range raws {
			if r.bodyEnc == nil {
				continue
			}
			orgID := orgByMsg[r.m.ID]
			if orgID == "" {
				continue
			}
			v, ok := s.crypto.PeekVersion(r.bodyEnc)
			if !ok {
				continue
			}
			if versionsByOrg[orgID] == nil {
				versionsByOrg[orgID] = map[int]struct{}{}
			}
			versionsByOrg[orgID][v] = struct{}{}
		}
		for orgID, versions := range versionsByOrg {
			if err := s.crypto.WarmVersions(ctx, tx, orgID, versions); err != nil {
				return err
			}
		}

		return tx.Commit(ctx)
	})
	if err != nil {
		return nil, err
	}
	if len(raws) == 0 {
		return map[string]HydratedMessage{}, nil
	}

	threadByID, err := s.threadsByIDs(ctx, threadIDs)
	if err != nil {
		return nil, err
	}

	// Decrypt with NO open connection at all — see the doc comment above.
	out := make(map[string]HydratedMessage, len(raws))
	for _, r := range raws {
		m := r.m
		body := ""
		if !m.DeletedForAll {
			switch {
			case r.bodyEnc != nil:
				orgID := orgByMsg[m.ID]
				dec, derr := s.crypto.DecryptCached(orgID, r.bodyEnc)
				if derr != nil {
					return nil, derr
				}
				body = dec
			case r.bodyTxt != nil:
				body = *r.bodyTxt
			}
		}

		th := threadByID[m.ThreadID]
		out[m.ID] = HydratedMessage{
			MessageID:       m.ID,
			ConversationID:  m.ConversationID,
			ThreadID:        m.ThreadID,
			ParentMessageID: derefOr(m.ParentMessageID, ""),
			IsThreadRoot:    m.IsThreadRoot,
			Seq:             m.Seq,
			SenderID:        m.SenderID,
			RecipientID:     th.recipientID,
			Body:            body,
			OccurredAt:      m.CreatedAt,
			Kind:            m.Kind,
			Origin:          th.origin,
			ReplyToID:       m.ReplyToID,
			IsForward:       m.IsForward,
			ForwardPlatform: m.ForwardPlatform,
		}
	}
	return out, nil
}

type hydratedThread struct {
	origin      string
	recipientID string
}

// threadsByIDs bulk-resolves origin + recipientId for a set of thread ids,
// in one query regardless of batch size — the same `= ANY($1)` shape as
// everything else in this file. RLS-bypassed for the same reason as
// HydrateMessages: the batch may span threads from more than one org.
func (s *Store) threadsByIDs(ctx context.Context, threadIDs []string) (map[string]hydratedThread, error) {
	out := map[string]hydratedThread{}
	if len(threadIDs) == 0 {
		return out, nil
	}
	err := RetryOnSerializationFailure(ctx, 3, func(ctx context.Context) error {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := setBypassGUC(ctx, tx); err != nil {
			return err
		}
		rows, err := tx.Query(ctx,
			`SELECT id, origin, recipient_id FROM threads WHERE id = ANY($1)`, threadIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, origin, recipientID string
			if err := rows.Scan(&id, &origin, &recipientID); err != nil {
				rows.Close()
				return err
			}
			out[id] = hydratedThread{origin: origin, recipientID: recipientID}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		return tx.Commit(ctx)
	})
	return out, err
}

func derefOr(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}
