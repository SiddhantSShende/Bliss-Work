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

/** Longest file name kept from an offer — the field is peer-controlled. */
const MAX_NAME_LENGTH = 255;

/**
 * Returns the envelope if `body` is a file offer, else null (plain message).
 *
 * The envelope is written by the OTHER party, so every field is checked rather
 * than trusted to have the shape `encodeFileOffer` gives it. A `name` that was an
 * object used to reach the bubble unchanged and React threw while rendering it,
 * taking the whole chat view down. The two ids are required; the descriptive
 * fields degrade to harmless defaults, like the media envelope's.
 */
export function parseFileOffer(body: string): FileOfferEnvelope | null {
  const i = body.indexOf(SENTINEL);
  if (i < 0) return null;
  try {
    const o: unknown = JSON.parse(body.slice(i + 1));
    if (!o || typeof o !== "object") return null;
    const e = o as Record<string, unknown>;
    if (e.v !== 1 || typeof e.offerId !== "string" || typeof e.sha256 !== "string") return null;
    return {
      v: 1,
      offerId: e.offerId,
      sha256: e.sha256,
      name: typeof e.name === "string" && e.name ? e.name.slice(0, MAX_NAME_LENGTH) : "file",
      size: typeof e.size === "number" && Number.isFinite(e.size) && e.size >= 0 ? e.size : 0,
      mime: typeof e.mime === "string" ? e.mime : "application/octet-stream",
    };
  } catch {
    /* not a valid envelope — treat as plain text */
  }
  return null;
}
