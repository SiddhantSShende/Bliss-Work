package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/auth"
	"github.com/task-board/messaging-svc/internal/blob"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// multipartOverhead is the slack allowed above the file cap for the multipart
// framing (boundaries, part headers, the filename). Without it a file of
// exactly MaxBytes would be rejected by its own envelope.
const multipartOverhead = 64 << 10

// uploadAttachment stores one file and returns its metadata.
//
// The ORDER of the steps below is load-bearing and should not be rearranged:
// every cheap rejection happens before we agree to read a large body. In
// particular, authorizing AFTER the upload would let any authenticated user
// make us spool 100 MB to disk on a channel they cannot post to, repeatedly, for
// free — a denial-of-service against the volume rather than against the CPU.
func (s *Server) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())

	// ── 1. Destination, from the QUERY STRING ────────────────────────────────
	// Deliberately not a form field: form fields arrive interleaved with the
	// file part, so reading them first would mean either buffering the upload
	// or making authorization depend on the client's chosen part ordering.
	scope := r.URL.Query().Get("scope")
	scopeID := r.URL.Query().Get("scopeId")
	if !store.ValidAttachmentScope(scope) || !validUUID(scopeID) {
		writeErrR(w, r, http.StatusBadRequest, "scope and scopeId are required")
		return
	}

	role := r.URL.Query().Get("role")
	if role == "" {
		role = store.RoleFile
	}
	if role != store.RoleFile && role != store.RoleThumb {
		writeErrR(w, r, http.StatusBadRequest, "invalid role")
		return
	}
	parentID := r.URL.Query().Get("parentId")
	if parentID != "" && !validUUID(parentID) {
		writeErrR(w, r, http.StatusBadRequest, "invalid parentId")
		return
	}

	// ── 2. Authorize BEFORE reading a single byte ────────────────────────────
	if err := s.store.AuthorizeAttachmentScope(r.Context(), claims.OrgID, claims.UserID, scope, scopeID); err != nil {
		s.mapErrR(w, r, err)
		return
	}

	// ── 3. Per-org rolling quota ─────────────────────────────────────────────
	// The filesystem has no per-tenant quota, so this is the only thing between
	// one org and a full volume for everybody.
	if s.mediaCfg.OrgDailyBytes > 0 {
		used, err := s.store.OrgMediaBytesLast24h(r.Context(), claims.OrgID)
		if err != nil {
			s.mapErrR(w, r, err)
			return
		}
		if used >= s.mediaCfg.OrgDailyBytes {
			writeAPIError(w, r, http.StatusRequestEntityTooLarge, CodePayloadTooLarge,
				"daily upload limit reached for this workspace")
			return
		}
	}

	// ── 4. Hard cap the body ─────────────────────────────────────────────────
	// This route is deliberately OUTSIDE the router's 1 MiB group: nesting a
	// large MaxBytesReader inside a small one does not widen it.
	r.Body = http.MaxBytesReader(w, r.Body, s.mediaCfg.MaxBytes+multipartOverhead)

	// ── 5. Stream the multipart body ─────────────────────────────────────────
	// MultipartReader, never ParseMultipartForm: the latter buffers parts into
	// memory and then into os.TempDir(), which in production is a RAM-backed
	// tmpfs inside a memory-capped container — a 100 MB upload would OOM-kill
	// the service.
	mr, err := r.MultipartReader()
	if err != nil {
		writeErrR(w, r, http.StatusBadRequest, "expected a multipart body")
		return
	}

	var (
		filename string
		declared string
		part     io.ReadCloser
	)
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.mediaBodyError(w, r, err)
			return
		}
		if p.FormName() == "file" {
			filename = p.FileName()
			declared = p.Header.Get("Content-Type")
			part = p
			break
		}
		_ = p.Close()
	}
	if part == nil {
		writeErrR(w, r, http.StatusBadRequest, "missing 'file' part")
		return
	}
	defer part.Close()

	// ── 6. Sniff the type from the BYTES, not the client's claim ─────────────
	// See internal/media.Sniff: a declared Content-Type is an unauthenticated
	// assertion, and "declare image/png, upload HTML" is the stored-XSS attack.
	head := make([]byte, 512)
	n, err := io.ReadFull(part, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		s.mediaBodyError(w, r, err)
		return
	}
	head = head[:n]
	mime := media.Sniff(head, declared, filename)

	// ── 7. Stream to disk, hashing as we go ──────────────────────────────────
	sha, size, err := s.blobs.WriteStream(
		claims.OrgID,
		io.MultiReader(bytes.NewReader(head), part),
		s.mediaCfg.MaxBytes,
	)
	if err != nil {
		s.mediaBodyError(w, r, err)
		return
	}
	storagePath, err := s.blobs.RelPath(claims.OrgID, sha)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}

	// ── 8. Record it (expiring until committed) ──────────────────────────────
	att, err := s.store.CreateAttachment(r.Context(), store.NewAttachment{
		OrgID:       claims.OrgID,
		UploaderID:  claims.UserID,
		Scope:       scope,
		ScopeID:     scopeID,
		Role:        role,
		ParentID:    parentID,
		SHA256:      sha,
		MIME:        mime,
		SizeBytes:   size,
		Filename:    media.SanitizeFilename(filename),
		StoragePath: storagePath,
		Width:       queryInt(r, "width"),
		Height:      queryInt(r, "height"),
		DurationMS:  queryInt(r, "durationMs"),
		TTL:         s.mediaCfg.UploadTTL,
	})
	if err != nil {
		// The blob is already on disk. Leave it: it is content-addressed, so a
		// retry reuses it, and the reaper cannot see it because no row points at
		// it — an orphaned blob with no row is swept by the same GC pass that
		// handles uncommitted rows.
		s.mapErrR(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, att)
}

