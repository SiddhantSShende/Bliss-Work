// Package loop decides which events may cross a region boundary.
//
// This is the whole of cycle prevention, and it is a pure function on purpose:
// in an active-active mesh the difference between "replication" and "an
// infinite loop that saturates every WAN link you own" is one wrong branch, and
// that branch should be readable and testable without a NATS server, a Kafka
// broker or a second region.
//
// ── The invariant ────────────────────────────────────────────────────────────
//
//	An event is exported by EXACTLY ONE region: the one it was produced in.
//
// Everything below follows from it. A region stamps its own origin on the way
// out; every other region imports, writes the event to its LOCAL Kafka with the
// origin intact, and its exporter sees a foreign origin and declines. There is
// no path back to the origin, so there is no cycle — with N regions each event
// crosses the WAN exactly N-1 times, not N! times.
//
// ── Belt and braces ──────────────────────────────────────────────────────────
//
// The stream topology already makes a cycle impossible (a region's outbound
// stream only ever captures its own `evt.<region>.>` subjects, and nothing
// publishes another region's subject). This layer exists anyway because that
// guarantee lives in configuration, and configuration is exactly what gets
// mistyped at 3am — sourcing a peer's INBOUND stream instead of its outbound
// one would build a cycle out of two correct-looking config files.
//
// So provenance is also carried per message, and the hop counter is the last
// resort: a message that has crossed a boundary more than maxHops times is
// dropped and shouted about, whatever the configuration believes.
package loop

import (
	"fmt"
	"strconv"
	"strings"
)

// Header names carried on both transports. NATS canonicalizes header keys the
// way Go's textproto does, so these are written in canonical form and compared
// case-insensitively when read back off Kafka, whose header keys are raw bytes.
const (
	HeaderOriginRegion = "X-Origin-Region"
	HeaderHops         = "X-Bridge-Hops"
	HeaderEventID      = "X-Event-Id"
	HeaderKafkaKey     = "X-Kafka-Key"
	HeaderKafkaTopic   = "X-Kafka-Topic"
)

// MaxHops is how many region boundaries one event may cross before it is
// treated as evidence of a loop rather than of a large topology.
//
// One is the correct number for the mesh this bridge builds: every region
// sources every peer directly, so an event reaches its furthest reader in a
// single hop. It is a constant rather than a setting because raising it does
// not enable a bigger deployment — it enables a cycle to run longer before
// anything notices.
const MaxHops = 1

// Decision is what to do with one event at a region boundary.
type Decision int

const (
	// Forward: hand it across the boundary.
	Forward Decision = iota
	// Skip: not this region's to forward. The ordinary, high-volume outcome on
	// the export side — every event a peer sent us lands here — and the branch
	// that breaks the cycle. Not an error; not counted as one.
	Skip
	// Reject: the event should not exist in the shape it arrived in. Loud, and
	// dead-lettered rather than dropped silently, because every route to this
	// outcome is a bug or a misconfiguration somewhere else.
	Reject
)

func (d Decision) String() string {
	switch d {
	case Forward:
		return "forward"
	case Skip:
		return "skip"
	default:
		return "reject"
	}
}

// Provenance is what the two guards read: where an event came from and how far
// it has travelled. Absent fields are the zero value, which is meaningful —
// see ExportDecision.
type Provenance struct {
	Origin string
	Hops   int
}

// ExportDecision answers "may this region put this event on the wire?".
//
//	no origin        → ours. Produced by a local service, never bridged before.
//	foreign origin   → a peer's. Already bridged to us; exporting it is the cycle.
//	our own origin   → it came home. Impossible under a correct topology, so it
//	                   is treated as the loop it is rather than forwarded.
func ExportDecision(p Provenance, localRegion string) (Decision, string) {
	switch {
	case p.Origin == "":
		return Forward, "locally produced"
	case p.Origin == localRegion:
		// The only way to be holding our own event with an origin stamp is for
		// it to have been imported back — which means some peer is sourcing a
		// stream it should not be. Forwarding it would close the loop.
		return Reject, "event returned to its origin region: check peer stream sources"
	case p.Hops >= MaxHops:
		return Skip, "already bridged"
	default:
		return Skip, "foreign origin"
	}
}

// ImportDecision answers "may this region accept this event off the wire?".
//
// Stricter than the export side, deliberately. An export mistake costs one
// wasted publish; an import mistake writes a foreign event into local Kafka,
// where every downstream consumer acts on it — so anything whose provenance is
// not fully accounted for is rejected rather than given the benefit of the
// doubt.
func ImportDecision(p Provenance, localRegion string) (Decision, string) {
	switch {
	case p.Origin == "":
		// A bridged event without provenance cannot be prevented from looping,
		// because the exporter would read it as locally produced and send it
		// straight back out.
		return Reject, "missing origin region"
	case p.Origin == localRegion:
		return Reject, "event returned to its origin region: check peer stream sources"
	case p.Hops > MaxHops:
		return Reject, fmt.Sprintf("hop limit exceeded (%d > %d)", p.Hops, MaxHops)
	default:
		return Forward, "from " + p.Origin
	}
}

// ParseHops reads the hop counter. A malformed or negative value is read as a
// LOOP rather than as a zero: the counter only exists to catch the case where
// something is already wrong, so the failure mode has to be the safe one.
func ParseHops(raw string) int {
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 0 {
		return MaxHops + 1
	}
	return n
}

// ValidRegion reports whether a region name is usable as one token of a NATS
// subject.
//
// Subjects are dot-separated and `*`/`>` are wildcards, so a region containing
// any of them would silently widen or break every filter built from it — a
// region called "a.b" would make `evt.a.b.>` match a different shape than
// intended and could subscribe one region to another's traffic. Rejected at
// startup rather than sanitized: a region name is deployment configuration, and
// quietly rewriting it makes the subject in the logs disagree with the one on
// the wire.
func ValidRegion(name string) bool {
	if name == "" || len(name) > 32 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'
		if !ok {
			return false
		}
	}
	return name[0] != '-' && name[len(name)-1] != '-'
}
