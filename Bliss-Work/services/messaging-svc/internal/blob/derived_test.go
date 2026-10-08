package blob

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

const derivedSHA = "aa" + "bb" + "cc" + "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

func TestValidVariant(t *testing.T) {
	for _, v := range []string{"v1.pdf", "v1.json", "v12.pdf", "v999.json"} {
		if !ValidVariant(v) {
			t.Errorf("%q should be valid", v)
		}
	}
	for _, v := range []string{"", "v1", "v1.", "v1.exe", "v1.pdf/../x", "../v1.pdf", "v1.PDF", "v1.pdf ", "x1.pdf", "v1000.pdf", "v1.pdf\n"} {
		if ValidVariant(v) {
			t.Errorf("%q must be rejected", v)
		}
	}
}

func TestDerived_RoundTripBesideTheOriginal(t *testing.T) {
	s := newTestStore(t)
	sha, _, err := s.WriteStream(testOrg, strings.NewReader("original bytes"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenDerived(testOrg, sha, "v1.pdf"); !os.IsNotExist(err) {
		t.Fatalf("absent derivative should be not-exist, got %v", err)
	}
	if err := s.PutDerived(testOrg, sha, "v1.pdf", strings.NewReader("%PDF-derived"), 1024); err != nil {
		t.Fatalf("PutDerived: %v", err)
	}
	f, err := s.OpenDerived(testOrg, sha, "v1.pdf")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got, _ := io.ReadAll(f)
	if string(got) != "%PDF-derived" || f.Size() != int64(len(got)) {
		t.Fatalf("got %q size %d", got, f.Size())
	}
	// Same shard directory as the original: that is what lets Remove/RemoveOrg cover it.
	orig, _ := s.blobPath(testOrg, sha)
	if _, err := os.Stat(orig + ".v1.pdf"); err != nil {
		t.Fatalf("derivative is not next to the original: %v", err)
	}
	// The original is untouched.
	o, err := s.Open(testOrg, sha)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(o)
	o.Close()
	if string(b) != "original bytes" {
		t.Fatal("original changed")
	}
}

func TestDerived_SizeCapStoresNothing(t *testing.T) {
	s := newTestStore(t)
	sha, _, _ := s.WriteStream(testOrg, strings.NewReader("x"), 1024)
	err := s.PutDerived(testOrg, sha, "v1.json", bytes.NewReader(make([]byte, 101)), 100)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	if _, err := s.OpenDerived(testOrg, sha, "v1.json"); !os.IsNotExist(err) {
		t.Fatal("an oversize derivative must not be stored")
	}
	// Exactly max is allowed.
	if err := s.PutDerived(testOrg, sha, "v1.json", bytes.NewReader(make([]byte, 100)), 100); err != nil {
		t.Fatalf("exactly max must succeed: %v", err)
	}
	// And no spool file is left behind either way.
	entries, _ := os.ReadDir(s.root + "/tmp")
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "derived-") {
			t.Fatalf("spool file left behind: %s", e.Name())
		}
	}
}

func TestDerived_RejectsBadKeysAndVariants(t *testing.T) {
	s := newTestStore(t)
	cases := []struct{ org, sha, variant string }{
		{"not-a-uuid", derivedSHA, "v1.pdf"},
		{testOrg, "short", "v1.pdf"},
		{testOrg, derivedSHA, "v1.exe"},
		{testOrg, derivedSHA, "../v1.pdf"},
		{testOrg, derivedSHA, ""},
	}
	for _, c := range cases {
		if err := s.PutDerived(c.org, c.sha, c.variant, strings.NewReader("x"), 10); !errors.Is(err, ErrBadKey) {
			t.Errorf("PutDerived(%q,%q,%q) = %v, want ErrBadKey", c.org, c.sha, c.variant, err)
		}
		if _, err := s.OpenDerived(c.org, c.sha, c.variant); !errors.Is(err, ErrBadKey) {
			t.Errorf("OpenDerived(%q,%q,%q) = %v, want ErrBadKey", c.org, c.sha, c.variant, err)
		}
	}
}

// Remove is what the attachment reaper calls once no row references a blob.
func TestDerived_RemoveTakesDerivativesWithTheOriginalAndNothingElse(t *testing.T) {
	s := newTestStore(t)
	sha, _, _ := s.WriteStream(testOrg, strings.NewReader("one"), 1024)
	other, _, _ := s.WriteStream(testOrg, strings.NewReader("two"), 1024)
	for _, v := range []string{"v1.pdf", "v1.json", "v2.pdf"} {
		if err := s.PutDerived(testOrg, sha, v, strings.NewReader("d"), 10); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.PutDerived(testOrg, other, "v1.pdf", strings.NewReader("keep"), 10); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove(testOrg, sha); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"v1.pdf", "v1.json", "v2.pdf"} {
		if _, err := s.OpenDerived(testOrg, sha, v); !os.IsNotExist(err) {
			t.Errorf("derivative %s survived Remove", v)
		}
	}
	if _, err := s.Open(testOrg, sha); !os.IsNotExist(err) {
		t.Error("original survived Remove")
	}
	if f, err := s.OpenDerived(testOrg, other, "v1.pdf"); err != nil {
		t.Errorf("another blob's derivative was removed: %v", err)
	} else {
		f.Close()
	}
	// Removing something already gone is still success (the reaper's contract).
	if err := s.Remove(testOrg, sha); err != nil {
		t.Fatalf("second Remove: %v", err)
	}
}

func TestDerived_RemoveOrgTakesDerivatives(t *testing.T) {
	s := newTestStore(t)
	sha, _, _ := s.WriteStream(testOrg, strings.NewReader("one"), 1024)
	_ = s.PutDerived(testOrg, sha, "v1.pdf", strings.NewReader("d"), 10)
	if err := s.RemoveOrg(testOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenDerived(testOrg, sha, "v1.pdf"); !os.IsNotExist(err) {
		t.Fatal("org erasure left a derivative behind")
	}
}
