package httpapi

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNotificationCursorRoundTripPreservesOrderingTuple(t *testing.T) {
	createdAt := time.Date(2026, time.September, 30, 10, 15, 30, 123456789, time.UTC)
	id := uuid.MustParse("018f0000-0000-7000-8000-0000000000a1")

	cursor := encodeNotificationCursor(createdAt, id)
	gotTime, gotID, err := decodeNotificationCursor(cursor)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if !gotTime.Equal(createdAt) {
		t.Errorf("createdAt = %s, want %s", gotTime, createdAt)
	}
	if gotID != id {
		t.Errorf("id = %s, want %s", gotID, id)
	}
}

func TestDecodeNotificationCursorRejectsMalformedValues(t *testing.T) {
	for _, cursor := range []string{"not-base64", "", "e30"} {
		if _, _, err := decodeNotificationCursor(cursor); err == nil {
			t.Errorf("decode %q succeeded, want error", cursor)
		}
	}
}
