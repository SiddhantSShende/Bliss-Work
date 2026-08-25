package internalauth

import "testing"

func TestMatchingTokensAreAccepted(t *testing.T) {
	if !Matches("shh", "shh") {
		t.Error("want true for matching tokens")
	}
}

func TestMismatchedTokensAreRejected(t *testing.T) {
	if Matches("wrong", "shh") {
		t.Error("want false for mismatched tokens")
	}
}

func TestMissingProvidedTokenIsRejected(t *testing.T) {
	if Matches("", "shh") {
		t.Error("want false for an empty provided token")
	}
}

// An unconfigured expected secret must reject every caller — including one
// that also sends an empty string — never "accept anything".
func TestUnconfiguredExpectedTokenFailsClosed(t *testing.T) {
	if Matches("anything", "") {
		t.Error("want false when expected is unconfigured")
	}
	if Matches("", "") {
		t.Error("want false when both provided and expected are empty")
	}
}
