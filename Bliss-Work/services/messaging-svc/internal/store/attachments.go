package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Attachment scopes. These name the four membership tables that can authorize
// a file, and cover every send path (DM send, DM reply, thread reply, channel
// send, mail compose).
const (
	ScopeConversation = "conversation"
	ScopeThread       = "thread"
	ScopeChannel      = "channel"
	// ScopeMail's scope_id is a mail_messages.id and its membership table is
	// mail_deliveries. Uniquely among the four, the destination is created
	// BEFORE anyone else can read it: the composer opens a draft, which gives
	// the author a mail_deliveries row to upload against, and the recipients'
	// rows appear only when Send fans the mail out.
	ScopeMail = "mail"
)

// ValidAttachmentScope reports whether a client-supplied scope is one we accept.
// The API layer calls this before anything touches the database.
func ValidAttachmentScope(s string) bool {
	return s == ScopeConversation || s == ScopeThread || s == ScopeChannel || s == ScopeMail
}

// Attachment roles.
const (
	RoleFile  = "file"
	RoleThumb = "thumb"
)

// ErrNotFound is returned when a row does not exist (or is invisible under RLS,
// which is indistinguishable by design and equally correct to report as absent).
var ErrNotFound = errors.New("not found")

// ErrQuotaExceeded is returned when an org has uploaded more than its rolling
// daily byte allowance.
var ErrQuotaExceeded = errors.New("upload quota exceeded")

// AttachmentDTO is the API shape of a stored attachment. `Filename` is the
// DECRYPTED name — every read path decrypts inside the same tx as the load,
// because org_keys is itself RLS-protected.
type AttachmentDTO struct {
	ID         string `json:"id"`
	Scope      string `json:"scope"`
	ScopeID    string `json:"scopeId"`
	Role       string `json:"role"`
	SHA256     string `json:"sha256"`
	MIME       string `json:"mime"`
	SizeBytes  int64  `json:"sizeBytes"`
	Filename   string `json:"filename"`
	Width      *int   `json:"width,omitempty"`
	Height     *int   `json:"height,omitempty"`
	DurationMS *int   `json:"durationMs,omitempty"`
	CreatedAt  string `json:"createdAt"`

	// OrgID is populated only on the download path (from the signed grant) so
	// the handler can locate the blob. Never serialized.
	OrgID string `json:"-"`
}

// NewAttachment is the input to CreateAttachment.
type NewAttachment struct {
	OrgID       string
	UploaderID  string
	Scope       string
	ScopeID     string
	Role        string
	ParentID    string // "" for a top-level file
	SHA256      string
	MIME        string
	SizeBytes   int64
	Filename    string
	StoragePath string
	Width       *int
	Height      *int
	DurationMS  *int
	TTL         time.Duration // uncommitted lifetime before the reaper claims it
}

// ── membership helpers ───────────────────────────────────────────────────────
//
// requireChannelMember already exists in channels.go. The conversation and
// thread equivalents were previously inlined in replyImpl and GetThread; they
// are extracted here so the attachment path enforces exactly the same rule as
// the send path rather than a lookalike reimplementation of it.

// conversationMembers returns the ordered (low, high) pair and the current
// seq_counter for convID within orgID, after verifying userID is one of the
// two participants. Returns ErrForbidden under the same conditions as
// requireConversationMember (which is defined in terms of this) — seq_counter
// rides along on the same single-row lookup for the callers that need it to
// compute the peer or stamp an event, rather than a second round trip.
func conversationMembers(ctx context.Context, tx pgx.Tx, orgID, convID, userID string) (low, high string, seq int64, err error) {
	var cOrg string
	err = tx.QueryRow(ctx,
		`SELECT org_id, user_low, user_high, seq_counter FROM conversations WHERE id = $1`, convID).
		Scan(&cOrg, &low, &high, &seq)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cOrg != orgID) {
		return "", "", 0, ErrForbidden
	}
	if err != nil {
		return "", "", 0, err
	}
	if userID != low && userID != high {
		return "", "", 0, ErrForbidden
	}
	return low, high, seq, nil
}

