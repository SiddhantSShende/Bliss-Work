package api

import "testing"

// These tests pin the two constants the chat UI depends on. The 16→12 default
// is a user-visible contract: the frontend's THREAD_PAGE_SIZE must agree.
// Bumping the cap above 50 without bumping the matching cap in the frontend
// would let one bad client hammer the inbox query — keep both in sync.

func TestDefaultThreadPageSize(t *testing.T) {
	if DefaultThreadPageSize != 12 {
		t.Fatalf("DefaultThreadPageSize = %d, want 12 (frontend THREAD_PAGE_SIZE expects 12)", DefaultThreadPageSize)
	}
}

func TestMaxThreadPageSize(t *testing.T) {
	if MaxThreadPageSize != 50 {
		t.Fatalf("MaxThreadPageSize = %d, want 50", MaxThreadPageSize)
	}
	if MaxThreadPageSize < DefaultThreadPageSize {
		t.Fatalf("MaxThreadPageSize (%d) < DefaultThreadPageSize (%d)", MaxThreadPageSize, DefaultThreadPageSize)
	}
}

// httpStatusToCode is exercised here to keep the canonical error envelope's
// mapping pinned. If we ever rename an ErrorCode in errors.go, this catches it.
func TestHttpStatusToCode(t *testing.T) {
	cases := []struct {
		status int
		want   ErrorCode
	}{
		{400, CodeBadRequest},
		{401, CodeUnauthorized},
		{403, CodeForbidden},
		{404, CodeNotFound},
		{409, CodeConflict},
		{422, CodeValidationError},
		{429, CodeRateLimited},
		{500, CodeInternalError},
		{502, CodeInternalError},
		{503, CodeServiceUnavailable},
		{504, CodeGatewayTimeout},
	}
	for _, c := range cases {
		if got := httpStatusToCode(c.status); got != c.want {
			t.Errorf("httpStatusToCode(%d) = %s, want %s", c.status, got, c.want)
		}
	}
}
