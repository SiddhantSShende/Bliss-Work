package api

import (
	"net/http"
	"strconv"
)

// Page sizes for the conversation and channel history endpoints. These mirror
// the store-side clamp (store.clampMessagePage) — the store enforces the real
// ceiling because it is reachable from more than one caller, and these exist so
// the HTTP layer rejects nonsense before it becomes a query.
const (
	DefaultMessagePageSize = 50
	MaxMessagePageSize     = 100
)

// pageParams reads the ?beforeSeq=&limit= keyset pair shared by the
// conversation, channel and thread history endpoints.
//
// beforeSeq is an exclusive upper bound on seq; absent or 0 means "start from
// the newest". limit falls back to def and is capped at max.
//
// The cap is the whole point: limit is client-supplied, and an uncapped one
// reintroduces exactly the unbounded read this pagination was added to remove.
// Out-of-range values fall back to the default rather than erroring, matching
// the behaviour the thread endpoint has always had.
func pageParams(r *http.Request, def, max int) (beforeSeq int64, limit int) {
	if v := r.URL.Query().Get("beforeSeq"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
			beforeSeq = n
		}
	}
	return beforeSeq, limitParam(r, def, max)
}

// Page sizes for the open-channel directory, mirroring store.clampChannelPage.
const (
	DefaultChannelPageSize = 50
	MaxChannelPageSize     = 200
)

// pageOffsetParams reads the ?limit=&offset= pair used by the listings that
// have no natural cursor.
//
// Offset paging rather than keyset, deliberately: the open-channel directory is
// ordered by recent activity, which MOVES as people post, so a keyset cursor
// over it would be a cursor into a shifting sequence. Offset paging over a
// changing list can repeat or skip a row between pages, which for a browse
// screen is a cosmetic flaw rather than a correctness one — message history,
// where skipping is not acceptable, uses beforeSeq above instead.
func pageOffsetParams(r *http.Request) (limit, offset int) {
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			offset = n
		}
	}
	return limitParam(r, DefaultChannelPageSize, MaxChannelPageSize), offset
}

// limitParam reads ?limit=, falling back to def and refusing anything above max.
//
// The cap is the whole point: limit is client-supplied, and an uncapped one
// reintroduces exactly the unbounded read pagination was added to remove.
// Out-of-range values fall back to the default rather than erroring, matching
// the behaviour the thread endpoint has always had.
func limitParam(r *http.Request, def, max int) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= max {
			return n
		}
	}
	return def
}
