package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// InboxItemDTO is one unified-inbox row returned by GET /inbox.
type InboxItemDTO struct {
	OwnerUserID     string  `json:"ownerUserId"`
	ItemKind        string  `json:"itemKind"` // "THREAD" | "TASK"
	RefID           string  `json:"refId"`    // threadId or taskId
	PeerUserID      *string `json:"peerUserId"`
	PeerUsername    *string `json:"peerUsername"`
	Preview         string  `json:"preview"`
	LastEventAt     string  `json:"lastEventAt"`
	UnreadCount     int64   `json:"unreadCount"`
	StatusBadge     *string `json:"statusBadge"`
	HiddenForOwner  bool    `json:"hiddenForOwner"`
	DeletedForOwner bool    `json:"deletedForOwner"`
}

// InboxPageDTO is a keyset-paginated page of the unified inbox.
type InboxPageDTO struct {
	Items      []InboxItemDTO `json:"items"`
	NextCursor *string        `json:"nextCursor"`
}

// InboxPeerDTO is one row of the people sidebar: a distinct counterparty the
// caller has inbox items with, plus the rollups that drive the list ordering
// and unread badge. Returned by GET /inbox/peers.
type InboxPeerDTO struct {
	PeerUserID  string  `json:"peerId"`
	Username    *string `json:"username"`
	DisplayName *string `json:"displayName"`
	LastEventAt string  `json:"lastEventAt"`
	UnreadCount int64   `json:"unreadCount"`
	ItemCount   int64   `json:"itemCount"`
}

// upsertThreadInboxItem writes (or refreshes) the (owner, THREAD, threadId)
// inbox_items row. Called once per side (sender + recipient) inside the same
// tx as a message insert.
//
// last_event_at uses GREATEST(target, EXCLUDED) so out-of-order projector
// writes can never rewind a row to an older timestamp.
//
// unread_count: for the recipient side, bumps when the sender is NOT the
// owner; for the sender side, never bumps. Caller passes incUnread.
//
// The preview is encrypted under the org DEK into preview_enc (the plaintext
// `preview` column is written NULL); the DEK is created lazily inside the
// caller's tx. ON CONFLICT copies EXCLUDED.preview_enc so a fresh write
// refreshes the ciphertext preview.
func (s *Store) upsertThreadInboxItem(
	ctx context.Context,
	tx pgx.Tx,
	orgID, ownerUserID, threadID, peerUserID, preview, statusBadge string,
	lastEventAt time.Time,
	incUnread int,
) error {
	previewEnc, err := s.crypto.Encrypt(ctx, tx, orgID, preview)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO inbox_items
		  (org_id, owner_user_id, item_kind, ref_id, peer_user_id, preview, preview_enc,
		   last_event_at, unread_count, status_badge,
		   hidden_for_owner, deleted_for_owner, updated_at)
		VALUES ($1, $2, 'THREAD', $3, $4, NULL, $5, $6, $7, $8, false, false, now())
		ON CONFLICT (owner_user_id, item_kind, ref_id)
		DO UPDATE SET
		    last_event_at    = GREATEST(inbox_items.last_event_at, EXCLUDED.last_event_at),
		    preview          = NULL,
		    preview_enc      = EXCLUDED.preview_enc,
		    unread_count     = inbox_items.unread_count + $7,
		    status_badge     = COALESCE(EXCLUDED.status_badge, inbox_items.status_badge),
		    hidden_for_owner = false,        -- Reply REVIVES on both sides.
		    updated_at       = now()`,
		orgID, ownerUserID, threadID, peerUserID, previewEnc,
		lastEventAt, incUnread, statusBadge)
	return err
}

// ClearThreadUnread resets unread_count to 0 for the (owner, threadId) row.
// Called from MarkRead.
func ClearThreadUnread(ctx context.Context, tx pgx.Tx, ownerUserID, threadID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE inbox_items
		SET unread_count = 0, updated_at = now()
		WHERE owner_user_id = $1 AND item_kind = 'THREAD' AND ref_id = $2`,
		ownerUserID, threadID)
	return err
}

