package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/media"
)

// Re-scoping attachments when a message is forwarded.
//
// ── The problem this solves ──────────────────────────────────────────────────
// An attachment is authorized by (scope, scope_id), decided at upload and
// re-checked on every download (0010_attachments.sql). Forwarding clones the
// message BODY verbatim, so the ids inside it still point at rows scoped to the
// SOURCE conversation — which the recipient is not in. Every tile in the
// forwarded message rendered "Not available to you", and the UI hid the Forward
// action for media rather than ship that.
//
// ── What is cloned, and what is not ──────────────────────────────────────────
// The ROWS are cloned; the BYTES are not. Blobs are content-addressed by sha256
// and stored once per org (internal/blob), so a clone is a new authorization
// record pointing at storage that already exists — no copy, no extra disk, and
// the reaper's existing sha256 sibling check keeps it correct.
//
// The clone is created ALREADY COMMITTED (expires_at NULL). The 24h reaper
// exists because an abandoned upload is unreachable — the server cannot read an
// encrypted body to discover what it references — but this row is created in the
// same transaction as the message that references it, so there is no window in
// which it is orphaned.

// recloneAttachments copies every attachment referenced by `body` into
// `destScopeID` and returns the rewritten body, or "" when there is nothing to
// do (plain text, a location, a v1 file offer, or a body whose attachments the
// forwarder cannot read).
//
// Failures degrade rather than block: an attachment the forwarder may not read
// is skipped and its id left as-is, which is exactly the behaviour that existed
// before. Refusing the whole forward because one tile could not be copied would
// be a worse answer than the one the user already had.
func (s *Store) recloneAttachments(
	ctx context.Context,
	tx pgx.Tx,
	orgID, forwarderID, body, destScopeID string,
) (string, error) {
	env := media.ParseEnvelope(body)
	ids := env.AttachmentIDs()
	if len(ids) == 0 {
		return "", nil
	}

	// Read the source rows, but ONLY those the forwarder can actually reach.
	// Without this membership gate, forwarding would be a way to launder any
	// attachment id into a conversation of your choosing: paste an id you are
	// not entitled to into a body, forward it, and the clone would grant it to
	// you. The scope check is the same one downloadMedia applies.
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.uploader_id::text, a.role, a.parent_attachment_id::text,
		       a.sha256, a.mime, a.size_bytes, a.filename, a.filename_enc,
		       a.width, a.height, a.duration_ms, a.storage_path
		FROM attachments a
		WHERE a.id = ANY($1) AND a.org_id = $2
		  AND (
		      (a.scope = 'conversation' AND EXISTS (
		          SELECT 1 FROM conversation_members cm
		          WHERE cm.conversation_id = a.scope_id AND cm.user_id = $3))
		   OR (a.scope = 'thread' AND EXISTS (
		          SELECT 1 FROM thread_members tm
		          WHERE tm.thread_id = a.scope_id AND tm.user_id = $3))
		   OR (a.scope = 'channel' AND EXISTS (
		          SELECT 1 FROM channel_members chm
		          WHERE chm.channel_id = a.scope_id AND chm.user_id = $3))
		  )`,
		ids, orgID, forwarderID)
	if err != nil {
		return "", err
	}

	type srcRow struct {
		id, uploader, role string
		parent             *string
		sha256, mime       string
		size               int64
		filename           *string
		filenameEnc        []byte
		width, height, dur *int
		storagePath        string
	}
	var srcs []srcRow
	for rows.Next() {
		var r srcRow
		if err := rows.Scan(&r.id, &r.uploader, &r.role, &r.parent, &r.sha256, &r.mime,
			&r.size, &r.filename, &r.filenameEnc, &r.width, &r.height, &r.dur, &r.storagePath); err != nil {
			rows.Close()
			return "", err
		}
		srcs = append(srcs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(srcs) == 0 {
		return "", nil
	}

	// Mint the new ids up front so a thumb can point at its cloned parent
	// rather than at the original — a poster left pointing across scopes would
	// be deleted out from under the clone when the source is.
	mapping := make(map[string]string, len(srcs))
	for _, r := range srcs {
		mapping[r.id] = uuid.Must(uuid.NewV7()).String()
	}

	for _, r := range srcs {
		var parentArg *string
		if r.parent != nil {
			if mapped, ok := mapping[*r.parent]; ok {
				parentArg = &mapped
			}
			// A parent outside this forward is deliberately dropped rather than
			// pointed at the original: the FK cascades on delete, and a clone
			// that vanishes when an unrelated conversation is cleaned up is
			// worse than a clone with no parent link.
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, parent_attachment_id,
			   sha256, mime, size_bytes, filename, filename_enc,
			   width, height, duration_ms, storage_path, expires_at)
			VALUES ($1, $2, $3, 'conversation', $4, $5, $6,
			        $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL)`,
			mapping[r.id], orgID, r.uploader, destScopeID, r.role, parentArg,
			r.sha256, r.mime, r.size, r.filename, r.filenameEnc,
			r.width, r.height, r.dur, r.storagePath); err != nil {
			return "", err
		}
	}

	next, ok := env.RewriteMediaIDs(mapping)
	if !ok {
		return "", nil
	}
	return next, nil
}
