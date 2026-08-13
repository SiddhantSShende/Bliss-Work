/**
 * The single rule for "may this URL be handed to the operating system?".
 *
 * `shell.openExternal` gives whatever it is passed to the OS, which hands it to
 * whichever application has registered that scheme. That is a much bigger gun
 * than it looks: on Windows a registered handler can be a local helper that
 * takes arguments (`ms-msdt:`, `search-ms:`, `ms-officecmd:` — all of which have
 * carried RCE chains), and `file://` opens local content outside the sandbox.
 *
 * So the app must never call `shell.openExternal` directly. Everything that
 * reaches the OS goes through `safeExternalUrl` first, and there are two ways
 * in — an explicit IPC from the renderer (OAuth) and `setWindowOpenHandler`
 * (target="_blank", `window.open`). Both are renderer-controlled, so both are
 * treated as hostile input.
 *
 * The check is a parse, not a prefix test. `"https://x"` passes a `startsWith`
 * check and so does `"https:/\/\evil"`-style trickery in some parsers; parsing
 * and then reading `.protocol` is what URL semantics actually are.
 *
 * This module is dependency-free (no electron import) so it is unit-testable
 * and so both bundles can include it.
 */

/**
 * Schemes the app is willing to open in the user's default applications.
 *
 * `https` only. Not `http` — every endpoint this app talks to is TLS, so a
 * plain-http link is either a downgrade or an attacker's. Not `mailto`: it
 * looks harmless, but nothing in the UI needs it, and the moment it's allowed
 * the allowlist stops being "one obviously safe scheme".
 */
const ALLOWED_PROTOCOLS = new Set(["https:"]);

/**
 * Normalize a candidate URL, or return null if it must not be opened.
 *
 * Returns the re-serialized URL rather than the input so that whatever reaches
 * the OS is exactly what was validated — no room for a difference between the
 * string we checked and the string we passed on.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Guard against absurd input before doing work; some platform handlers have
  // fixed-size buffers and a multi-megabyte "URL" is never legitimate.
  if (raw.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // relative, malformed, or scheme-less — never opened
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

  // A URL with embedded credentials ("https://user:pass@host") renders
  // confusingly in browsers and is a classic phishing shape. Nothing in this
  // app produces one.
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
}
