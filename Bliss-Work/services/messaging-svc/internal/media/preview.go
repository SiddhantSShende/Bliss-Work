package media

import (
	"bytes"
	"path/filepath"
	"strings"
)

// Preview decides which attachments the Office Document Sandbox may be asked to
// convert, and checks the bytes really are what the name claims.
//
// This is the SERVER's decision. The client keeps its own list only to decide
// whether to show an Open button; nothing here trusts it, the stored mime
// (DOCX/XLSX/PPTX are stored as application/zip or octet-stream, DOC/XLS/PPT as
// octet-stream — see Sniff), or whether a converted file already exists.
//
// Nothing in this file opens or parses an Office document. It compares the first
// eight bytes with a signature; the parsing happens only inside the sandbox.

var (
	oleMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}
	zipMagic = []byte("PK\x03\x04")
)

// Preview artifact kinds, as the sandbox reports them in X-Preview-Kind.
const (
	ArtifactPDF    = "pdf"
	ArtifactSheets = "sheets"
)

// PreviewVariantVersion tags every derived file. Bump it when the converter's
// output changes shape, which orphans (and so invalidates) every cached preview.
const PreviewVariantVersion = "v1"

// PreviewSpec is one supported conversion.
type PreviewSpec struct {
	Kind     string // the sandbox's ?kind= and the file extension: doc, docx, ...
	Artifact string // ArtifactPDF or ArtifactSheets
	Variant  string // blob derivative name, e.g. "v1.pdf"
	magic    []byte
}

// ContentType is the type the artifact is served as. It still passes through
// ServeHeaders, which only ever inlines the allowlisted PDF; the sheets JSON is
// downgraded to octet-stream plus attachment, which a fetch() reads fine and a
// browser navigation will not render.
func (p PreviewSpec) ContentType() string {
	if p.Artifact == ArtifactPDF {
		return "application/pdf"
	}
	return "application/json"
}

// FileExt is the extension a saved copy of the artifact should carry.
func (p PreviewSpec) FileExt() string {
	if p.Artifact == ArtifactSheets {
		return "json"
	}
	return "pdf"
}

// MagicOK reports whether head starts with this kind's container signature.
func (p PreviewSpec) MagicOK(head []byte) bool {
	return bytes.HasPrefix(head, p.magic)
}

// MagicLen is how many leading bytes MagicOK needs.
func MagicLen() int { return len(oleMagic) }

func spec(kind, artifact string, magic []byte) PreviewSpec {
	p := PreviewSpec{Kind: kind, Artifact: artifact, magic: magic}
	p.Variant = PreviewVariantVersion + "." + p.FileExt()
	return p
}

var previewSpecs = map[string]PreviewSpec{
	"doc":  spec("doc", ArtifactPDF, oleMagic),
	"docx": spec("docx", ArtifactPDF, zipMagic),
	"ppt":  spec("ppt", ArtifactPDF, oleMagic),
	"pptx": spec("pptx", ArtifactPDF, zipMagic),
	"xls":  spec("xls", ArtifactSheets, oleMagic),
	"xlsx": spec("xlsx", ArtifactSheets, zipMagic),
}

// PreviewFor maps a (decrypted, stored) filename to its conversion, by
// extension. The second result is false for everything else: RTF, ODF, archives,
// images, PDFs, code, and a name with no extension at all.
func PreviewFor(filename string) (PreviewSpec, bool) {
	name := strings.TrimSpace(filename)
	ext := filepath.Ext(name)
	// ".docx" alone is a dotfile, not a Word document with an empty name.
	if strings.TrimSpace(strings.TrimSuffix(name, ext)) == "" {
		return PreviewSpec{}, false
	}
	p, ok := previewSpecs[strings.TrimPrefix(strings.ToLower(ext), ".")]
	return p, ok
}
