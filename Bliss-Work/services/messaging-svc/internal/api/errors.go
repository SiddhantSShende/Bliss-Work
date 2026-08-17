// errors.go: canonical JSON error envelope used by every messaging-svc response.
//
// Shape (matches packages/shared/src/types/errors.ts ApiErrorBody):
//
//	{ "error": { "code": "...", "message": "...", "requestId": "...", "details": {...} } }
//
// The same shape is emitted by all Task-Board services so the frontend can
// surface `requestId` to the user and the support team can pin a trace.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/task-board/messaging-svc/internal/livekit"
	mw "github.com/task-board/messaging-svc/internal/middleware"
	"github.com/task-board/messaging-svc/internal/store"
)

// ErrorCode is the snake_case machine-readable error label.
type ErrorCode string

const (
	CodeBadRequest         ErrorCode = "bad_request"
	CodeUnauthorized       ErrorCode = "unauthorized"
	CodeForbidden          ErrorCode = "forbidden"
	CodeNotFound           ErrorCode = "not_found"
	CodeConflict           ErrorCode = "conflict"
	CodeValidationError    ErrorCode = "validation_error"
	CodeRateLimited        ErrorCode = "rate_limited"
	CodePayloadTooLarge    ErrorCode = "payload_too_large"
	CodeInternalError      ErrorCode = "internal_error"
	CodeServiceUnavailable ErrorCode = "service_unavailable"
	CodeGatewayTimeout     ErrorCode = "gateway_timeout"
)

type apiErrorBody struct {
	Error apiErrorPayload `json:"error"`
}

type apiErrorPayload struct {
	Code      ErrorCode      `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"requestId"`
	Details   map[string]any `json:"details,omitempty"`
}

// writeAPIError emits the canonical error envelope.
func writeAPIError(w http.ResponseWriter, r *http.Request, status int, code ErrorCode, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiErrorBody{
		Error: apiErrorPayload{
			Code:      code,
			Message:   message,
			RequestID: mw.RequestIDFromContext(r.Context()),
		},
	})
}

// httpStatusToCode is the default mapping when a handler hasn't picked a code.
func httpStatusToCode(status int) ErrorCode {
	switch {
	case status == http.StatusBadRequest:
		return CodeBadRequest
	case status == http.StatusUnauthorized:
		return CodeUnauthorized
	case status == http.StatusForbidden:
		return CodeForbidden
	case status == http.StatusNotFound:
		return CodeNotFound
	case status == http.StatusConflict:
		return CodeConflict
	case status == http.StatusUnprocessableEntity:
		return CodeValidationError
	case status == http.StatusTooManyRequests:
		return CodeRateLimited
	case status == http.StatusRequestEntityTooLarge:
		return CodePayloadTooLarge
	case status == http.StatusGatewayTimeout:
		return CodeGatewayTimeout
	case status == http.StatusServiceUnavailable:
		return CodeServiceUnavailable
	case status >= 500:
		return CodeInternalError
	default:
		return CodeBadRequest
	}
}

// mapStoreError translates known store errors to canonical (status, code, message).
func mapStoreError(err error) (int, ErrorCode, string) {
	switch {
	case errors.Is(err, store.ErrLastOwner):
		// 409, not 500: the request was well-formed and the caller was allowed
		// to make it — it just would have left the channel with no owner. The
		// client shows "transfer ownership first", which a 500 could not.
		return http.StatusConflict, CodeConflict,
			"a channel must keep an owner — transfer ownership first"
	case errors.Is(err, store.ErrForbidden):
		return http.StatusForbidden, CodeForbidden, "forbidden"
	case errors.Is(err, store.ErrInviteInvalid):
		// 404, not 403. A 403 would confirm the token names a real meeting,
		// turning this endpoint into an oracle for guessing links; and the
		// store deliberately collapses unknown/expired/revoked/spent into one
		// error so the status cannot distinguish them either.
		return http.StatusNotFound, CodeNotFound, "this invite link is no longer valid"
	case errors.Is(err, store.ErrCallEnded):
		return http.StatusConflict, CodeConflict, "this call has already ended"
	case errors.Is(err, store.ErrCallNotStarted):
		// 409, and pointedly not 403: the caller is entitled to be here, the
		// call simply has not been opened yet. A 403 would read as "you are not
		// allowed in this call", which is the opposite of what is true of
		// someone sitting in its waiting room.
		return http.StatusConflict, CodeConflict, "this call has not started yet"
	case errors.Is(err, store.ErrNotSharing):
		return http.StatusConflict, CodeConflict, "no screen share is in progress"
	case errors.Is(err, store.ErrShareSourceInvalid):
		return http.StatusBadRequest, CodeValidationError,
			"source must be screen, window or tab"
	case errors.Is(err, store.ErrNoInviteForKind):
		// A channel call has no link by design — the channel IS the guest list.
		return http.StatusBadRequest, CodeBadRequest,
			"only meetings can be joined by link; a channel call is open to its channel members"
	case errors.Is(err, livekit.ErrNotConfigured):
		return http.StatusServiceUnavailable, CodeInternalError,
			"calling is not configured on this deployment"
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound, CodeNotFound, "not found"
	case errors.Is(err, store.ErrQuotaExceeded):
		return http.StatusRequestEntityTooLarge, CodePayloadTooLarge, "upload quota exceeded"
	case errors.Is(err, pgx.ErrNoRows):
		return http.StatusNotFound, CodeNotFound, "not found"
	case errors.Is(err, context.Canceled):
		// 499 client-closed-request (nginx convention)
		return 499, CodeBadRequest, "client closed request"
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, CodeGatewayTimeout, "request timed out"
	default:
		return http.StatusInternalServerError, CodeInternalError, "internal error"
	}
}