// requireConversationMember returns ErrForbidden unless userID is one of the
// two participants of the conversation within orgID.
//
// Mirrors the check inlined in replyImpl: a conversation is a 1:1 ordered pair,
// so membership is "you are user_low or user_high", not a row in
// conversation_members (whose rows also exist for hidden/ignored conversations).
func requireConversationMember(ctx context.Context, tx pgx.Tx, orgID, convID, userID string) error {
	_, _, _, err := conversationMembers(ctx, tx, orgID, convID, userID)
	return err
}

// requireThreadMember returns ErrForbidden unless userID has a thread_members
// row for the thread within orgID.
//
// Mirrors the JOIN in GetThread — membership in the thread, not merely in the
// underlying conversation, because a thread can be deleted-for-owner.
func requireThreadMember(ctx context.Context, tx pgx.Tx, orgID, threadID, userID string) error {
	var exists bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM threads t
			JOIN thread_members tm ON tm.thread_id = t.id AND tm.user_id = $2
			WHERE t.id = $1 AND t.org_id = $3
		)`, threadID, userID, orgID).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}

// requireScopeMember dispatches to the right membership rule. An unknown scope
// is ErrForbidden, not a panic or a pass — fail closed on the enum too.
func requireScopeMember(ctx context.Context, tx pgx.Tx, orgID, scope, scopeID, userID string) error {
	switch scope {
	case ScopeConversation:
		return requireConversationMember(ctx, tx, orgID, scopeID, userID)
	case ScopeThread:
		return requireThreadMember(ctx, tx, orgID, scopeID, userID)
	case ScopeChannel:
		return requireChannelMember(ctx, tx, orgID, scopeID, userID)
	case ScopeMail:
		return requireMailReader(ctx, tx, orgID, scopeID, userID)
	default:
		return ErrForbidden
	}
}

// AuthorizeAttachmentScope verifies the caller may attach to (scope, scopeID).
//
// The upload handler calls this BEFORE reading a single byte of the request
// body: authorizing after the upload would let an unauthorized caller make us
// spool 100 MB to disk for free, over and over.
func (s *Store) AuthorizeAttachmentScope(ctx context.Context, orgID, userID, scope, scopeID string) error {
	if !ValidAttachmentScope(scope) {
		return ErrForbidden
	}
	if _, err := uuid.Parse(scopeID); err != nil {
		return ErrForbidden
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return requireScopeMember(ctx, tx, orgID, scope, scopeID, userID)
	})
}

// OrgMediaBytesLast24h totals the org's uploads over a rolling day, backing the
// MEDIA_ORG_DAILY_BYTES quota. A filesystem has no per-tenant quota of its own,
// so without this one org can fill the volume for every other.
func (s *Store) OrgMediaBytesLast24h(ctx context.Context, orgID string) (int64, error) {
	var total int64
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT COALESCE(sum(size_bytes), 0) FROM attachments
			 WHERE org_id = $1 AND created_at > now() - interval '24 hours'`,
			orgID).Scan(&total)
	})
	return total, err
}

