/**
 * Building the WhatsApp deep link this app forwards with.
 *
 * The link is plain https with no credentials, which is what lets it pass the
 * desktop app's `safeExternalUrl` allowlist and hand off to the system browser
 * via `shell.openExternal` — the same property mapsLink.ts relies on.
 *
 * There is exactly ONE link form here, and it carries no recipient. Capturing a
 * phone number in-app used to be a second path; it is gone deliberately, and
 * waShareLink explains what that costs and why it is still the right trade.
 */

import { parseChatEnvelope, readablePrefix } from "./chatEnvelope";
import { mapsLink } from "./mapsLink";

/**
 * The desktop app refuses any URL longer than 2048 characters
 * (apps/desktop/src/shared/external-url.ts) and `openExternalSafely` only logs a
 * warning — so an over-long link makes the button do *nothing at all*, with no
 * user-visible error. encodeURIComponent can triple the length of non-ASCII
 * text, so this is reachable with a few hundred characters of emoji. Budget set
 * below the hard limit to leave room for the scheme and query prefix.
 */
export const WA_URL_MAX = 1900;

/**
 * The text to prefill in WhatsApp for a message body.
 *
 * A body is not always plain text: attachments and shared locations carry a
 * U+001F sentinel followed by JSON (chatEnvelope.ts). Sending it verbatim would
 * dump `📍 Office␟{"v":2,"kind":"location",…}` into someone's WhatsApp, so the
 * readable prefix is used instead — and for a location the coordinates are
 * turned into a maps link, which is the part the recipient can actually act on.
 *
 * A media message's readable prefix is its auto description ("🖼️ photo.jpg ·
 * 2.0 MB"), never the attachment itself — wa.me's `text` param is the only
 * thing this link can carry, on every platform, so there is no version of
 * "attach the photo" that belongs in a URL. ChatThread additionally fires a
 * best-effort media hand-off (useWhatsAppMediaForward) on the same click, via
 * the OS share sheet where the runtime supports it — see that module for what
 * it can and cannot promise. Neither path puts an attachment id or a signed
 * download URL in front of WhatsApp or the eventual recipient.
 */
export function waForwardText(body: string): string {
  const text = readablePrefix(body);
  const env = parseChatEnvelope(body);
  if (env?.kind === "location") {
    return `${text}\n${mapsLink(env.lat, env.lng)}`.trim();
  }
  return text;
}

/**
 * `https://wa.me/?text=…` — WhatsApp's documented share form, with NO recipient.
 *
 * That absence is the feature. Instead of this app capturing a phone number and
 * deep-linking straight to one chat, WhatsApp opens its OWN contact chooser and
 * the user picks from the contacts they actually message. It works identically
 * on desktop, iOS, Android and the Electron renderer, needs no permission
 * prompt, and asks nobody to retype a number they already have.
 *
 * The cost is that we never learn who was chosen — WhatsApp does not tell us,
 * and there is no callback of any kind. So a forward recorded through this link
 * has NO recipient, and every surface has to say "opened WhatsApp to forward
 * this" and stop there. Anything more specific would be invention.
 */
export function waShareLink(text: string): string {
  const base = "https://wa.me/?text=";
  const build = (t: string) => base + encodeURIComponent(t);

  const url = build(text);
  if (url.length <= WA_URL_MAX) return url;

  const runes = [...text];
  // Binary search the longest prefix that fits — a linear walk-back would be
  // O(n) full re-encodes on a long body. Slicing by code point (the spread
  // iterates runes) can never cut a multi-byte character in half and leave a
  // U+FFFD in someone's message.
  let lo = 0;
  let hi = runes.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(runes.slice(0, mid).join("") + "…").length <= WA_URL_MAX) lo = mid;
    else hi = mid - 1;
  }
  return build(runes.slice(0, lo).join("") + "…");
}
