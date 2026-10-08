package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/task-board/messaging-svc/internal/convert"
	"github.com/task-board/messaging-svc/internal/media"
	mw "github.com/task-board/messaging-svc/internal/middleware"
)

// GET /media/{id}/preview?t=<the same signed link the download uses>
//
// The in-app preview of an Office document: a PDF (Word, PowerPoint) or the JSON
// of a spreadsheet's cell text (Excel). The conversion happens ONLY in the
// Office Document Sandbox; this handler never opens or parses the document. It
// compares the first bytes with a signature and streams the stored bytes to the
// sandbox.
//
// THE SERVER DECIDES, on every request and in this order, whether or not a
// converted file already exists:
//
//  1. the signed grant (attachment, org, user, expiry, and that it is an
//     attachment grant), then
//  2. the user's CURRENT access to the attachment's scope,
//  3. the extension, taken from the stored decrypted filename,
//  4. the magic bytes, read from the stored blob,
//  5. the stored size against the ceiling,
//  6. only then is a cached derivative consulted, or a conversion started.
//
// Nothing the client says matters: not its mime, its extension, its idea of what
// is previewable, or the fact that a preview was served to someone else before.
// A cached preview is served only to a caller who passes 1–5 right now.
//
// Replies: 200 the artifact; 202 still converting (ask again after Retry-After);
// 403/404 as for a download; 413 over the size ceiling; 415 not a supported
// document; 422 the document could not be converted; 429 too many conversions
// started; 503 the sandbox is off, busy or unreachable.
func (s *Server) previewMedia(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	// 1. The grant. The same checks, in the same uniform refusal, as downloadMedia.
	grant, err := s.signer.Verify(r.URL.Query().Get("t"))
	if err != nil {
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}
	id := chi.URLParam(r, "id")
	if id != grant.AttachmentID || grant.Kind != media.KindAttachment {
		writeAPIError(w, r, http.StatusForbidden, CodeForbidden, "invalid or expired link")
		return
	}

	// 2. Access, right now.
	att, err := s.store.GetAttachmentForDownload(r.Context(), grant.OrgID, grant.UserID, id)
	if err != nil {
		s.mapErrR(w, r, err)
		return
	}
	noStore(w)
	if s.preview == nil {
		previewUnavailable(w, r, "previews are not available")
		return
	}

	// 3. The extension, from the stored filename.
	spec, ok := media.PreviewFor(att.Filename)
	if !ok {
		writeAPIError(w, r, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "this file type cannot be previewed")
		return
	}

	// 4 and 5. The magic bytes and the size, from the stored blob itself.
	f, err := s.blobs.Open(att.OrgID, att.SHA256)
	if err != nil {
		writeAPIError(w, r, http.StatusNotFound, CodeNotFound, "file not found")
		return
	}
	head := make([]byte, media.MagicLen())
	n, _ := io.ReadFull(f, head)
	size := f.Size()
	_ = f.Close()
	if size == 0 || !spec.MagicOK(head[:n]) {
		writeAPIError(w, r, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "this file cannot be previewed")
		return
	}
	if size > s.previewCfg.MaxInputBytes {
		writeAPIError(w, r, http.StatusRequestEntityTooLarge, CodePayloadTooLarge, "this file is too large to preview")
		return
	}

	// 6. A derivative, or a conversion.
	ready := s.preview.Ready(att.OrgID, att.SHA256, spec)
	if !ready {
		if err := s.preview.Remembered(att.OrgID, att.SHA256, spec); err != nil {
			s.previewError(w, r, err)
			return
		}
		// Only a request that would START a conversion spends the user's budget:
		// a cache hit costs the sandbox nothing.
		if !s.limiter.AllowCtx(r.Context(), "preview:"+grant.UserID, s.previewCfg.UserPerMinute) {
			w.Header().Set("Retry-After", "30")
			writeAPIError(w, r, http.StatusTooManyRequests, CodeRateLimited, "too many previews requested; try again shortly")
			return
		}
		ready, err = s.preview.Ensure(r.Context(), att.OrgID, att.SHA256, spec)
		if err != nil {
			s.logPreview(r, spec, "error", started)
			s.previewError(w, r, err)
			return
		}
	}
	if !ready {
		s.logPreview(r, spec, "pending", started)
		w.Header().Set("Retry-After", "3")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"status":"pending"}`)
		return
	}
	s.servePreview(w, r, att.OrgID, att.SHA256, att.Filename, spec)
	s.logPreview(r, spec, "ok", started)
}

func (s *Server) servePreview(w http.ResponseWriter, r *http.Request, orgID, sha, filename string, spec media.PreviewSpec) {
	d, err := s.blobs.OpenDerived(orgID, sha, spec.Variant)
	if err != nil {
		writeAPIError(w, r, http.StatusNotFound, CodeNotFound, "preview not found")
		return
	}
	defer d.Close()
	// ServeHeaders is still the XSS boundary: the PDF is on the inline allowlist,
	// the sheets JSON is not and is served as an attachment, which a fetch reads
	// and a navigation will not render.
	ct, disposition := media.ServeHeaders(spec.ContentType(), media.SanitizeFilename(filename)+"."+spec.FileExt(), false)
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("Content-Disposition", disposition)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, max-age=600, immutable")
	h.Set("ETag", `"`+sha+"-"+spec.Variant+`"`)
	h.Set("Content-Security-Policy",
		"default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	http.ServeContent(w, r, "", d.ModTime(), d)
}

// previewError turns the closed set of conversion errors into a response. The
// message never says anything about the document.
func (s *Server) previewError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, convert.ErrUnsupported):
		writeAPIError(w, r, http.StatusUnsupportedMediaType, CodeUnsupportedMedia, "this file type cannot be previewed")
	case errors.Is(err, convert.ErrTooLarge):
		writeAPIError(w, r, http.StatusRequestEntityTooLarge, CodePayloadTooLarge, "this file is too large to preview")
	case errors.Is(err, convert.ErrUnconvertible), errors.Is(err, convert.ErrLimit),
		errors.Is(err, convert.ErrTimeout), errors.Is(err, convert.ErrBadArtifact):
		writeAPIError(w, r, http.StatusUnprocessableEntity, CodePreviewFailed, "this file could not be previewed")
	case errors.Is(err, convert.ErrBusy), errors.Is(err, convert.ErrUnavailable):
		previewUnavailable(w, r, "previews are temporarily unavailable")
	default:
		s.log.Error("preview failed", "error", err, "request_id", mw.RequestIDFromContext(r.Context()))
		writeAPIError(w, r, http.StatusInternalServerError, CodeInternalError, "internal error")
	}
}

func previewUnavailable(w http.ResponseWriter, r *http.Request, msg string) {
	w.Header().Set("Retry-After", "10")
	writeAPIError(w, r, http.StatusServiceUnavailable, CodeServiceUnavailable, msg)
}

// noStore keeps every non-200 outcome, and the 202, out of any cache.
func noStore(w http.ResponseWriter) { w.Header().Set("Cache-Control", "no-store") }

// logPreview records the outcome. Counts, kinds and timings only: never the
// filename (stored encrypted) or anything about the document.
func (s *Server) logPreview(r *http.Request, spec media.PreviewSpec, result string, started time.Time) {
	s.log.Info("preview", "kind", spec.Kind, "result", result,
		"ms", strconv.FormatInt(time.Since(started).Milliseconds(), 10),
		"request_id", mw.RequestIDFromContext(r.Context()))
}