// ListInbox returns one keyset-paginated page of the caller's unified inbox.
// Cursor format: base64(JSON {ts: ISO8601, refId: uuid}). Empty cursor = page 1.
//
// When peerID is non-empty the feed is restricted to items whose counterparty
// is that user (the People-sidebar drill-down); empty peerID returns everything.
//
// Items are filtered to (NOT hidden_for_owner AND NOT deleted_for_owner). Both
// hidden and deleted are restored by a fresh write — Reply on an ignored thread
// flips hidden_for_owner back to false in upsertThreadInboxItem.
func (s *Store) ListInbox(
	ctx context.Context, orgID, ownerUserID, peerID, cursor string, limit int,
) (*InboxPageDTO, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}

	cursorTs, cursorRef, err := decodeInboxCursor(cursor)
	if err != nil {
		return nil, fmt.Errorf("bad cursor: %w", err)
	}

	// First-page cursor has an empty ref; the `$3 = ''` guard already makes the
	// keyset comparison a no-op, but Postgres does NOT guarantee left-to-right
	// OR short-circuiting and may still evaluate `i.ref_id < $5`. Pass a valid
	// sentinel uuid so that branch can never raise `''::uuid` (22P02).
	if cursorRef == "" {
		cursorRef = "00000000-0000-0000-0000-000000000000"
	}

	// Likewise pass SQL NULL (not '') when there is no peer filter so the cast
	// in `$7::uuid` is applied to NULL, never to an empty string.
	var peerArg *string
	if peerID != "" {
		peerArg = &peerID
	}

	// preview-raw holds one row's columns BEFORE decrypt so the cursor is drained
	// before any Decrypt query runs on the same tx ("conn busy" otherwise).
	type rawInbox struct {
		it         InboxItemDTO
		lastAt     time.Time
		previewPln *string
		previewEnc []byte
	}

	items := make([]InboxItemDTO, 0, limit+1)
	// RLS: keyset read + per-row decrypt run under app.org_id.
	rerr := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Plus one to detect whether another page exists.
		rows, err := tx.Query(ctx, `
			SELECT
			    i.owner_user_id, i.item_kind, i.ref_id, i.peer_user_id,
			    COALESCE(up.username, NULL) AS peer_username,
			    i.preview, i.preview_enc, i.last_event_at, i.unread_count, i.status_badge,
			    i.hidden_for_owner, i.deleted_for_owner
			FROM inbox_items i
			LEFT JOIN user_projection up ON up.user_id = i.peer_user_id
			WHERE i.owner_user_id = $1
			  AND i.org_id = $2
			  AND NOT i.hidden_for_owner
			  AND NOT i.deleted_for_owner
			  AND ($7::uuid IS NULL OR i.peer_user_id = $7::uuid)
			  AND (
			      $3 = '' OR
			      i.last_event_at < $4 OR
			      (i.last_event_at = $4 AND i.ref_id < $5)
			  )
			ORDER BY i.last_event_at DESC, i.ref_id DESC
			LIMIT $6`,
			ownerUserID, orgID,
			cursor, cursorTs, cursorRef,
			limit+1,
			peerArg,
		)
		if err != nil {
			return err
		}
		var raws []rawInbox
		for rows.Next() {
			var r rawInbox
			if err := rows.Scan(
				&r.it.OwnerUserID, &r.it.ItemKind, &r.it.RefID, &r.it.PeerUserID,
				&r.it.PeerUsername, &r.previewPln, &r.previewEnc, &r.lastAt, &r.it.UnreadCount,
				&r.it.StatusBadge, &r.it.HiddenForOwner, &r.it.DeletedForOwner,
			); err != nil {
				rows.Close()
				return err
			}
			raws = append(raws, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range raws {
			it := r.it
			// preview_enc is the source of truth for rows written post-encryption;
			// fall back to the legacy plaintext column for un-backfilled rows.
			if r.previewEnc != nil {
				dec, derr := s.crypto.Decrypt(ctx, tx, orgID, r.previewEnc)
				if derr != nil {
					return derr
				}
				it.Preview = dec
			} else if r.previewPln != nil {
				it.Preview = *r.previewPln
			}
			it.LastEventAt = r.lastAt.UTC().Format("2006-01-02T15:04:05.000Z")
			items = append(items, it)
		}
		return nil
	})
	if rerr != nil {
		return nil, rerr
	}

	var nextCursor *string
	if len(items) > limit {
		last := items[limit-1]
		c := encodeInboxCursor(last.LastEventAt, last.RefID)
		nextCursor = &c
		items = items[:limit]
	}
	return &InboxPageDTO{Items: items, NextCursor: nextCursor}, nil
}

