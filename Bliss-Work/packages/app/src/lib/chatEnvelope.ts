/**
 * Structured chat message payloads — attachments and shared locations.
 *
 * A structured message is an ORDINARY message whose body is:
 *
 *     "{readable prefix}" + U+001F + JSON.stringify(envelope)
 *
 * This extends the v1 file-offer encoding in `fileOffer.ts`. Keeping the
 * payload inside the body is not a shortcut — it is the only encoding that
 * works across all four send paths, because `kind` is accepted by
 * `POST /conversations/messages` alone: `reply` and `replyToThread` do not take
 * it, and `channel_messages` has no `kind` column at all. A schema-based design
 * would need a new column, three request fields and three store signatures
 * before a single pixel rendered.
 *
 * Two properties fall out of it for free:
 *   - the payload is encrypted at rest, because message bodies are
 *     (messages.body_enc). Shared coordinates are never stored in the clear.
 *   - the readable prefix is exactly what inbox previews, notifications and
 *     search show, so a media message reads as "🖼️ 3 photos" everywhere the
 *     server renders text it cannot parse.
 *
 * The cost is that the SERVER cannot see which attachments a message references
 * (it only holds ciphertext). That is why uploads expire unless explicitly
 * committed — see services/messaging-svc/migrations/0010_attachments.sql.
 */
import { parseFileOffer, prettySize, type FileOfferEnvelope } from "./fileOffer";

/** Unit Separator — a non-printing control char that never appears in typed text. */
const SENTINEL = String.fromCharCode(0x1f);

/** Server-enforced per-file cap (MEDIA_MAX_BYTES). Files above it fall back to P2P. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** Most files in a single message. Bounds both the body size and the upload burst. */
export const MEDIA_MAX_FILES = 10;

export interface MediaItem {
  /** attachments.id — resolved to a signed URL at render time. */
  id: string;
  name: string;
  size: number;
  /** Server-SNIFFED type. Never trust a locally-derived one for rendering decisions. */
  mime: string;
  /** Optional client-generated poster (another attachment id). */
  thumbId?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface MediaEnvelope {
  v: 2;
  kind: "media";
  items: MediaItem[];
}

export interface LocationEnvelope {
  v: 2;
  kind: "location";
  lat: number;
  lng: number;
  label?: string;
  /** Metres, from the Geolocation API. Rendered as "±N m" when present. */
  accuracy?: number;
}

/** A v1 file offer, kept so historical messages keep rendering. */
export interface FileOfferV2Wrapper {
  v: 1;
  kind: "fileOffer";
  offer: FileOfferEnvelope;
}

export type ChatEnvelope = MediaEnvelope | LocationEnvelope | FileOfferV2Wrapper;

// ── encoding ────────────────────────────────────────────────────────────────

function encode(prefix: string, envelope: MediaEnvelope | LocationEnvelope): string {
  return `${prefix}${SENTINEL}${JSON.stringify(envelope)}`;
}

/**
 * The readable prefix is the whole message as far as anything that cannot parse
 * the envelope is concerned — inbox rows, push notifications, the desktop
 * tray. It has to stand alone.
 */
export function mediaPrefix(items: MediaItem[]): string {
  if (items.length === 0) return "📎 Attachment";
  const only = items.length === 1 ? items[0] : undefined;
  if (only) {
    const icon = only.mime.startsWith("image/")
      ? "🖼️"
      : only.mime.startsWith("video/")
        ? "🎬"
        : "📎";
    return `${icon} ${only.name} · ${prettySize(only.size)}`;
  }
  const total = items.reduce((n, it) => n + it.size, 0);
  if (items.every((it) => it.mime.startsWith("image/"))) {
    return `🖼️ ${items.length} photos`;
  }
  return `📎 ${items.length} files · ${prettySize(total)}`;
}

export function encodeMedia(items: MediaItem[]): string {
  return encode(mediaPrefix(items), { v: 2, kind: "media", items });
}

export function encodeLocation(l: {
  lat: number;
  lng: number;
  label?: string;
  accuracy?: number;
}): string {
  const prefix = `📍 ${l.label ?? "Shared location"}`;
  return encode(prefix, { v: 2, kind: "location", ...l });
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Returns the envelope carried by `body`, or null when it is plain text.
 *
 * Every field is validated before the caller can act on it. The body is
 * attacker-controlled — the sender chooses it, and a forwarded message carries
 * a body written by someone the viewer may not trust — so a malformed or
 * hostile envelope must degrade to "render as text", never throw and blank the
 * thread.
 */
export function parseChatEnvelope(body: string): ChatEnvelope | null {
  const i = body.indexOf(SENTINEL);
  if (i < 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(i + 1));
  } catch {
    return null; // not an envelope — plain text that happens to contain U+001F
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.v === 2 && o.kind === "media") {
    const items = parseItems(o.items);
    return items.length > 0 ? { v: 2, kind: "media", items } : null;
  }

  if (o.v === 2 && o.kind === "location") {
    const lat = num(o.lat);
    const lng = num(o.lng);
    // Out-of-range coordinates would produce a nonsense map request and a
    // nonsense maps link, so reject rather than render them.
    if (lat === undefined || lng === undefined) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return {
      v: 2,
      kind: "location",
      lat,
      lng,
      label: typeof o.label === "string" ? o.label.slice(0, 200) : undefined,
      accuracy: num(o.accuracy),
    };
  }

  // Fall back to the v1 peer-to-peer file offer so old messages still render.
  const offer = parseFileOffer(body);
  return offer ? { v: 1, kind: "fileOffer", offer } : null;
}

function parseItems(raw: unknown): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaItem[] = [];
  for (const entry of raw.slice(0, MEDIA_MAX_FILES)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) continue;
    out.push({
      id: e.id,
      name: typeof e.name === "string" && e.name ? e.name.slice(0, 255) : "file",
      size: num(e.size) ?? 0,
      // Default to a type we will never render inline, so a missing or bogus
      // mime degrades to the generic file card rather than an <img>/<video>
      // pointed at arbitrary bytes.
      mime: typeof e.mime === "string" ? e.mime : "application/octet-stream",
      thumbId: typeof e.thumbId === "string" ? e.thumbId : undefined,
      width: num(e.width),
      height: num(e.height),
      durationMs: num(e.durationMs),
    });
  }
  return out;
}

