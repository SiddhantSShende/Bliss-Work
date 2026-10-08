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

// The nudge backoff ladder no longer lives in this package as code — it was
// 1 minute, 5 minutes, 15 minutes, 1 hour, the last value repeating until
// MaxNudges, deliberately starting at a minute rather than seconds (this is a
// repair mechanism for a frame that was already lost, and the client's own
// reconnect is faster than anything here) and ending at an hour (so a
// genuinely unreachable client does not generate steady traffic for as long
// as it stays unreachable).
//
// The CANONICAL definition of these values is now sticky-svc's own claim
// query, which hand-maintains a copy of them in SQL (see internal.py's CASE
// expression): "is a nudge due" has to be decided server-side, inside the
// claim, where this package's isDue can no longer see it (see isDue's doc
// comment below for why this package stopped recomputing that decision
// itself). Update the CASE expression by hand if these values ever change —
// there is nothing left in this package to keep in sync.

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
// Input order is preserved so the output is deterministic, which matters for a
// job that logs what it did.
func Plan(pins []Pin) []Refresh {
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
		if isDue(p) {
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

// isDue reports whether a pin sticky-svc handed back should still be nudged.
//
// sticky-svc's own claim query (services/sticky-svc/app/routes/internal.py,
// GET /internal/pins/undelivered) already gates on next_eligible_at <= now()
// BEFORE returning a row — by the time a pin reaches this function, the
// server has already judged its backoff window elapsed and "spent" this
// attempt claiming it. This used to recompute that same decision
// independently, from OpenedAt + a flat per-attempt offset (BackoffLadder,
// via the now-removed backoffFor) — a DIFFERENT formula from the server's
// own now()-compounding-forward one, which diverges starting at the second
// nudge. A pin the server correctly claimed could fail this second, wrong
// check and get silently dropped from Plan()'s output: the claim (and the
// attempt it spent) wasted, no nudge ever sent, real nudges arriving far
// later and less often than the ladder intends.
//
// The server's gate is authoritative now. This keeps MaxNudges as a
// defensive, redundant check — the server enforces the same cutoff
// (_MAX_NUDGES in internal.py) — rather than trusting a page of pins blindly.
//
// DeliveryAttempts is the POST-claim count (the server's RETURNING value), and
// the server claims while the PRE-claim count is below MaxNudges, so the last
// claim it ever makes comes back as exactly MaxNudges. That one is a real,
// allowed nudge: comparing with `<` here dropped it — claimed, counted, and
// never sent — so the pin got MaxNudges-1 nudges, not MaxNudges.
func isDue(p Pin) bool {
	return p.DeliveryAttempts <= MaxNudges
}
