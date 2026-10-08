import { describe, expect, it } from "vitest";
import shared from "../../../shared/fixtures/office-preview-extensions.json";
import {
  attachmentCapability,
  fileExtension,
  isDocumentAttachment,
  previewUrl,
  type AttachmentCapability,
} from "./attachmentCapability";

// What the server really stores for these: DOCX/XLSX/PPTX are application/zip or
// application/octet-stream, DOC/XLS/PPT application/octet-stream, CSV text/plain.
const OCTET = "application/octet-stream";
const ZIP = "application/zip";

const kindOf = (name: string, mime: string) => attachmentCapability({ name, mime });
const doc = (mode: "pdf" | "sheet" | "csv" | "text", ext: string): AttachmentCapability => ({ kind: "document", mode, ext });

describe("attachmentCapability — the product behaviour matrix", () => {
  it.each([
    ["Word", "Report.docx", ZIP, doc("pdf", "docx")],
    ["Word (legacy)", "report.doc", OCTET, doc("pdf", "doc")],
    ["PowerPoint", "Deck.pptx", ZIP, doc("pdf", "pptx")],
    ["PowerPoint (legacy)", "deck.ppt", OCTET, doc("pdf", "ppt")],
    ["Excel", "Budget.xlsx", ZIP, doc("sheet", "xlsx")],
    ["Excel (legacy)", "budget.xls", OCTET, doc("sheet", "xls")],
    ["CSV stored as text/plain", "data.csv", "text/plain", doc("csv", "csv")],
    ["CSV stored as octet-stream", "data.csv", OCTET, doc("csv", "csv")],
    ["a .txt the server could not store as text", "notes.txt", OCTET, doc("text", "txt")],
  ] as const)("%s opens in the document viewer", (_l, name, mime, want) => {
    expect(kindOf(name, mime)).toEqual(want);
  });

  it("is decided by the extension, not by an Office mime the server never stores", () => {
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(kindOf("a.docx", docxMime)).toEqual(doc("pdf", "docx"));
    expect(kindOf("not-office.bin", docxMime)).toEqual({ kind: "download" });
  });

  it.each([
    ["a PDF", "a.pdf", "application/pdf"],
    ["a PNG", "a.png", "image/png"],
    ["a JPEG", "a.jpg", "image/jpeg"],
    ["a video", "a.mp4", "video/mp4"],
    ["a video that is really an audio file (M4A is stored as video/mp4)", "song.m4a", "video/mp4"],
    ["plain text", "readme.txt", "text/plain"],
    ["plain text with no extension", "LICENSE", "text/plain"],
    ["source code stored as text/plain", "main.go", "text/plain"],
  ])("%s keeps the existing Lightbox", (_l, name, mime) => {
    expect(kindOf(name, mime)).toEqual({ kind: "native" });
  });

  it.each(["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/aiff", "audio/midi"])(
    "%s keeps its existing outside-the-app behaviour",
    (mime) => {
      expect(kindOf("clip.bin", mime)).toEqual({ kind: "external" });
    },
  );

  it.each([
    ["RTF", "a.rtf"],
    ["ODT", "a.odt"],
    ["ODS", "a.ods"],
    ["ODP", "a.odp"],
    ["source files", "a.py"],
    ["EML", "a.eml"],
    ["MSG", "a.msg"],
    ["PSD", "a.psd"],
    ["AI", "a.ai"],
    ["DWG", "a.dwg"],
    ["ZIP", "a.zip"],
    ["RAR", "a.rar"],
    ["7Z", "a.7z"],
    ["TAR.GZ", "a.tar.gz"],
    ["a macro-enabled Word file", "a.docm"],
    ["a macro-enabled Excel file", "a.xlsm"],
    ["an Office template", "a.dotx"],
    ["a file with no extension", "Makefile"],
    ["a dotfile named like an extension", ".docx"],
    ["a name that only ends in a supported extension's text", "docx"],
    ["an executable renamed with a double extension", "a.docx.exe"],
  ])("%s is download-only", (_l, name) => {
    for (const mime of [OCTET, ZIP, "application/x-whatever"]) {
      expect(kindOf(name, mime)).toEqual({ kind: "download" });
    }
  });
});

