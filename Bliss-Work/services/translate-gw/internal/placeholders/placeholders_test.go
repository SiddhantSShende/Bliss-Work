package placeholders

import (
	"strings"
	"testing"
)

func TestProtect_WrapsEveryKindOfToken(t *testing.T) {
	for _, tok := range []string{"{{name}}", "{{count, number}}", "$t(common:ok)", "<bold>", "</bold>", "<0>", "%s", "%1$s", "{count}", "https://x.test/a?b=1"} {
		got := Protect("go " + tok + " now")
		if want := `<span translate="no">` + strings.NewReplacer("<", "&lt;", ">", "&gt;", "&", "&amp;").Replace(tok) + `</span>`; !strings.Contains(got, want) {
			t.Errorf("%q: %q does not contain %q", tok, got, want)
		}
	}
}

func TestRoundTripThroughIdentityTranslation(t *testing.T) {
	for _, src := range []string{
		"Hello {{name}}, you have {{count}} <bold>new</bold> tasks", "Fish & chips <3", "Save", "{{count}}m ago",
		"Open https://app.example.com/x?y=1&z=2 now", "100% done: %d of %s", "", "a < b > c",
	} {
		got, ok := Restore(Protect(src), src)
		if !ok || got != src {
			t.Errorf("round trip of %q = %q, %v", src, got, ok)
		}
	}
}

func TestRestore_AcceptsReorderedPlaceholders(t *testing.T) {
	src := "{{a}} then {{b}}"
	got, ok := Restore(`<span translate="no">{{b}}</span> luego <span translate="no">{{a}}</span>`, src)
	if !ok || got != "{{b}} luego {{a}}" {
		t.Fatalf("got %q %v", got, ok)
	}
}

func TestRestore_RejectsDroppedChangedOrInventedPlaceholders(t *testing.T) {
	src := "Hi {{name}}, {{count}} left"
	for name, answer := range map[string]string{
		"dropped":    `Hola <span translate="no">{{name}}</span>`,
		"translated": `Hola {{nombre}}, <span translate="no">{{count}}</span> restan`,
		"invented":   `Hola <span translate="no">{{name}}</span>, <span translate="no">{{count}}</span> {{extra}}`,
		"duplicated": `<span translate="no">{{name}}</span> <span translate="no">{{name}}</span> <span translate="no">{{count}}</span>`,
	} {
		if got, ok := Restore(answer, src); ok {
			t.Errorf("%s: accepted %q", name, got)
		}
	}
}

func TestRestore_UnescapesGoogleEntities(t *testing.T) {
	got, ok := Restore("Peces &amp; patatas fritas &#39;ok&#39;", "Fish & chips 'ok'")
	if !ok || got != "Peces & patatas fritas 'ok'" {
		t.Fatalf("got %q %v", got, ok)
	}
}
