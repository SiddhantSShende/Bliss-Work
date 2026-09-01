// Package sweep decides who needs nudging, and when.
//
// This is the whole policy of the delivery watchdog, kept pure — no Kafka, no
// HTTP, no clock of its own — so the decisions can be table-tested. The
// plumbing that fetches pins and emits events lives in ../pins and ../emit.
//
// ── What this is for ─────────────────────────────────────────────────────────
// A desktop note appears because a `task.assigned` frame arrives over the
// websocket. If that frame is lost — a reconnect at the wrong moment, or the
// user offline past ws-gateway's 24h replay window — the note simply never
// appears, and nothing notices. sticky-svc records whether a pin was ever
// confirmed delivered; this turns "open, and nobody has ever confirmed seeing
// it" into a nudge telling that user's clients to re-fetch.
//
// ── What it must not do ──────────────────────────────────────────────────────
// Become a source of noise. Three rules below exist only for that: one refresh
// per PERSON per sweep however many pins they have, exponential backoff so a
// client that cannot be reached is not retried every minute forever, and a hard
// cap after which a pin is left to the client's own periodic poll.
package sweep

import "time"

// Backoff ladder, indexed by how many times a pin has already been claimed by a
// sweep. Past the end of the ladder the last value repeats until MaxNudges.
//
// Deliberately starts at a minute, not seconds: this is a repair mechanism for
// a frame that was already lost, and the client's own reconnect is faster than
// anything here. Ending at an hour keeps a genuinely unreachable client from
// generating steady traffic for as long as it stays unreachable.
var BackoffLadder = []time.Duration{
	1 * time.Minute,
	5 * time.Minute,
	15 * time.Minute,
	1 * time.Hour,
}

// MaxNudges is where the watchdog gives up on a pin. Past this the client's own
// periodic re-fetch is the remaining safety net — which is the right place for
// it, because a pin that has been nudged this many times without a delivery ack
// usually means nobody is running a client at all, not that a frame was lost.
const MaxNudges = 12

// Pin is one open, never-confirmed commitment, as sticky-svc reports it.
type Pin struct {
	TaskID           string
	OrgID            string
	AssigneeID       string
	OpenedAt         time.Time
	DeliveryAttempts int
}

// Refresh is one nudge: "you have notes you may not have seen; re-fetch".
//
// Carries a count and no task content on purpose. The client already knows how
// to ask for its own pins, and putting task titles on a broadcast-ish repair
// event would spread PII across a path that exists only to say "look again".
type Refresh struct {
	OrgID      string
	AssigneeID string
	PinCount   int
}

// Plan turns a page of undelivered pins into the nudges to send right now.
//
// `now` is passed in rather than read from the clock so the backoff is testable.
// Input order is preserved so the output is deterministic, which matters for a
// job that logs what it did.
func Plan(pins []Pin, now time.Time) []Refresh {
	// Group by PERSON, not by pin. Someone who was handed six tasks while
	// offline needs one "go and look", not six.
	type bucket struct {
		orgID string
		count int
		due   bool
	}
	order := make([]string, 0, len(pins))
	byAssignee := make(map[string]*bucket, len(pins))

	for _, p := range pins {
		if p.AssigneeID == "" || p.OrgID == "" {
			continue
		}
		// Scoped by org as well as user: the same person id in two orgs is two
		// different recipients as far as delivery is concerned.
		key := p.OrgID + "\x00" + p.AssigneeID
		b, seen := byAssignee[key]
		if !seen {
			b = &bucket{orgID: p.OrgID}
			byAssignee[key] = b
			order = append(order, key)
		}
		b.count++
		if isDue(p, now) {
			b.due = true
		}
	}

	out := make([]Refresh, 0, len(order))
	for _, key := range order {
		b := byAssignee[key]
		// Nudge a person if ANY of their pins is due. The count reports every
		// undelivered pin they have, including ones still inside their own
		// backoff — the client re-fetches the lot regardless, so reporting a
		// smaller number would only understate what is waiting.
		if !b.due {
			continue
		}
		out = append(out, Refresh{
			OrgID:      b.orgID,
			AssigneeID: key[len(b.orgID)+1:],
			PinCount:   b.count,
		})
	}
	return out
}

// isDue reports whether enough time has passed since a pin was opened for its
// next nudge, given how many it has already had.
func isDue(p Pin, now time.Time) bool {
	if p.DeliveryAttempts >= MaxNudges {
		return false
	}
	return !now.Before(p.OpenedAt.Add(backoffFor(p.DeliveryAttempts)))
}

// backoffFor returns the wait before the nth nudge, clamping past the ladder's
// end to its last entry.
func backoffFor(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	if attempts >= len(BackoffLadder) {
		return BackoffLadder[len(BackoffLadder)-1]
	}
	return BackoffLadder[attempts]
}
