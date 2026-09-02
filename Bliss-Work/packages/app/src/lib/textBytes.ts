/**
 * UTF-8 byte length — what a server-side `len()` on a Go string actually
 * counts, and what every byte-capped field in this app (meeting chat, notes)
 * has to agree with.
 *
 * JS string `.length` counts UTF-16 code units, not bytes. For Latin text the
 * two happen to match, which is exactly what makes the mismatch invisible in
 * testing with an English sentence and real for a CJK one: a Japanese or
 * Chinese character is one UTF-16 code unit but three UTF-8 bytes, so a
 * message that reads as "under the limit" by `.length` can be three times
 * that many bytes on the wire — comfortably over a cap the server enforces in
 * bytes. Measuring the same unit the server checks is what keeps "looks fine
 * here" and "accepted there" the same answer.
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Trim `s` to at most `maxBytes` UTF-8 bytes, without splitting a codepoint —
 * `for...of` on a string walks by codepoint, so a surrogate pair (an emoji,
 * for one) is never cut in half and left as an unpaired surrogate.
 *
 * A no-op, returning `s` unchanged, when it already fits — the common case,
 * and worth skipping the codepoint walk for.
 */
export function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = utf8ByteLength(ch);
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}