// mediaBodyError maps upload failures. Size overruns must surface as 413, not
// 400 or 500 — the client shows a "too large" message and a 5xx would look like
// our fault and trigger a retry of a request that can never succeed.
func (s *Server) mediaBodyError(w http.ResponseWriter, r *http.Request, err error) {
	var maxErr *http.MaxBytesError
	if errors.Is(err, blob.ErrTooLarge) || errors.As(err, &maxErr) {
		writeAPIError(w, r, http.StatusRequestEntityTooLarge, CodePayloadTooLarge,
			"file exceeds the maximum upload size")
		return
	}
	if errors.Is(err, blob.ErrBadKey) {
		writeErrR(w, r, http.StatusBadRequest, "invalid upload")
		return
	}
	s.mapErrR(w, r, err)
}

// queryInt reads an optional non-negative integer hint. These are display-only
// layout hints (see the migration); a malformed value is ignored rather than
// rejected, because failing an upload over a cosmetic field would be silly.
func queryInt(r *http.Request, key string) *int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 || v > 1<<30 {
		return nil
	}
	return &v
}

// commitAttachment makes an uploaded blob permanent. The client calls it once
// the message referencing the attachment has been accepted; until then the row
// expires on its own, because the reference lives inside an encrypted body that
// the server can never read to discover orphans.
func (s *Server) commitAttachment(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	id := chi.URLParam(r, "id")
	if !validUUID(id) {
		writeErrR(w, r, http.StatusBadRequest, "invalid attachment id")
		return
	}
	if err := s.store.CommitAttachment(r.Context(), claims.OrgID, claims.UserID, id); err != nil {
		s.mapErrR(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type linksReq struct {
	IDs []string `json:"ids"`
}

type linkDTO struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// attachmentLinks mints short-lived signed download URLs in a batch.
//
// A browser cannot put an Authorization header on <img src> / <video src>, so
// the URL itself has to carry the authorization. The token binds attachment,
// org, user and expiry; the download handler still re-checks membership, so a
// leaked link does not outlive the sharer's own access.
func (s *Server) attachmentLinks(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	var req linksReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrR(w, r, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.IDs) == 0 {
		writeJSON(w, http.StatusOK, []linkDTO{})
		return
	}

	allowed, err := s.store.AuthorizeAttachmentReads(r.Context(), claims.OrgID, claims.UserID, req.IDs)
	if err != nil {
		if errors.Is(err, store.ErrForbidden) {
			s.mapErrR(w, r, err)
			return
		}
		// Batch-shape complaints (too many ids, malformed uuid) are client errors.
		writeErrR(w, r, http.StatusBadRequest, err.Error())
		return
	}

	exp := time.Now().Add(s.mediaCfg.URLTTL)
	out := make([]linkDTO, 0, len(allowed))
	for _, id := range allowed {
		tok := s.signer.Sign(media.Grant{
			AttachmentID: id,
			OrgID:        claims.OrgID,
			UserID:       claims.UserID,
			Exp:          exp,
		})
		out = append(out, linkDTO{
			ID:        id,
			URL:       "/media/" + id + "?t=" + tok,
			ExpiresAt: exp.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// downloadMedia serves attachment bytes.
//
// This route sits OUTSIDE /api/v1 and therefore outside the JWT middleware,
// because the browser physically cannot authenticate a subresource GET. The
// signed token authenticates; GetAttachmentForDownload then AUTHORIZES by
// re-checking scope membership as the granted user on every single hit — so
// leaving a channel revokes access immediately rather than at token expiry.
func (s *Server) downloadMedia(w http.ResponseWriter, r *http.Request) {
	grant, err := s.signer.Verify(r.URL.Query().Get("t"))
	if err != nil {
		// Deliberately uniform: distinguishing expired from forged from
		// malformed is free information for someone probing the format.
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}
	id := chi.URLParam(r, "id")
	// The kind check is what keeps this route to attachments: a recording link
	// carries the same signature over a different resource, and neither should
	// open the other's door.
	if id != grant.AttachmentID || grant.Kind != media.KindAttachment {
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}

	att, err := s.store.GetAttachmentForDownload(r.Context(), grant.OrgID, grant.UserID, id)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}

	f, err := s.blobs.Open(att.OrgID, att.SHA256)
	if err != nil {
		s.log.Error("media blob missing", "attachment_id", id, "sha256", att.SHA256,
			"request_id", mw.RequestIDFromContext(r.Context()))
		writeAPIError(w, r, http.StatusNotFound, CodeNotFound, "file not found")
		return
	}
	defer f.Close()

	// ServeAs is the XSS boundary: only a closed allowlist of inert types is
	// ever served inline, everything else is downgraded to octet-stream AND
	// forced to attachment. See internal/media/mime.go.
	ct, inline := media.ServeAs(att.MIME)
	// NOTE: `?dl=1` is deliberately NOT honoured. It used to let the UI's
	// Download button force `Content-Disposition: attachment` even for types
	// that display inline; downloading chat attachments is no longer offered, so
	// the parameter is ignored rather than removed — old links in a cache or a
	// pasted URL then render inline instead of saving.
	//
	// This is deterrence, not DRM: `inline` is still false for everything
	// ServeAs refuses to display, because forcing a script-capable file to
	// download rather than execute is a security control and stays put. Media a
	// viewer can see, a viewer can still capture.
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Disposition", media.ContentDisposition(inline, att.Filename))
	h.Set("X-Content-Type-Options", "nosniff")
	// Content-addressed bytes never change, but the LINK is short-lived and
	// per-user, so the cache must be private.
	h.Set("Cache-Control", "private, max-age=600, immutable")
	h.Set("ETag", `"`+att.SHA256+`"`)
	// The service-wide API CSP is `default-src 'none'`, which is right for JSON
	// but would blank the page if a user pasted this URL into the address bar.
	// (As a subresource the CSP on an image/video response is ignored anyway.)
	// SecurityHeaders uses setdefault semantics, so this Set wins.
	h.Set("Content-Security-Policy",
		"default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	// NOT Cross-Origin-Resource-Policy: same-origin — the desktop renderer runs
	// on an app:// origin and would be blocked from loading its own attachments.

	// ServeContent gives us Range/206 (video scrubbing), If-None-Match and
	// If-Modified-Since for free.
	http.ServeContent(w, r, "", f.ModTime(), f)
}
