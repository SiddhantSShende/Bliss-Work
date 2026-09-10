package contract

import "time"

// EpochMs converts an ISO-8601 UTC timestamp to epoch milliseconds. On parse
// failure it falls back to the current time so the event still has a sane
// replay score.
//
// Shared by both fan-out paths (internal/fanout and internal/router): both
// write into the same replay outbox (see store/outbox.go), so they must score
// an event identically or a dual-run would order replay differently depending
// on which path wrote the entry.
func EpochMs(occurredAt string) int64 {
	if occurredAt == "" {
		return time.Now().UTC().UnixMilli()
	}
	t, err := time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return time.Now().UTC().UnixMilli()
	}
	return t.UTC().UnixMilli()
}
