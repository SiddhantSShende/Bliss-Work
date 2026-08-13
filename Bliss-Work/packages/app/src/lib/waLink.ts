/**
 * Building a WhatsApp deep link, and the phone normalization it needs.
 *
 * The link is plain https with no credentials, which is what lets it pass the
 * desktop app's `safeExternalUrl` allowlist and hand off to the system browser
 * via `shell.openExternal` — the same property mapsLink.ts relies on.
 */

import { parseChatEnvelope, readablePrefix } from "./chatEnvelope";
import { mapsLink } from "./mapsLink";

/**
 * E.164 caps a subscriber number at 15 digits including the country code. The
 * lower bound of 8 is a judgement call: the shortest real E.164 numbers sit
 * around there, and anything shorter is a local number typed without a country
 * code — which would deep-link to a plausible stranger rather than fail.
 *
 * These bounds and the normalization below MUST match
 * services/messaging-svc/internal/api/phone.go. The shared test vectors in
 * waLink.test.ts and phone_test.go are what stop the two drifting.
 */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * The desktop app refuses any URL longer than 2048 characters
 * (apps/desktop/src/shared/external-url.ts) and `openExternalSafely` only logs a
 * warning — so an over-long link makes the button do *nothing at all*, with no
 * user-visible error. encodeURIComponent can triple the length of non-ASCII
 * text, so this is reachable with a few hundred characters of emoji. Budget set
 * below the hard limit to leave room for the phone number and the scheme.
 */
export const WA_URL_MAX = 1900;

/**
 * Normalize raw input to the bare digits wa.me wants, or null if we will not
 * guess. Strips everything non-numeric (disposing of '+', spaces, parens, dots
 * and dashes in one pass), then leading zeroes — which covers both a national
 * trunk '0' and the '00' international prefix, since neither exists in E.164.
 *
 * No country is inferred. Guessing one would silently produce a valid-looking
 * link to the wrong person, which is worse than making the user type the code.
 */
export function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  return digits;
}

/**
 * Display form of a normalized number: "15550192834" → "+15550192834".
 *
 * Deliberately ungrouped. Readable grouping needs the country code's length,
 * which is exactly the thing we refuse to guess — and a grouping split in the
 * wrong place ("+15 550 192 834") reads as a different number, which defeats
 * the point of showing it back for the user to check.
 */
export function formatE164(digits: string): string {
  return `+${digits}`;
}

/**
 * The text to prefill in WhatsApp for a message body.
 *
 * A body is not always plain text: attachments and shared locations carry a
 * U+001F sentinel followed by JSON (chatEnvelope.ts). Sending it verbatim would
 * dump `📍 Office␟{"v":2,"kind":"location",…}` into someone's WhatsApp, so the
 * readable prefix is used instead — and for a location the coordinates are
 * turned into a maps link, which is the part the recipient can actually act on.
 *
 * Media messages never reach here: ChatThread hides the forward affordance for
 * them, because their attachment ids are scoped to a conversation the recipient
 * is not in.
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
 * Build https://wa.me/<digits>?text=…, truncating the text until the whole URL
 * fits WA_URL_MAX. Truncation walks back by code point (via the spread, which
 * iterates runes) so it can never cut a multi-byte character in half and leave
 * a U+FFFD in someone's message.
 */
export function waLink(digits: string, text: string): string {
  const base = `https://wa.me/${digits}?text=`;
  const build = (t: string) => base + encodeURIComponent(t);

  let url = build(text);
  if (url.length <= WA_URL_MAX) return url;

  const runes = [...text];
  // Binary search the longest prefix that fits — a linear walk-back would be
  // O(n) full re-encodes on a long body.
  let lo = 0;
  let hi = runes.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(runes.slice(0, mid).join("") + "…").length <= WA_URL_MAX) lo = mid;
    else hi = mid - 1;
  }
  url = build(runes.slice(0, lo).join("") + "…");
  return url;
}