describe("attachmentCapability — precedence", () => {
  it("never lets an extension re-route a type the Lightbox renders", () => {
    expect(kindOf("fake.docx", "application/pdf")).toEqual({ kind: "native" });
    expect(kindOf("fake.xlsx", "image/png")).toEqual({ kind: "native" });
    expect(kindOf("fake.csv", "image/png")).toEqual({ kind: "native" });
  });

  it("puts audio ahead of every extension", () => {
    expect(kindOf("looks.csv", "audio/mpeg")).toEqual({ kind: "external" });
    expect(kindOf("looks.docx", "audio/mpeg")).toEqual({ kind: "external" });
  });

  it("checks .csv before text/plain, and .csv only", () => {
    expect(kindOf("a.csv", "text/plain")).toEqual(doc("csv", "csv"));
    expect(kindOf("a.tsv", "text/plain")).toEqual({ kind: "native" });
  });

  it("sends a .docx stored as text/plain to the existing text preview, as before", () => {
    // text/plain wins over the Office extensions: the server stored it as text, and
    // the server would refuse to convert it (no ZIP signature) anyway.
    expect(kindOf("a.docx", "text/plain")).toEqual({ kind: "native" });
  });

  it("is case-insensitive about the extension and tolerant of mime parameters", () => {
    expect(kindOf("REPORT.DOCX", ZIP)).toEqual(doc("pdf", "docx"));
    expect(kindOf("data.CSV", "text/plain; charset=utf-8")).toEqual(doc("csv", "csv"));
    expect(kindOf("a.png", "IMAGE/PNG")).toEqual({ kind: "native" });
    expect(kindOf("a", "Application/PDF; x=y")).toEqual({ kind: "native" });
  });

  it("treats a missing mime as unknown, not as anything special", () => {
    expect(kindOf("a.docx", "")).toEqual(doc("pdf", "docx"));
    expect(kindOf("a.zip", "")).toEqual({ kind: "download" });
  });

  it("does not demote anything by size in v1", () => {
    for (const size of [0, 1, 25 * 1024 * 1024, 10 ** 12]) {
      expect(attachmentCapability({ name: "a.docx", mime: ZIP, size })).toEqual(doc("pdf", "docx"));
      expect(attachmentCapability({ name: "a.csv", mime: "text/plain", size })).toEqual(doc("csv", "csv"));
    }
  });
});

describe("isDocumentAttachment", () => {
  it("is true only for the document kind", () => {
    expect(isDocumentAttachment({ name: "a.docx", mime: ZIP })).toBe(true);
    expect(isDocumentAttachment({ name: "a.pdf", mime: "application/pdf" })).toBe(false);
    expect(isDocumentAttachment({ name: "a.mp3", mime: "audio/mpeg" })).toBe(false);
    expect(isDocumentAttachment({ name: "a.zip", mime: ZIP })).toBe(false);
  });
});

describe("fileExtension", () => {
  it.each([
    ["a.docx", "docx"],
    ["A.B.XLSX", "xlsx"],
    ["  padded.doc  ", "doc"],
    ["dir/sub/a.pptx", "pptx"],
    ["dir\\sub\\a.xls", "xls"],
    ["noext", ""],
    [".docx", ""],
    ["trailing.", ""],
    ["", ""],
  ])("%j → %j", (name, want) => {
    expect(fileExtension(name)).toBe(want);
  });
});

describe("previewUrl", () => {
  it("inserts /preview before the query, keeping the same signed token", () => {
    expect(previewUrl("https://api.test/api/messaging/media/abc?t=tok.sig")).toBe(
      "https://api.test/api/messaging/media/abc/preview?t=tok.sig",
    );
    expect(previewUrl("/api/messaging/media/abc?t=tok")).toBe("/api/messaging/media/abc/preview?t=tok");
  });

  it("tolerates a trailing slash and a missing query", () => {
    expect(previewUrl("https://x.test/media/abc/?t=1")).toBe("https://x.test/media/abc/preview?t=1");
    expect(previewUrl("https://x.test/media/abc")).toBe("https://x.test/media/abc/preview");
  });

  it("does not drop other query parameters", () => {
    expect(previewUrl("https://x.test/media/abc?t=1&dl=1")).toBe("https://x.test/media/abc/preview?t=1&dl=1");
  });
});

// The same list is asserted by the server (internal/media/preview_test.go) and the
// sandbox (tests/test_spec.py), so the three copies cannot drift apart.
describe("the shared preview-extension fixture", () => {
  it.each(Object.entries(shared.preview))("%s previews as %s", (ext, artifact) => {
    expect(attachmentCapability({ name: `file.${ext}`, mime: "application/octet-stream" })).toEqual({
      kind: "document",
      mode: artifact === "sheet" ? "sheet" : "pdf",
      ext,
    });
  });

  it.each(shared.notPreviewable.filter((e) => !["txt", "csv", "pdf", "png", "jpg"].includes(e)))(
    ".%s is download-only",
    (ext) => {
      expect(attachmentCapability({ name: `file.${ext}`, mime: "application/octet-stream" })).toEqual({ kind: "download" });
    },
  );
});
