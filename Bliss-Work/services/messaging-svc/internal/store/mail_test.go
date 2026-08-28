package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The composer, this package and email-worker each validate addresses, and they
// MUST agree: an address one accepts and another rejects turns a typo into a
// failed send after the fact, or makes a deliverable mail unsendable. These
// cases are the same ones pinned in email-worker's tests/test_mailer.py and in
// packages/shared/src/policy/mailAddress.ts.
func TestNormalizeMailAddress_MatchesTheOtherTwoImplementations(t *testing.T) {
	valid := []struct{ in, want string }{
		{"user@example.com", "user@example.com"},
		{"u@d.co", "u@d.co"},
		{"first.last@sub.domain.org", "first.last@sub.domain.org"},
		{"a+tag@example.io", "a+tag@example.io"},
		{"  trimmed@example.com  ", "trimmed@example.com"},
		// Lower-cased so a send matches the org directory regardless of how the
		// sender happened to capitalise their colleague's address.
		{"Jane.Okafor@ACME.com", "jane.okafor@acme.com"},
	}
	for _, c := range valid {
		if got := NormalizeMailAddress(c.in); got != c.want {
			t.Errorf("NormalizeMailAddress(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	invalid := []string{
		"not-an-email", "@d", "u@", "", "   ", "no-at-symbol.com",
		"two@@at.com", "user@host", "user @host.com", "user@ho st.com",
	}
	for _, in := range invalid {
		if got := NormalizeMailAddress(in); got != "" {
			t.Errorf("NormalizeMailAddress(%q) = %q, want \"\" (rejected)", in, got)
		}
	}
}

// An over-long address is rejected rather than truncated: RFC 5321 caps what a
// server must accept, and half an address is not a different address, it is a
// wrong one.
func TestNormalizeMailAddress_RejectsOverLongAddress(t *testing.T) {
	long := strings.Repeat("a", MaxMailAddressLen) + "@example.com"
	if got := NormalizeMailAddress(long); got != "" {
		t.Errorf("NormalizeMailAddress(<%d chars>) = %q, want \"\"", len(long), got)
	}
}

// The feed row shows one line and has no body of its own, so the preview has to
// carry both halves of what a mail row means: what it is about, and how it
// starts.
func TestMailPreview_JoinsSubjectAndBody(t *testing.T) {
	cases := []struct{ name, subject, body, want string }{
		{"both", "Q3 numbers", "Attaching the deck", "Q3 numbers — Attaching the deck"},
		{"subject only", "Q3 numbers", "", "Q3 numbers"},
		// A subject-less mail must still read as something. A blank row is
		// indistinguishable from a broken one.
		{"body only", "", "Attaching the deck", "(no subject) — Attaching the deck"},
		{"neither", "", "", "(no subject)"},
		// Newlines and runs of whitespace in the body would otherwise blow the
		// single-line row apart.
		{"collapses whitespace", "Notes", "line one\n\n  line two", "Notes — line one line two"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mailPreview(c.subject, c.body); got != c.want {
				t.Errorf("mailPreview(%q, %q) = %q, want %q", c.subject, c.body, got, c.want)
			}
		})
	}
}

func TestMailPreview_TruncatesOnRunesNotBytes(t *testing.T) {
	// Multi-byte throughout: a byte-based cut would both overshoot the intended
	// length and be capable of splitting a character in half.
	got := mailPreview(strings.Repeat("é", 400), "")
	if n := utf8.RuneCountInString(got); n != mailPreviewRunes+1 { // +1 for the ellipsis
		t.Errorf("preview is %d runes, want %d", n, mailPreviewRunes+1)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated preview should end in an ellipsis, got %q", got)
	}
	if !utf8.ValidString(got) {
		t.Error("truncation split a multi-byte rune")
	}
}

func ptr(s string) *string { return &s }

// Delivery splits into "already has an account here" and "has to go over SMTP",
// and each side must be deduplicated for a different reason: a person addressed
// twice would collide on the mail_deliveries primary key, and an address
// addressed twice would receive the mail twice.
func TestSplitMailDelivery(t *testing.T) {
	const author = "author-id"
	const colleague = "colleague-id"

	recipients := []resolvedAddress{
		{kind: MailKindTo, address: "colleague@acme.com", userID: ptr(colleague)},
		// Same person again via Cc — one delivery, not two.
		{kind: MailKindCc, address: "colleague.alias@acme.com", userID: ptr(colleague)},
		{kind: MailKindTo, address: "outside@partner.com"},
		// Same external address again — one SMTP copy, not two.
		{kind: MailKindBcc, address: "outside@partner.com"},
		// The author copied themselves. They already get a SENT-folder row, so
		// an INBOX row for the same mail would collide.
		{kind: MailKindCc, address: "me@acme.com", userID: ptr(author)},
	}

	locals, externals := splitMailDelivery(recipients, author)

	if len(locals) != 1 || locals[0] != colleague {
		t.Errorf("locals = %v, want exactly [%s]", locals, colleague)
	}
	if len(externals) != 1 || externals[0] != "outside@partner.com" {
		t.Errorf("externals = %v, want exactly [outside@partner.com]", externals)
	}
}

// Inbound mail has no author to exclude, so an empty author id must not
// accidentally drop a real recipient.
func TestSplitMailDelivery_NoAuthorKeepsEveryLocalRecipient(t *testing.T) {
	recipients := []resolvedAddress{
		{kind: MailKindTo, address: "a@acme.com", userID: ptr("user-a")},
		{kind: MailKindCc, address: "b@acme.com", userID: ptr("user-b")},
	}
	locals, externals := splitMailDelivery(recipients, "")
	if len(locals) != 2 {
		t.Errorf("locals = %v, want both recipients", locals)
	}
	if len(externals) != 0 {
		t.Errorf("externals = %v, want none", externals)
	}
}

// relayRecipients is what makes a colleague's mail also reach their real
// mailbox, not just their BlissWork inbox — the bug this file's SendMail
// change exists to fix. It must include local recipients (unlike externals),
// still dedup an address that appears in two headers, and still exclude the
// author even when they cc'd themselves.
func TestRelayRecipients(t *testing.T) {
	const author = "author-id"
	recipients := []resolvedAddress{
		{kind: MailKindTo, address: "colleague@acme.com", userID: ptr("colleague-id")},
		{kind: MailKindTo, address: "outside@partner.com"},
		// Same external address again via Bcc — one wire copy, not two.
		{kind: MailKindBcc, address: "outside@partner.com"},
		// The author cc'd themselves — must not get mailed their own mail.
		{kind: MailKindCc, address: "me@acme.com", userID: ptr(author)},
	}

	got := relayRecipients(recipients, "Me@Acme.com") // case mismatch, deliberately

	want := []string{"colleague@acme.com", "outside@partner.com"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("relayRecipients = %v, want %v (colleague included, external deduped, author excluded case-insensitively)", got, want)
	}
}

func TestRelayRecipients_NoAuthorKeepsEveryone(t *testing.T) {
	recipients := []resolvedAddress{
		{kind: MailKindTo, address: "a@acme.com", userID: ptr("user-a")},
		{kind: MailKindCc, address: "b@partner.com"},
	}
	got := relayRecipients(recipients, "")
	if len(got) != 2 {
		t.Errorf("relayRecipients = %v, want both addresses", got)
	}
}