/** Finite numbers only — NaN/Infinity would poison layout maths and URLs. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The human-readable part of a message body, with any structured envelope
 * stripped.
 *
 * For surfaces that show message text but cannot (or should not) render an
 * attachment bubble — the desktop pinned-chat window is the case this exists
 * for, since it receives messages over IPC under `connect-src 'none'` and so
 * can never load an image. Without this it would print the raw body, sentinel
 * and JSON included:
 *
 *     🖼️ photo.jpg · 2.0 MB␟{"v":2,"kind":"media","items":[{"id":"018f…
 *
 * Mirrors what the server's own truncatePreview does for inbox rows, so the
 * same message reads the same way everywhere.
 */
export function readablePrefix(body: string): string {
  const i = body.indexOf(SENTINEL);
  return (i < 0 ? body : body.slice(0, i)).trim();
}

/**
 * True when a message is a media attachment.
 *
 * NOTE: this no longer gates the Forward action. It used to — forwarding cloned
 * the body verbatim, so the recipient got attachment ids scoped to a
 * conversation they were not in and every tile read "Not available to you".
 * The server now re-scopes them on forward (store.recloneAttachments), so media
 * forwards land correctly and the affordance is offered for every message.
 *
 * Used to hide the Forward affordance: forwarding clones the body verbatim, so
 * the recipient would receive attachment ids scoped to a conversation they are
 * not in, and every download would 403 into a broken card. Text and locations
 * forward fine — a location is self-contained.
 */
export function isMediaMessage(body: string): boolean {
  return parseChatEnvelope(body)?.kind === "media";
}

/** Convenience for the render path: the ids a message needs signed URLs for. */
export function attachmentIdsOf(env: ChatEnvelope | null): string[] {
  if (!env || env.kind !== "media") return [];
  const ids: string[] = [];
  for (const it of env.items) {
    ids.push(it.id);
    if (it.thumbId) ids.push(it.thumbId);
  }
  return ids;
}

export { prettySize };
