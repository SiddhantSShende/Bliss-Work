package store

import "testing"

// draftAddresses is what decides which rows a draft's recipient table gets, and
// it is the one place where "what the user typed" is taken at face value —
// validation belongs at send. What it must NOT do is store blanks or leave gaps
// in `position`, which is half the primary key.
func TestDraftAddresses_KeepsOrderAndDropsBlanks(t *testing.T) {
	got := draftAddresses(
		[]string{"first@example.com", "  ", "second@example.com"},
		[]string{"", "copy@example.com"},
		nil,
	)

	want := []resolvedAddress{
		{kind: MailKindTo, pos: 0, address: "first@example.com"},
		{kind: MailKindTo, pos: 1, address: "second@example.com"},
		{kind: MailKindCc, pos: 0, address: "copy@example.com"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d addresses, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].kind != want[i].kind || got[i].pos != want[i].pos || got[i].address != want[i].address {
			t.Errorf("address %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	// Every recipient a draft carries is unresolved: resolving an address
	// against the org directory is a SEND-time decision, and a draft that
	// pre-resolved it would go stale the moment somebody joins or leaves.
	for _, r := range got {
		if r.userID != nil {
			t.Errorf("draft address %q resolved to a user at save time", r.address)
		}
	}
}

// A half-typed address is the ordinary state of a draft and must survive the
// save — rejecting it would mean the composer could not be left mid-word.
func TestDraftAddresses_KeepsPartiallyTypedAddresses(t *testing.T) {
	got := draftAddresses([]string{"jane@"}, nil, nil)
	if len(got) != 1 || got[0].address != "jane@" {
		t.Fatalf("got %+v, want the address stored as typed", got)
	}
}

// Trimmed on the way in, so a save and the send that follows agree on what the
// address is — send normalizes, and leading whitespace would otherwise make the
// stored row differ from the delivered one.
func TestDraftAddresses_TrimsSurroundingSpace(t *testing.T) {
	got := draftAddresses([]string{"  jane@example.com  "}, nil, nil)
	if len(got) != 1 || got[0].address != "jane@example.com" {
		t.Fatalf("got %+v, want the address trimmed", got)
	}
}

// The address column is bounded by RFC 5321; a draft is not a licence to store
// an unbounded string in a table with a UNIQUE-ish key on it.
func TestDraftAddresses_DropsOverLongAddress(t *testing.T) {
	long := make([]byte, MaxMailAddressLen+1)
	for i := range long {
		long[i] = 'a'
	}
	got := draftAddresses([]string{string(long), "ok@example.com"}, nil, nil)
	if len(got) != 1 || got[0].address != "ok@example.com" {
		t.Fatalf("got %+v, want only the address within the length limit", got)
	}
	// And the survivor keeps position 0 — positions are dense after the drop.
	if got[0].pos != 0 {
		t.Errorf("position = %d, want 0 (dense after a drop)", got[0].pos)
	}
}
