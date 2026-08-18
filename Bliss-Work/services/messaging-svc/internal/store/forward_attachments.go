package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Re-scoping the files a forwarded message carries.
//
// An attachment's ACL is the (scope, scope_id) it was uploaded to, re-checked on
// every download. Copying a media body verbatim into another chat would
// therefore deliver ids the recipient is not a member of, and every tile would
// render as unavailable — which is why forwarding media used to be hidden
// outright. The fix is a new attachments row per file, pointing at the SAME
// content-addressed blob, owned by the destination scope.
//
// No bytes are copied. sha256 and storage_path are carried across unchanged, and
// the reaper only unlinks a blob once no row in the org references its sha, so
// the clone keeps the original alive and vice versa.
//
// A clone therefore consumes no disk, but it DOES count against the org's
// rolling daily allowance (OrgMediaBytesLast24h sums size_bytes over rows, not
// over distinct blobs). That is the conservative direction on purpose: without
// it, forwarding one 100 MB file a thousand times would be free, and each hop
// still costs a row, an ACL and a download the server has to serve.

// maxForwardAttachments bounds one forward's clone work: MEDIA_MAX_FILES (10)
// files plus a poster each, with headroom. A body claiming more than this is not
// something this product can have produced.
const maxForwardAttachments = 24

// srcAttachment is one attachment row being cloned, loaded before any
// membership query runs — a second query while pgx.Rows is open on the same tx
// fails with "conn busy".
type srcAttachment struct {
	id          string
	scope       string
	scopeID     string
	role        string
	parentID    *string
	sha256      string
	mime        string
	sizeBytes   int64
	filenameEnc []byte
	filename    *string
	width       *int
	height      *int
	durationMS  *int
	storagePath string
}

// cloneAttachmentsInto copies `ids` into (scope, scopeID) and returns a map from
// source id to clone id. Ids the forwarder may not read are silently omitted
// from the map; rewriteMediaAttachmentIDs drops the items that reference them.
//
// The membership re-check is not redundant with the one the source message
// already passed. A body is written by a CLIENT and names its own attachment
// ids, so a hostile sender could reference a file from some other conversation
// they belong to; without this check, forwarding their message would launder it
// into a scope neither of them was authorized for.
func (s *Store) cloneAttachmentsInto(
	ctx context.Context, tx pgx.Tx, orgID, forwarderID, scope, scopeID string, ids []string,
) (map[string]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > maxForwardAttachments {
		ids = ids[:maxForwardAttachments]
	}

	sources, err := loadAttachmentsForClone(ctx, tx, orgID, ids)
	if err != nil {
		return nil, err
	}

	// Memoized per source scope: ten photos from one conversation ask once.
	readable := make(map[[2]string]bool, len(sources))
	remap := make(map[string]string, len(sources))
	for _, src := range sources {
		key := [2]string{src.scope, src.scopeID}
		allowed, seen := readable[key]
		if !seen {
			err := requireScopeMember(ctx, tx, orgID, src.scope, src.scopeID, forwarderID)
			if err != nil && !errors.Is(err, ErrForbidden) {
				return nil, err
			}
			allowed = err == nil
			readable[key] = allowed
		}
		if !allowed {
			continue
		}

		// A poster whose file did not clone has nothing to hang off, and
		// parent_attachment_id CASCADEs on delete — grafting it onto the
		// original would make deleting the source take the clone's poster with
		// it. loadAttachmentsForClone returns files before thumbs, so the parent
		// is already in `remap` if it cloned at all.
		var parentArg *string
		if src.parentID != nil {
			cloneParent, ok := remap[*src.parentID]
			if !ok {
				continue
			}
			parentArg = &cloneParent
		}

		cloneID := uuid.Must(uuid.NewV7()).String()
		// expires_at stays NULL: the referencing message is written in THIS
		// transaction, so unlike an upload there is no window in which the row
		// might turn out to be unreferenced. The 24h reaper exists for uploads
		// the user abandoned, which cannot happen here.
		if _, err := tx.Exec(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, parent_attachment_id,
			   sha256, mime, size_bytes, filename, filename_enc,
			   width, height, duration_ms, storage_path, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NULL)`,
			cloneID, orgID, forwarderID, scope, scopeID, src.role, parentArg,
			src.sha256, src.mime, src.sizeBytes, src.filename, src.filenameEnc,
			src.width, src.height, src.durationMS, src.storagePath); err != nil {
			return nil, err
		}
		remap[src.id] = cloneID
	}
	return remap, nil
}

// loadAttachmentsForClone reads the rows to copy, FILES FIRST. The ordering is
// what lets the caller resolve a thumbnail's parent in a single pass instead of
// walking the list twice.
func loadAttachmentsForClone(
	ctx context.Context, tx pgx.Tx, orgID string, ids []string,
) ([]srcAttachment, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, scope, scope_id::text, role, parent_attachment_id::text,
		       sha256, mime, size_bytes, filename, filename_enc,
		       width, height, duration_ms, storage_path
		  FROM attachments
		 WHERE org_id = $1 AND id = ANY($2::uuid[])
		 ORDER BY (role = 'thumb'), id`, orgID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []srcAttachment
	for rows.Next() {
		var a srcAttachment
		if err := rows.Scan(&a.id, &a.scope, &a.scopeID, &a.role, &a.parentID,
			&a.sha256, &a.mime, &a.sizeBytes, &a.filename, &a.filenameEnc,
			&a.width, &a.height, &a.durationMS, &a.storagePath); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
