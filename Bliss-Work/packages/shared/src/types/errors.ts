/**
 * Canonical error envelope returned by every Task-Board service.
 *
 * Every non-2xx response carries this shape so the frontend can render a
 * consistent error UI and surface `requestId` for support correlation.
 *
 *   { "error": { "code": "rate_limited", "message": "…", "requestId": "…", "details": {...} } }
 *
 * The `code` is a stable, machine-readable string (snake_case). The `message`
 * is a short human-readable summary safe to display. The `requestId` lets a
 * user paste a single string into a support ticket that maps to one trace.
 * `details` is optional and is shaped per `code` (e.g. validation field map).
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "call_session_active"
  | "call_ended"
  | "validation_error"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable"
  | "gateway_timeout";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/** Map an HTTP status code to a reasonable default ErrorCode. */
export function httpStatusToCode(status: number): ErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_error";
  if (status === 429) return "rate_limited";
  if (status === 504) return "gateway_timeout";
  if (status >= 500) return "internal_error";
  return "bad_request";
}
