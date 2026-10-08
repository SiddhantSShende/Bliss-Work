// Package convert talks to the Office Document Sandbox (services/doc-converter).
//
// The sandbox is the ONLY place an Office file is opened. This package never
// parses a document: it streams the stored bytes to the sandbox, and verifies
// that what comes back is exactly the artifact it asked for before anything
// else in the service sees it. A reply that is not a PDF (for a PDF job) or valid
// JSON (for a sheets job) is refused, so even a compromised sandbox cannot hand
// the rest of BlissWork an arbitrary blob dressed as a preview.
package convert

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/task-board/messaging-svc/internal/media"
)

// The closed set of outcomes. They mirror the sandbox's own error codes, plus
// the two this side can add (the sandbox unreachable, and a reply that fails
// verification).
var (
	ErrUnsupported   = errors.New("convert: unsupported document")
	ErrTooLarge      = errors.New("convert: input too large")
	ErrUnconvertible = errors.New("convert: document could not be converted")
	ErrLimit         = errors.New("convert: a conversion limit was exceeded")
	ErrTimeout       = errors.New("convert: conversion timed out")
	ErrBusy          = errors.New("convert: sandbox busy")
	ErrUnavailable   = errors.New("convert: sandbox unavailable")
	ErrBadArtifact   = errors.New("convert: sandbox returned an invalid artifact")
)

var codeErrors = map[string]error{
	"unsupported":   ErrUnsupported,
	"too_large":     ErrTooLarge,
	"unconvertible": ErrUnconvertible,
	"limit":         ErrLimit,
	"timeout":       ErrTimeout,
	"busy":          ErrBusy,
}

// Deterministic reports whether the same input will fail the same way again, so
// the failure is worth remembering. Busy and unavailable are about the sandbox,
// not the document, and must never be cached.
func Deterministic(err error) bool {
	return errors.Is(err, ErrUnsupported) || errors.Is(err, ErrTooLarge) || errors.Is(err, ErrUnconvertible) ||
		errors.Is(err, ErrLimit) || errors.Is(err, ErrTimeout) || errors.Is(err, ErrBadArtifact)
}

// Client posts documents to the sandbox.
type Client struct {
	base string
	hc   *http.Client
}

// NewClient returns a client for the sandbox at baseURL. timeout bounds one whole
// conversion round trip and should sit above the sandbox's own per-job timeout.
func NewClient(baseURL string, timeout time.Duration) *Client {
	return &Client{
		base: baseURL,
		hc: &http.Client{
			Timeout: timeout,
			// The sandbox never redirects. Following one would let a misconfigured
			// or hostile reply steer this service's request elsewhere.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Convert streams size bytes of in to the sandbox as spec.Kind and passes the
// VERIFIED artifact to sink. maxSheets caps the sheets-JSON artifact, which is
// buffered to validate it; PDFs are streamed.
func (c *Client) Convert(ctx context.Context, spec media.PreviewSpec, in io.Reader, size, maxSheets int64, sink func(io.Reader) error) error {
	u := c.base + "/convert?kind=" + url.QueryEscape(spec.Kind)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, io.NopCloser(io.LimitReader(in, size)))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := c.hc.Do(req)
	if err != nil {
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			return ErrTimeout
		}
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return decodeFailure(resp)
	}
	if resp.Header.Get("X-Preview-Kind") != spec.Artifact {
		return ErrBadArtifact
	}
	switch spec.Artifact {
	case media.ArtifactPDF:
		br := bufio.NewReader(resp.Body)
		if head, err := br.Peek(5); err != nil || string(head) != "%PDF-" {
			return ErrBadArtifact
		}
		return sink(br)
	case media.ArtifactSheets:
		buf, err := io.ReadAll(io.LimitReader(resp.Body, maxSheets+1))
		if err != nil {
			return fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		if int64(len(buf)) > maxSheets {
			return ErrLimit
		}
		if !json.Valid(buf) {
			return ErrBadArtifact
		}
		return sink(bytes.NewReader(buf))
	}
	return ErrBadArtifact
}

// decodeFailure turns a non-200 reply into one of the closed errors. Only the
// `code` field is read: the sandbox sends nothing else, and nothing else is
// trusted if it did.
func decodeFailure(resp *http.Response) error {
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1024)).Decode(&body); err == nil {
		if e, ok := codeErrors[body.Code]; ok {
			return e
		}
	}
	return fmt.Errorf("%w: status %d", ErrUnavailable, resp.StatusCode)
}
