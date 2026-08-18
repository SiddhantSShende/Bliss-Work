package loop

import "testing"

// The tests that matter most in this repository: an active-active mesh with a
// broken guard does not fail visibly, it multiplies traffic until the WAN link
// dies, and by then every region is full of duplicates.

func TestALocallyProducedEventIsForwarded(t *testing.T) {
	d, why := ExportDecision(Provenance{}, "us-east-1")
	if d != Forward {
		t.Fatalf("export of a local event = %v (%s), want forward", d, why)
	}
}

func TestAPeersEventIsNeverExportedAgain(t *testing.T) {
	// THE cycle break. Every event a peer sends us is written to our local
	// Kafka, where our own exporter reads it back — and must decline.
	d, _ := ExportDecision(Provenance{Origin: "eu-west-1", Hops: 1}, "us-east-1")
	if d != Skip {
		t.Fatalf("export of a peer's event = %v, want skip — this is the cycle", d)
	}
}

func TestAnEventThatCameHomeIsRejectedByBothSides(t *testing.T) {
	// Impossible under a correct topology: it means a peer is sourcing our
	// INBOUND stream instead of our outbound one. Both guards have to catch it,
	// because either one forwarding closes the loop.
	if d, _ := ExportDecision(Provenance{Origin: "us-east-1", Hops: 1}, "us-east-1"); d != Reject {
		t.Errorf("export of a returned event = %v, want reject", d)
	}
	if d, _ := ImportDecision(Provenance{Origin: "us-east-1", Hops: 1}, "us-east-1"); d != Reject {
		t.Errorf("import of a returned event = %v, want reject", d)
	}
}

func TestImportRefusesAnEventWithNoProvenance(t *testing.T) {
	// Accepting it would write an event into local Kafka that our exporter then
	// reads as locally produced — and sends straight back. Silent cycle.
	d, _ := ImportDecision(Provenance{}, "us-east-1")
	if d != Reject {
		t.Fatalf("import without an origin = %v, want reject", d)
	}
}

func TestImportEnforcesTheHopLimit(t *testing.T) {
	if d, _ := ImportDecision(Provenance{Origin: "eu-west-1", Hops: MaxHops}, "us-east-1"); d != Forward {
		t.Errorf("a single hop must be accepted; that is the normal case")
	}
	if d, _ := ImportDecision(Provenance{Origin: "eu-west-1", Hops: MaxHops + 1}, "us-east-1"); d != Reject {
		t.Errorf("an over-travelled event must be rejected, whatever the config says")
	}
}

func TestAMalformedHopCounterCountsAsALoop(t *testing.T) {
	// The counter exists only for the case where something is already wrong, so
	// an unreadable one must fail towards "stop", never towards "carry on".
	for _, raw := range []string{"abc", "-1", "9-9", " "} {
		if got := ParseHops(raw); got <= MaxHops {
			t.Errorf("ParseHops(%q) = %d, want something over the limit", raw, got)
		}
	}
	if got := ParseHops(""); got != 0 {
		t.Errorf("ParseHops(\"\") = %d, want 0 — absent means never bridged", got)
	}
	if got := ParseHops(" 1 "); got != 1 {
		t.Errorf("ParseHops(\" 1 \") = %d, want 1", got)
	}
}

func TestValidRegionRejectsAnythingThatWouldBreakASubject(t *testing.T) {
	for _, ok := range []string{"us-east-1", "eu", "ap-south-1"} {
		if !ValidRegion(ok) {
			t.Errorf("ValidRegion(%q) = false, want true", ok)
		}
	}
	// A dot adds a subject level; a wildcard widens every filter built from it.
	for _, bad := range []string{"", "us.east", "us east", "US-EAST", "us_east", "*", ">", "-us", "us-",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {
		if ValidRegion(bad) {
			t.Errorf("ValidRegion(%q) = true, want false", bad)
		}
	}
}
