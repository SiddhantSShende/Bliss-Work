/**
 * What the app does with an attachment: the ONE place that decides, shared by
 * Mail, chats, channels and the chat assets sheet.
 *
 *   native    → the existing Lightbox (images, video, PDF, plain text). Unchanged.
 *   external  → the existing "hand it outside the app" path (audio). Unchanged.
 *   document  → the in-app document viewer: Word, PowerPoint and Excel (converted
 *               in the Office Document Sandbox, see the server's /media/{id}/preview),
 *               plus CSV and .txt files that the existing text preview can't carry.
 *   download  → no Open action at all; only Download.
 *
 * ── This only decides which button to show ─────────────────────────────────
 * The server independently authorizes and validates every preview request (the
 * extension, the magic bytes, the size, and who is asking), so nothing here is a
 * security control. It must still be conservative, because the inputs are
 * sender-controlled: `name` and `mime` come from a message envelope, and the
 * server stores DOCX/XLSX/PPTX as application/zip or octet-stream and DOC/XLS/PPT
 * as octet-stream, so for Office files the EXTENSION decides, not the mime.
 *
 * The extension list lives here and in services/messaging-svc/internal/media/
 * preview.go; shared fixture tests on both sides keep them from drifting.
 */

export type DocumentMode =
  /** Word / PowerPoint, converted to a PDF by the sandbox and shown in a frame. */
  | "pdf"
  /** Excel, converted to a JSON of cell text by the sandbox and shown as a read-only grid. */
  | "sheet"
  /** A comma-separated file, parsed in the browser and shown in the same grid. */
  | "csv"
  /** A `.txt` whose mime is not text/plain, decoded in the browser. */
  | "text";

export type AttachmentCapability =
  | { kind: "native" }
  | { kind: "external" }
  | { kind: "download" }
  | { kind: "document"; mode: DocumentMode; ext: string };

export interface AttachmentFacts {
  name: string;
  mime: string;
  /**
   * Bytes. Accepted but deliberately NOT used to demote a document to download
   * in v1: no size threshold is a product decision yet (the limits are measured
   * and enforced server-side, and a file the sandbox cannot convert fails into a
   * Download fallback). When one is decided it is a single constant to apply here.
   */
  size?: number;
}

const PDF_EXTS: ReadonlySet<string> = new Set(["doc", "docx", "ppt", "pptx"]);
const SHEET_EXTS: ReadonlySet<string> = new Set(["xls", "xlsx"]);

/** The lowercase extension of a file name, or "" for none (and for a dotfile like ".docx"). */
export function fileExtension(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or the name is nothing but an extension
  return base.slice(dot + 1).toLowerCase();
}

function baseMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The order matters and is deliberate:
 *   1. the types the Lightbox already renders win over any extension, so a PDF is
 *      always a PDF and nothing here can re-route it;
 *   2. audio keeps its existing outside-the-app behaviour;
 *   3. `.csv` is checked BEFORE text/plain, because the server stores CSV as
 *      text/plain and the existing text preview would show it as raw text;
 *   4. text/plain otherwise stays on the existing preview;
 *   5. Office files go by extension;
 *   6. a `.txt` whose mime is NOT text/plain gets the new text view. The server
 *      stores any `.txt` as text/plain (Sniff's extension fallback), so this is
 *      reached only through an envelope that claims another mime — it keeps
 *      "a .txt always opens in the app" true whatever the envelope says;
 *   7. everything else is download-only.
 */
export function attachmentCapability({ name, mime }: AttachmentFacts): AttachmentCapability {
  const m = baseMime(mime);
  const ext = fileExtension(name);

  if (m.startsWith("image/") || m.startsWith("video/") || m === "application/pdf") return { kind: "native" };
  if (m.startsWith("audio/")) return { kind: "external" };
  if (ext === "csv") return { kind: "document", mode: "csv", ext };
  if (m === "text/plain") return { kind: "native" };
  if (PDF_EXTS.has(ext)) return { kind: "document", mode: "pdf", ext };
  if (SHEET_EXTS.has(ext)) return { kind: "document", mode: "sheet", ext };
  if (ext === "txt") return { kind: "document", mode: "text", ext };
  return { kind: "download" };
}

/** True when the in-app document viewer opens this attachment. */
export function isDocumentAttachment(facts: AttachmentFacts): boolean {
  return attachmentCapability(facts).kind === "document";
}

/**
 * The preview URL for a signed attachment URL (`…/media/{id}?t=<token>`):
 * `…/media/{id}/preview?t=<token>`. The same signed link authorizes it, and the
 * server re-checks access on every request. Works for absolute and relative URLs.
 */
export function previewUrl(signedUrl: string): string {
  const q = signedUrl.indexOf("?");
  const path = (q < 0 ? signedUrl : signedUrl.slice(0, q)).replace(/\/+$/, "");
  const query = q < 0 ? "" : signedUrl.slice(q);
  return `${path}/preview${query}`;
}
