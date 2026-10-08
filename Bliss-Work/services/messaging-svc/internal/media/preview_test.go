package media

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPreviewFor(t *testing.T) {
	supported := map[string]string{
		"a.doc": "doc", "a.DOCX": "docx", "Report Q3.XlsX": "xlsx", "b.xls": "xls",
		"deck.pptx": "pptx", "old.PPT": "ppt", "weird.name.docx": "docx", "  padded.doc  ": "doc",
	}
	for name, kind := range supported {
		p, ok := PreviewFor(name)
		if !ok || p.Kind != kind {
			t.Errorf("PreviewFor(%q) = %+v, %v; want kind %s", name, p, ok, kind)
		}
	}
	// Everything outside the supported set must be refused — including the
	// look-alikes the plan names as download-only, and names a sender controls.
	for _, name := range []string{
		"", "noext", ".docx", "a.rtf", "a.odt", "a.ods", "a.odp", "a.pdf", "a.png", "a.zip", "a.rar", "a.7z",
		"a.eml", "a.msg", "a.psd", "a.ai", "a.dwg", "a.js", "a.py", "a.go", "a.csv", "a.txt", "a.docm", "a.xlsm",
		"a.dotx", "a.docx.exe", "a.docx.", "a.doc/", "docx", "a.doc\x00.exe",
	} {
		if p, ok := PreviewFor(name); ok {
			t.Errorf("PreviewFor(%q) must be refused, got %+v", name, p)
		}
	}
}

func TestPreviewMagic(t *testing.T) {
	ole := []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0}
	zip := []byte("PK\x03\x04rest")
	exe := []byte("MZ\x90\x00rest of an executable")
	for kind, p := range previewSpecs {
		ooxml := p.Kind == "docx" || p.Kind == "xlsx" || p.Kind == "pptx"
		if p.MagicOK(ole) == ooxml {
			t.Errorf("%s: OLE signature accepted=%v, want %v", kind, p.MagicOK(ole), !ooxml)
		}
		if p.MagicOK(zip) != ooxml {
			t.Errorf("%s: ZIP signature accepted=%v, want %v", kind, p.MagicOK(zip), ooxml)
		}
		if p.MagicOK(exe) || p.MagicOK(nil) || p.MagicOK([]byte{0xD0, 0xCF}) {
			t.Errorf("%s: accepted an executable, nil, or a truncated signature", kind)
		}
	}
}

func TestPreviewVariantsAreAllowedByTheBlobStore(t *testing.T) {
	// Variants are interpolated into blob keys; blob.ValidVariant is the gate.
	for kind, p := range previewSpecs {
		want := PreviewVariantVersion + ".pdf"
		if p.Artifact == ArtifactSheets {
			want = PreviewVariantVersion + ".json"
		}
		if p.Variant != want {
			t.Errorf("%s: variant %q, want %q", kind, p.Variant, want)
		}
	}
}

// The same list is asserted by the app (lib/attachmentCapability.test.ts) and the
// sandbox (tests/test_spec.py), so the three copies cannot drift apart.
func TestPreviewMatchesTheSharedExtensionFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/shared/fixtures/office-preview-extensions.json")
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fx struct {
		Preview        map[string]string `json:"preview"`
		NotPreviewable []string          `json:"notPreviewable"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Preview) == 0 || len(fx.NotPreviewable) == 0 {
		t.Fatal("fixture is empty")
	}
	for ext, artifact := range fx.Preview {
		p, ok := PreviewFor("file." + ext)
		if !ok {
			t.Errorf(".%s should be previewable", ext)
			continue
		}
		want := ArtifactPDF
		if artifact == "sheet" {
			want = ArtifactSheets
		}
		if p.Artifact != want {
			t.Errorf(".%s artifact = %s, want %s", ext, p.Artifact, want)
		}
	}
	for _, ext := range fx.NotPreviewable {
		if _, ok := PreviewFor("file." + ext); ok {
			t.Errorf(".%s must not be previewable", ext)
		}
	}
	// And nothing is previewable that the fixture does not list.
	if len(previewSpecs) != len(fx.Preview) {
		t.Errorf("server supports %d kinds, fixture lists %d", len(previewSpecs), len(fx.Preview))
	}
}
