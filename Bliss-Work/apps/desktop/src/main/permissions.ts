import { isOwnContent } from "./harden";

/**
 * Who a permission request comes from.
 *
 * The session-wide permission handlers used to answer from the permission name
 * alone, so ANY frame in ANY window was granted camera/mic/geolocation/clipboard
 * — including a `blob:` or `srcdoc` preview frame inside our own page. They now
 * also require the requesting frame to be our own content (harden.ts's
 * isOwnContent, the same test navigation uses). Call, sticky and meeting windows
 * all load our own renderer files, so they are unaffected.
 *
 * Shapes verified against real Electron: a request always carries
 * `details.requestingUrl` (the page's file: URL with its query; `about:srcdoc` or
 * `blob:file:///…` for a sub-frame). A permission CHECK sometimes carries an
 * empty one while the top frame is still committing, in which case the top
 * frame's own URL stands in.
 */
export interface PermissionDetails {
  requestingUrl?: string;
  isMainFrame?: boolean;
  embeddingOrigin?: string;
}

/** The URL of the frame asking, or "" when it cannot be established. */
export function requesterUrl(details: PermissionDetails | undefined, webContentsUrl: string | undefined): string {
  if (details?.requestingUrl) return details.requestingUrl;
  // No URL on a sub-frame means no way to tell who it is: refuse.
  if (details?.isMainFrame === false) return "";
  return webContentsUrl || details?.embeddingOrigin || "";
}

export function isPermissionGranted(allowed: ReadonlySet<string>, permission: string, url: string): boolean {
  return allowed.has(permission) && url !== "" && isOwnContent(url);
}
