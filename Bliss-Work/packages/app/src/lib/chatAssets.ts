/**
 * The media, documents and links a conversation has accumulated.
 *
 * All three are already in the messages the thread has loaded — attachments as
 * a structured envelope on the body (chatEnvelope), links as plain text inside
 * it — so this reads them back out rather than asking the server for a second
 * view of the same data. There is no endpoint that could answer it anyway: the
 * bodies are encrypted at rest, which is exactly why the envelope is parsed
 * client-side everywhere else too.
 *
 * The consequence, and it is stated in the UI rather than hidden: this covers
 * the history that has been loaded. Pulling in older messages widens it.
 */
import { parseChatEnvelope, readablePrefix, type MediaItem } from "./chatEnvelope";

export interface AssetMessage {
  id: string;
  body: string;
  /** ISO timestamp. Absent on an optimistic message that has not landed yet. */
  at?: string;
  senderName?: string;
  /** Deleted for everyone: the body is a tombstone, and whatever it used to
   *  carry is gone. */
  deletedForAll?: boolean;
}

interface Provenance {
  messageId: string;
  at?: string;
  senderName?: string;
}

export interface MediaAsset extends Provenance {
  item: MediaItem;
}

export interface LinkAsset extends Provenance {
  url: string;
}

export interface ChatAssets {
  /** Photos and video — the things worth showing as a grid of thumbnails. */
  media: MediaAsset[];
  /** Every other attachment: PDFs, spreadsheets, archives, audio. */
  docs: MediaAsset[];
  links: LinkAsset[];
}

/**
 * Absolute http(s) URLs only.
 *
 * Deliberately not a general URL matcher: a bare "acme.com" in a sentence is
 * text, and turning it into a link the reader can click is a decision the
 * sender did not make. Trailing punctuation is trimmed below because "see
 * https://acme.com." ends a sentence, it does not name a host called "com.".
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** True for the attachments that belong in the Media tab rather than Docs. */
function isVisualMedia(item: MediaItem): boolean {
  return item.mime.startsWith("image/") || item.mime.startsWith("video/");
}

/**
 * Split the loaded messages into the three tabs, newest first.
 *
 * Newest-first because that is the order the question is asked in — "what was
 * that file someone sent" is almost always about a recent one — and it is the
 * opposite of the thread's own order, so the caller must not rely on the input
 * ordering being preserved.
 */
export function collectChatAssets(messages: readonly AssetMessage[]): ChatAssets {
  const assets: ChatAssets = { media: [], docs: [], links: [] };

  // Reverse-iterate rather than sort: the thread is already in send order, and
  // a comparator over a nullable `at` would have to invent an answer for the
  // optimistic messages that have no timestamp yet.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.deletedForAll) continue;
    const provenance: Provenance = { messageId: m.id, at: m.at, senderName: m.senderName };

    const envelope = parseChatEnvelope(m.body);
    if (envelope?.kind === "media") {
      for (const item of envelope.items) {
        (isVisualMedia(item) ? assets.media : assets.docs).push({ ...provenance, item });
      }
      // A media message's readable part is a generated summary ("🖼️ 3 photos"),
      // never something the sender typed, so there is no link in it to find.
      continue;
    }

    for (const url of readablePrefix(m.body).match(URL_RE) ?? []) {
      assets.links.push({ ...provenance, url: url.replace(TRAILING_PUNCTUATION, "") });
    }
  }

  return assets;
}