// ListInboxPeers returns the distinct counterparties in the caller's visible
// inbox, newest-activity first, with per-peer unread and item rollups. Powers
// the People sidebar. Same visibility predicate as ListInbox; rows with a NULL
// peer (none today) are excluded.
func (s *Store) ListInboxPeers(
	ctx context.Context, orgID, ownerUserID string,
) ([]InboxPeerDTO, error) {
	out := make([]InboxPeerDTO, 0, 16)
	// RLS: aggregate read runs under app.org_id.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT
			    i.peer_user_id,
			    up.username,
			    up.display_name,
			    MAX(i.last_event_at)            AS last_event_at,
			    COALESCE(SUM(i.unread_count),0) AS unread_count,
			    COUNT(*)                        AS item_count
			FROM inbox_items i
			LEFT JOIN user_projection up ON up.user_id = i.peer_user_id
			WHERE i.owner_user_id = $1
			  AND i.org_id = $2
			  AND NOT i.hidden_for_owner
			  AND NOT i.deleted_for_owner
			  AND i.peer_user_id IS NOT NULL
			GROUP BY i.peer_user_id, up.username, up.display_name
			ORDER BY last_event_at DESC`,
			ownerUserID, orgID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var p InboxPeerDTO
			var lastAt time.Time
			if err := rows.Scan(
				&p.PeerUserID, &p.Username, &p.DisplayName,
				&lastAt, &p.UnreadCount, &p.ItemCount,
			); err != nil {
				return err
			}
			p.LastEventAt = lastAt.UTC().Format("2006-01-02T15:04:05.000Z")
			out = append(out, p)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// MarkInboxItemHidden flips hidden_for_owner for a single (owner, kind, ref)
// row. Called by /inbox/items/{id}/ignore (the non-thread-scoped path).
//
// RLS: this is a request path, so it carries the caller's org. The UPDATE runs
// inside withOrg; the org_isolation policy's WITH CHECK + USING ensures the row
// must already belong to orgID (a cross-org refId matches 0 rows → ErrForbidden).
func (s *Store) MarkInboxItemHidden(
	ctx context.Context, orgID, ownerUserID, itemKind, refID string,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE inbox_items
			SET hidden_for_owner = true, updated_at = now()
			WHERE owner_user_id = $1 AND item_kind = $2 AND ref_id = $3`,
			ownerUserID, itemKind, refID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return ErrForbidden
		}
		return nil
	})
}

// MarkInboxItemRead zeros unread_count for a single (owner, kind, ref) row.
// Called by POST /inbox/items/{kind}/{refId}/read when the user opens a TASK row
// in the unified inbox. TASK rows have no seq-based read model (that's THREADs),
// so "seen" is a straight unread reset. This is the path that finally clears the
// task-inbox badge, which otherwise stays at its seeded unread_count=1 forever.
// Idempotent: re-marking an already-read row still matches (WHERE ignores the
// count) and returns nil.
//
// RLS: request path — carries the caller's org via withOrg; the org_isolation
// WITH CHECK + USING means a cross-org refId matches 0 rows → ErrForbidden.
func (s *Store) MarkInboxItemRead(
	ctx context.Context, orgID, ownerUserID, itemKind, refID string,
) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		ct, err := tx.Exec(ctx, `
			UPDATE inbox_items
			SET unread_count = 0, updated_at = now()
			WHERE owner_user_id = $1 AND item_kind = $2 AND ref_id = $3`,
			ownerUserID, itemKind, refID)
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return ErrForbidden
		}
		return nil
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor encoding — base64(JSON {ts, refId}). Opaque to clients; tuple keyed
// pagination requires both fields because uuidv7 collisions inside a single
// microsecond are possible at high write volume.
// ─────────────────────────────────────────────────────────────────────────────

type inboxCursor struct {
	Ts    string `json:"ts"`
	RefID string `json:"refId"`
}

