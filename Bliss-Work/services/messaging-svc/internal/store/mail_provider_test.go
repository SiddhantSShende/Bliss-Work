package store

import (
	"strings"
	"testing"
)

// A mailbox provider has no envelope of its own — it delivers to exactly the
// addresses named in the headers it is handed — so the per-envelope fan-out
// that SMTP needs cannot be expressed there. One copy therefore carries the
// whole external recipient list, split back into the header each address was
// typed in. Getting that split wrong is not a cosmetic bug: a Bcc that lands in
// To exposes a blind recipient to everybody on the mail.
func TestSplitExternalsByKind(t *testing.T) {
	uid := "018f0000-0000-7000-8000-000000000001"
	recipients := []resolvedAddress{
		{kind: MailKindTo, pos: 0, address: "partner@outside.test"},
		{kind: MailKindTo, pos: 1, address: "colleague@acme.test", userID: &uid},
		{kind: MailKindCc, pos: 0, address: "cc@outside.test"},
		// The same address typed into two headers. It appears once in the
		// output, under the first header it was typed in, because a provider
		// would otherwise deliver two copies to one person.
		{kind: MailKindCc, pos: 1, address: "partner@outside.test"},
		{kind: MailKindBcc, pos: 0, address: "blind@outside.test"},
	}
	externals := []string{"partner@outside.test", "cc@outside.test", "blind@outside.test"}

	to, cc, bcc := splitExternalsByKind(recipients, externals)

	if strings.Join(to, ",") != "partner@outside.test" {
		t.Errorf("to = %v, want just the external To address", to)
	}
	if strings.Join(cc, ",") != "cc@outside.test" {
		t.Errorf("cc = %v, want just the external Cc address", cc)
	}
	if strings.Join(bcc, ",") != "blind@outside.test" {
		t.Errorf("bcc = %v, want the blind address kept as a Bcc", bcc)
	}
}

// A member of this org is deliberately absent from the provider's recipient
// list even when they were addressed: they already have the mail in their
// BlissWork Inbox, and a provider that delivered to them as well would put a
// duplicate in front of them. `externals` is what encodes that, so an address
// missing from it must not reach any of the three lists.
func TestSplitExternalsByKind_LeavesOrgMembersOut(t *testing.T) {
	uid := "018f0000-0000-7000-8000-000000000001"
	recipients := []resolvedAddress{
		{kind: MailKindTo, pos: 0, address: "colleague@acme.test", userID: &uid},
		{kind: MailKindTo, pos: 1, address: "partner@outside.test"},
	}

	to, cc, bcc := splitExternalsByKind(recipients, []string{"partner@outside.test"})

	if len(to) != 1 || to[0] != "partner@outside.test" {
		t.Errorf("to = %v, want only the address outside the org", to)
	}
	if len(cc) != 0 || len(bcc) != 0 {
		t.Errorf("cc = %v, bcc = %v, want both empty", cc, bcc)
	}
}

// Every address on a mail can be a Bcc. The provider send still has to happen —
// it is the only copy there is — so an empty To must not be read as "nothing
// to send".
func TestSplitExternalsByKind_AllBlind(t *testing.T) {
	recipients := []resolvedAddress{
		{kind: MailKindBcc, pos: 0, address: "one@outside.test"},
		{kind: MailKindBcc, pos: 1, address: "two@outside.test"},
	}

	to, cc, bcc := splitExternalsByKind(recipients, []string{"one@outside.test", "two@outside.test"})

	if len(to) != 0 || len(cc) != 0 {
		t.Errorf("to = %v, cc = %v, want both empty", to, cc)
	}
	if len(bcc) != 2 {
		t.Errorf("bcc = %v, want both blind addresses", bcc)
	}
}