// CreateAttachment records an uploaded blob and returns its DTO.
//
// The row is created EXPIRING (expires_at = now + TTL). It becomes permanent
// only when the client commits it after the referencing message is sent — see
// the migration's note on why the server cannot discover orphans any other way.
func (s *Store) CreateAttachment(ctx context.Context, in NewAttachment) (*AttachmentDTO, error) {
	if !ValidAttachmentScope(in.Scope) {
		return nil, ErrForbidden
	}
	if in.Role != RoleFile && in.Role != RoleThumb {
		return nil, ErrForbidden
	}

	id := uuid.Must(uuid.NewV7()).String()
	out := &AttachmentDTO{
		ID:         id,
		Scope:      in.Scope,
		ScopeID:    in.ScopeID,
		Role:       in.Role,
		SHA256:     in.SHA256,
		MIME:       in.MIME,
		SizeBytes:  in.SizeBytes,
		Filename:   in.Filename,
		Width:      in.Width,
		Height:     in.Height,
		DurationMS: in.DurationMS,
		OrgID:      in.OrgID,
	}

	err := s.withOrg(ctx, in.OrgID, func(tx pgx.Tx) error {
		// Re-check membership inside the writing tx. The pre-read authorization
		// happened before the (slow) upload; a user removed from the channel
		// mid-transfer must not land a durable row.
		if err := requireScopeMember(ctx, tx, in.OrgID, in.Scope, in.ScopeID, in.UploaderID); err != nil {
			return err
		}

		// A thumbnail may only hang off a file the same uploader owns in the
		// same scope — otherwise a client could graft a poster onto someone
		// else's attachment.
		var parentArg *string
		if in.ParentID != "" {
			var pScope, pScopeID, pUploader string
			perr := tx.QueryRow(ctx,
				`SELECT scope, scope_id::text, uploader_id::text FROM attachments
				 WHERE id = $1 AND org_id = $2`,
				in.ParentID, in.OrgID).Scan(&pScope, &pScopeID, &pUploader)
			if errors.Is(perr, pgx.ErrNoRows) {
				return ErrForbidden
			}
			if perr != nil {
				return perr
			}
			if pScope != in.Scope || pScopeID != in.ScopeID || pUploader != in.UploaderID {
				return ErrForbidden
			}
			parentArg = &in.ParentID
		}

		// Encrypt the filename under the org DEK, created lazily in THIS tx.
		// The plaintext column stays NULL — filename_enc is the source of truth.
		nameEnc, err := s.crypto.Encrypt(ctx, tx, in.OrgID, in.Filename)
		if err != nil {
			return err
		}

		var createdAt time.Time
		if err := tx.QueryRow(ctx, `
			INSERT INTO attachments
			  (id, org_id, uploader_id, scope, scope_id, role, parent_attachment_id,
			   sha256, mime, size_bytes, filename, filename_enc,
			   width, height, duration_ms, storage_path, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,$14,$15, now() + $16::interval)
			RETURNING created_at`,
			id, in.OrgID, in.UploaderID, in.Scope, in.ScopeID, in.Role, parentArg,
			in.SHA256, in.MIME, in.SizeBytes, nameEnc,
			in.Width, in.Height, in.DurationMS, in.StoragePath,
			fmt.Sprintf("%d seconds", int(in.TTL.Seconds())),
		).Scan(&createdAt); err != nil {
			return err
		}
		out.CreatedAt = isoTime(createdAt)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// CommitAttachment clears expires_at, making the blob permanent. Called by the
// client once the message referencing the attachment has been accepted.
// Idempotent: committing twice is a no-op.
func (s *Store) CommitAttachment(ctx context.Context, orgID, userID, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return ErrForbidden
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Only the uploader may commit, and only within their own org.
		var uploader string
		err := tx.QueryRow(ctx,
			`SELECT uploader_id::text FROM attachments WHERE id = $1 AND org_id = $2`,
			id, orgID).Scan(&uploader)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if uploader != userID {
			return ErrForbidden
		}
		// Commit the file and any thumbnails hanging off it in one statement.
		_, err = tx.Exec(ctx,
			`UPDATE attachments SET expires_at = NULL
			 WHERE org_id = $1 AND (id = $2 OR parent_attachment_id = $2)`,
			orgID, id)
		return err
	})
}

// maxLinkBatch bounds one mint request. Each id costs a membership check, and
// a rendered page never needs more than a few dozen.
const maxLinkBatch = 50

// AuthorizeAttachmentReads filters ids down to those userID may actually read,
// returning them in request order. Ids that do not exist, belong to another org,
// or sit in a scope the caller is not a member of are silently dropped rather
// than erroring: a thread can legitimately contain an attachment the current
// viewer cannot see (a forwarded message), and one such id must not fail the
// whole page's mint.
func (s *Store) AuthorizeAttachmentReads(ctx context.Context, orgID, userID string, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > maxLinkBatch {
		return nil, fmt.Errorf("at most %d ids per request", maxLinkBatch)
	}
	for _, id := range ids {
		if _, err := uuid.Parse(id); err != nil {
			return nil, fmt.Errorf("invalid attachment id")
		}
	}

	var allowed []string
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// Load scopes first, draining the cursor before issuing the per-scope
		// membership queries — a second query on a tx with open Rows errors
		// with "conn busy".
		type row struct{ id, scope, scopeID string }
		rows, qerr := tx.Query(ctx,
			`SELECT id::text, scope, scope_id::text FROM attachments
			 WHERE org_id = $1 AND id = ANY($2::uuid[])`, orgID, ids)
		if qerr != nil {
			return qerr
		}
		var found []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.scope, &r.scopeID); err != nil {
				rows.Close()
				return err
			}
			found = append(found, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		// Memoize per scope: a message with ten images resolves one check.
		type scopeKey struct{ scope, id string }
		verdict := make(map[scopeKey]bool, len(found))
		ok := make(map[string]bool, len(found))
		for _, r := range found {
			k := scopeKey{r.scope, r.scopeID}
			v, seen := verdict[k]
			if !seen {
				err := requireScopeMember(ctx, tx, orgID, r.scope, r.scopeID, userID)
				if err != nil && !errors.Is(err, ErrForbidden) {
					return err
				}
				v = err == nil
				verdict[k] = v
			}
			if v {
				ok[r.id] = true
			}
		}
		for _, id := range ids {
			if ok[id] {
				allowed = append(allowed, id)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return allowed, nil
}

// GetAttachmentForDownload loads an attachment and RE-VERIFIES that userID may
// read it right now.
//
// This is the whole point of the (scope, scope_id) model: a signed URL minted
// while the user was a channel member must stop working the moment they leave,
// without waiting for the token to expire. The membership check runs on every
// single download, not just at mint time.
func (s *Store) GetAttachmentForDownload(ctx context.Context, orgID, userID, id string) (*AttachmentDTO, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, ErrNotFound
	}
	out := &AttachmentDTO{OrgID: orgID}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var namePlain *string
		var nameEnc []byte
		var createdAt time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, scope, scope_id::text, role, sha256, mime, size_bytes,
			       filename, filename_enc, width, height, duration_ms, created_at
			FROM attachments WHERE id = $1 AND org_id = $2`,
			id, orgID).Scan(
			&out.ID, &out.Scope, &out.ScopeID, &out.Role, &out.SHA256, &out.MIME,
			&out.SizeBytes, &namePlain, &nameEnc, &out.Width, &out.Height,
			&out.DurationMS, &createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}

		if err := requireScopeMember(ctx, tx, orgID, out.Scope, out.ScopeID, userID); err != nil {
			return err
		}

		// filename_enc is the source of truth; the plaintext column is a
		// fallback for hypothetical un-backfilled rows (mirrors threads.go).
		if nameEnc != nil {
			dec, derr := s.crypto.Decrypt(ctx, tx, orgID, nameEnc)
			if derr != nil {
				return derr
			}
			out.Filename = dec
		} else if namePlain != nil {
			out.Filename = *namePlain
		}
		out.CreatedAt = isoTime(createdAt)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// attachmentForActivity loads attachmentID's real, decrypted filename and
// verifies userID may currently read it — the same membership rule
// GetAttachmentForDownload enforces for an actual download — so that
// MessageKindAttachmentOpened/Downloaded can never name a file the caller
// cannot see, or a string that was never a real filename at all.
//
// wantScope/wantScopeID name the conversation or channel the notice is being
// POSTED into, and the attachment must live in exactly that one. Membership of
// the attachment's own scope is not enough on its own: a user in both DM A and
// channel B could otherwise post "X opened <file from B>" into A, disclosing
// B's filename to everyone in A who is not in B. A mismatch answers ErrNotFound,
// the same as an id that does not exist, so it is no oracle for other scopes'
// attachments either.
//
// Runs on the CALLER's already-open tx (the appendMessageTx/SendChannelMessage
// write transaction), matching how cachedUserNames resolves the sender's
// display name inline rather than opening a second transaction.
func (s *Store) attachmentForActivity(ctx context.Context, tx pgx.Tx, orgID, attachmentID, userID, wantScope, wantScopeID string) (string, error) {
	if _, err := uuid.Parse(attachmentID); err != nil {
		return "", ErrNotFound
	}
	var scope, scopeID string
	var namePlain *string
	var nameEnc []byte
	err := tx.QueryRow(ctx, `
		SELECT scope, scope_id::text, filename, filename_enc
		FROM attachments WHERE id = $1 AND org_id = $2`,
		attachmentID, orgID).Scan(&scope, &scopeID, &namePlain, &nameEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if scope != wantScope || scopeID != wantScopeID {
		return "", ErrNotFound
	}
	if err := requireScopeMember(ctx, tx, orgID, scope, scopeID, userID); err != nil {
		return "", err
	}
	if nameEnc != nil {
		return s.crypto.Decrypt(ctx, tx, orgID, nameEnc)
	}
	if namePlain != nil {
		return *namePlain, nil
	}
	return "", ErrNotFound
}

// ExpiredBlob names a blob the reaper may unlink.
type ExpiredBlob struct {
	OrgID  string
	SHA256 string
}

// ReapExpiredAttachments deletes rows whose commit never arrived and reports
// which blobs are now unreferenced within their org.
//
// Ordering matters: the row is deleted first and the file only afterwards, and
// only when no sibling row in the same org still points at that content. The
// reverse order would let a concurrent dedupe hit hand out a path to a file we
// are about to unlink.
func (s *Store) ReapExpiredAttachments(ctx context.Context, limit int) ([]ExpiredBlob, error) {
	if limit <= 0 {
		limit = 500
	}
	var out []ExpiredBlob
	// Cross-org sweep: this is trusted background code that resolves the org
	// FROM the row, never from request input.
	err := s.withBypass(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH doomed AS (
				SELECT id FROM attachments
				WHERE expires_at IS NOT NULL AND expires_at < now()
				ORDER BY expires_at
				LIMIT $1
			), gone AS (
				DELETE FROM attachments a USING doomed d WHERE a.id = d.id
				RETURNING a.org_id, a.sha256
			)
			SELECT g.org_id::text, g.sha256 FROM gone g
			WHERE NOT EXISTS (
				-- Every sub-statement of a data-modifying WITH query runs against
				-- the SAME pre-DELETE snapshot, so a plain scan of attachments
				-- here would always find each doomed row's own about-to-be-deleted
				-- self as a "sibling" and this would always come back empty. The
				-- doomed CTE above is a plain read-only SELECT, computed once and
				-- unaffected by the DELETE, so excluding its ids is what actually
				-- asks "is there a surviving row with this content" instead of
				-- "did the DELETE run" (see outbox.go's recordPublishFailure for
				-- the same CTE-snapshot mistake caught once already, in a
				-- different shape).
				SELECT 1 FROM attachments k
				WHERE k.org_id = g.org_id AND k.sha256 = g.sha256
				  AND k.id NOT IN (SELECT id FROM doomed)
			)`, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var b ExpiredBlob
			if err := rows.Scan(&b.OrgID, &b.SHA256); err != nil {
				return err
			}
			out = append(out, b)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CountExpiredAttachments reports how many rows ReapExpiredAttachments would
// delete right now, and their total size. It performs no writes: this backs
// gc-attachments' dry-run mode, which must report what a real run would
// reclaim without deleting anything.
//
// The byte total is an upper bound on space actually freed, not a promise of
// it: two rows can share one content-addressed blob (see
// ReapExpiredAttachments), so a doomed row's content can survive via a
// sibling that is not itself expired.
func (s *Store) CountExpiredAttachments(ctx context.Context) (rows int, totalBytes int64, err error) {
	err = s.withBypass(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT count(*), COALESCE(sum(size_bytes), 0)
			FROM attachments
			WHERE expires_at IS NOT NULL AND expires_at < now()`,
		).Scan(&rows, &totalBytes)
	})
	return rows, totalBytes, err
}