func encodeInboxCursor(ts, refID string) string {
	raw, _ := json.Marshal(inboxCursor{Ts: ts, RefID: refID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeInboxCursor(s string) (time.Time, string, error) {
	if s == "" {
		// Sentinel: returns rows strictly less than "now+1s" / any ref_id.
		return time.Now().UTC().Add(time.Second), "", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, "", err
	}
	var c inboxCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return time.Time{}, "", err
	}
	ts, err := time.Parse(time.RFC3339Nano, c.Ts)
	if err != nil {
		return time.Time{}, "", err
	}
	return ts, c.RefID, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Task projection helpers (Phase 2). The task projector consumer (a separate
// Kafka group inside messaging-svc) calls these to materialize TASK rows in
// inbox_items alongside the THREAD rows written by appendMessage.
//
// Rules:
//   - InsertTaskInboxItem is called on task.assigned. Preview is WRITE-ONCE —
//     subsequent transitions (acknowledged/completed/ignored/left) UPDATE only
//     status_badge, last_event_at, and hidden_for_owner.
//   - UpdateTaskStatusBadge is called on every transition. It is a no-op when
//     the row doesn't exist (the projector may race the InsertTaskInboxItem
//     across topic partitions; the Insert wins next time the InsertTask side
//     fires).
//   - HideTaskInboxItem flips hidden_for_owner=true on task.ignored. A reopen
//     would require a new task.assigned with the same taskId (out of scope).
// ─────────────────────────────────────────────────────────────────────────────

// InsertTaskInboxItem creates the (assignee, TASK, taskId) row on TaskAssigned.
// Idempotent: ON CONFLICT keeps the existing preview (write-once semantics).
func (s *Store) InsertTaskInboxItem(
	ctx context.Context,
	orgID, assigneeID, taskID, senderID, title, description string,
	occurredAt time.Time,
) error {
	preview := truncatePreview(title)
	if description != "" {
		// Title carries most signal; only fall back if title is empty.
		if preview == "" {
			preview = truncatePreview(description)
		}
	}

	// A tx so the org DEK (org_keys row) and the inbox row are created
	// atomically; the DEK lookup MUST share the insert's tx.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// RLS: the task projector is a cross-org BACKGROUND consumer (it processes
	// task.events for every org off one Kafka stream), so it runs under BYPASS.
	// This also lets crypto.Encrypt read/write the org_keys row freely.
	if err := setBypassGUC(ctx, tx); err != nil {
		return err
	}

	previewEnc, err := s.crypto.Encrypt(ctx, tx, orgID, preview)
	if err != nil {
		return err
	}
	// Preview is WRITE-ONCE: ON CONFLICT keeps the existing preview_enc (the
	// row was seeded by an earlier task.assigned), so no preview_enc update here.
	if _, err := tx.Exec(ctx, `
		INSERT INTO inbox_items
		  (org_id, owner_user_id, item_kind, ref_id, peer_user_id, preview, preview_enc,
		   last_event_at, unread_count, status_badge,
		   hidden_for_owner, deleted_for_owner, updated_at)
		VALUES ($1, $2, 'TASK', $3, $4, NULL, $5, $6, 1, 'SENT', false, false, now())
		ON CONFLICT (owner_user_id, item_kind, ref_id)
		DO UPDATE SET
		    last_event_at = GREATEST(inbox_items.last_event_at, EXCLUDED.last_event_at),
		    status_badge  = COALESCE(inbox_items.status_badge, EXCLUDED.status_badge),
		    updated_at    = now()`,
		orgID, assigneeID, taskID, senderID, previewEnc, occurredAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// UpdateTaskStatusBadge bumps last_event_at and rewrites status_badge for a
// task inbox row. No-op if the row hasn't been seeded yet (the InsertTaskInboxItem
// path will run when the corresponding TaskAssigned arrives).
func (s *Store) UpdateTaskStatusBadge(
	ctx context.Context,
	assigneeID, taskID, statusBadge string,
	occurredAt time.Time,
) error {
	// RLS: cross-org background task projector → BYPASS (no caller org in scope;
	// only assigneeID + taskID are known here).
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE inbox_items
			SET status_badge  = $4,
			    last_event_at = GREATEST(last_event_at, $5),
			    updated_at    = now()
			WHERE owner_user_id = $1 AND item_kind = 'TASK' AND ref_id = $2
			  AND ($3 = '' OR status_badge IS DISTINCT FROM $3)`,
			assigneeID, taskID, statusBadge, statusBadge, occurredAt)
		return err
	})
}

// HideTaskInboxItem flips hidden_for_owner=true on task.ignored.
func (s *Store) HideTaskInboxItem(
	ctx context.Context, assigneeID, taskID string, occurredAt time.Time,
) error {
	// RLS: cross-org background task projector → BYPASS.
	return s.withBypass(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE inbox_items
			SET hidden_for_owner = true,
			    status_badge     = 'IGNORED',
			    last_event_at    = GREATEST(last_event_at, $3),
			    updated_at       = now()
			WHERE owner_user_id = $1 AND item_kind = 'TASK' AND ref_id = $2`,
			assigneeID, taskID, occurredAt)
		return err
	})
}
