/**
 * Best-effort media hand-off for a WhatsApp forward.
 *
 * wa.me's click-to-chat form (waLink.ts) accepts ONLY a `text` query param —
 * WhatsApp has never supported attaching a file through that URL, on any
 * platform, so there is no version of "put the photo in the wa.me link" that
 * is honest. Putting an attachment id or a signed download URL in there
 * instead would be worse: it would either mean nothing to WhatsApp (an id) or
 * hand a fetchable link to whoever ends up reading the recipient's chat (a
 * URL) — see forward_attachments.go's re-scoping rationale for why an
 * attachment id is never assumed safe to hand to a party outside its scope.
 *
 * The one REAL client-side mechanism a browser/Electron runtime has for
 * handing a *file* (not a link) to another app is the Web Share API's file
 * form, `navigator.share({ files })`. It opens the OS's own share sheet — not
 * a WhatsApp-specific channel, and like wa.me itself it hands off and never
 * reports back whether the user actually picked WhatsApp or pressed Send.
 * Support is inconsistent: strong on mobile Safari/Chrome, present on some
 * desktop Chromium builds, and — as of the Electron version this app ships —
 * NOT implemented in Electron's renderer at all, so this path is expected to
 * fall through to the download fallback on desktop today. Every call site
 * feature-detects at runtime rather than special-casing "is this Electron",
 * so a future Electron release that adds support starts working with no
 * change here.
 *
 * Where Web Share is unavailable or refuses the files, the only honest
 * fallback is downloading them for the user to attach by hand in WhatsApp —
 * never a claim that they reached WhatsApp automatically.
 */
import i18n from "../i18n";

/** The outcomes a caller renders. Never thrown — every failure mode the two
 *  network calls (mint a link, fetch the bytes) or the Share API can produce
 *  is folded into one of these, so "what happened" is always a value, not an
 *  exception a UI layer has to remember to catch. */
export type MediaHandoffOutcome =
  | { kind: "shared" }
  | { kind: "share-cancelled" }
  | { kind: "downloaded"; count: number }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

type ShareCapableNavigator = Pick<Navigator, "share" | "canShare">;

/**
 * Feature-detects the Web Share API's file form. Pure and given the
 * navigator-like object explicitly, so it is cheaply testable without
 * stubbing the real global per test case.
 */
export function canShareFiles(nav: ShareCapableNavigator | undefined, files: File[]): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files });
  } catch {
    // A browser's canShare can throw on an unexpected input shape rather than
    // returning false; treated the same as "not supported" either way.
    return false;
  }
}

/**
 * Hands `files` to WhatsApp via the OS share sheet when the runtime
 * genuinely supports it; otherwise calls `download` for each file so the user
 * can attach them by hand. `text` (the message's readable caption, if any) is
 * passed to `navigator.share` alongside the files — WhatsApp prefills it the
 * same way a wa.me link does when the OS routes the share there.
 */
export async function handoffMediaFiles(
  files: File[],
  opts: { text?: string; nav?: ShareCapableNavigator; download: (file: File) => void },
): Promise<MediaHandoffOutcome> {
  if (files.length === 0) return { kind: "unsupported" };
  const nav = opts.nav ?? (typeof navigator === "undefined" ? undefined : navigator);

  if (canShareFiles(nav, files)) {
    try {
      await nav!.share({ files, text: opts.text });
      return { kind: "shared" };
    } catch (err) {
      // The user dismissed the OS share sheet without picking anything — a
      // normal outcome, not a failure to surface as an error.
      if (err instanceof DOMException && err.name === "AbortError") {
        return { kind: "share-cancelled" };
      }
      return {
        kind: "error",
        message: err instanceof Error ? err.message : i18n.t("chatThread:whatsAppForward.shareFailedGeneric"),
      };
    }
  }

  for (const file of files) opts.download(file);
  return { kind: "downloaded", count: files.length };
}
