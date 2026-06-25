/**
 * Phase 10 file-offer encoding. A file offer is sent as an ordinary thread
 * message so it persists and both peers see it inline. The body is:
 *
 *     "📎 {name} · {prettySize}" + U+001F + JSON.stringify(envelope)
 *
 * The readable prefix is what inbox previews / notifications / search show; the
 * thread renderer detects the U+001F sentinel, parses the trailing envelope,
 * and renders a FileAttachmentBubble (driven by the WebRTC transfer state)
 * instead of plain text. Keeping the structured part in the body means ZERO
 * backend/schema changes — messaging-svc treats it as ordinary text.
 */
export interface FileOfferEnvelope {
  v: 1;
  offerId: string;
  name: string;
  size: number;
  sha256: string;
  mime: string;
}

// Unit Separator (U+001F) — a non-printing control char that never appears in
// user-typed text, so it cleanly separates the readable prefix from the JSON.
const SENTINEL = String.fromCharCode(0x1f);

export function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function encodeFileOffer(o: Omit<FileOfferEnvelope, "v">): string {
  const envelope: FileOfferEnvelope = { v: 1, ...o };
  return `📎 ${o.name} · ${prettySize(o.size)}${SENTINEL}${JSON.stringify(envelope)}`;
}

/** Returns the envelope if `body` is a file offer, else null (plain message). */
export function parseFileOffer(body: string): FileOfferEnvelope | null {
  const i = body.indexOf(SENTINEL);
  if (i < 0) return null;
  try {
    const o = JSON.parse(body.slice(i + 1)) as FileOfferEnvelope;
    if (o && o.v === 1 && typeof o.offerId === "string" && typeof o.sha256 === "string") {
      return o;
    }
  } catch {
    /* not a valid envelope — treat as plain text */
  }
  return null;
}
