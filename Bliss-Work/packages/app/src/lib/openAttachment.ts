import { toast } from "sonner";
import type { PlatformConfig } from "../platform";
import { canPreviewDocInApp } from "./chatEnvelope";
import i18n from "../i18n";

/**
 * Opening an attachment the app cannot show itself. Shared by chat and channel
 * files so they take the same roads as an Email attachment's "Open", instead of
 * a second copy of them:
 *
 *   desktop  → `config.openAttachment` (Electron only, see platform.ts): the main
 *              process fetches the signed URL, saves it and hands it to the OS's
 *              default app, e.g. PowerPoint for a .pptx.
 *   web      → the browser is pointed at the signed URL in a new tab, exactly as
 *              the email card's `target="_blank"` link does. The app fetches and
 *              saves nothing; what the browser then does is the server's call
 *              (Content-Disposition — see media.ServeAs), so an Office file ends
 *              in the browser's own download handling and an audio file plays.
 *   other    → neither: the in-app Lightbox, which says it cannot be previewed.
 *
 * Authorization is the URL either way: it is minted by `useAttachmentLinks` for
 * THIS viewer, and the server re-checks their access on every fetch.
 */

/** Types the app draws itself, in the Lightbox. Everything else has no in-app view.
 *  The one place that says so: chat, channel and mail attachments all ask it. */
export function rendersInApp(mime: string): boolean {
  return canPreviewDocInApp(mime) || mime.startsWith("image/") || mime.startsWith("video/");
}

type Host = Pick<PlatformConfig, "kind" | "openAttachment">;

/**
 * True when a click on a file of this type should go to the native app:
 * desktop only, and never for images, video, PDF or plain text, which keep
 * opening in the Lightbox.
 */
export function opensNatively(config: Host, mime: string): boolean {
  return !!config.openAttachment && !rendersInApp(mime);
}

/**
 * True when a click should point the browser at the file: the WEB app only, and
 * never for a type with an in-app view. Keyed on `kind === "web"` rather than on
 * the absence of `openAttachment`, so the desktop's other windows and mobile —
 * neither of which has it — keep the Lightbox.
 */
export function opensInBrowser(config: Host, mime: string): boolean {
  return config.kind === "web" && !rendersInApp(mime);
}

/** Whether this host takes non-previewable files out of the app at all. */
export function hasOutsideOpen(config: Host): boolean {
  return !!config.openAttachment || config.kind === "web";
}

/** Hand the file at `url` to the OS, telling the user if it could not be opened.
 *  Call only when `config.openAttachment` exists (see `opensNatively`). */
export async function openAttachmentNatively(
  config: Pick<PlatformConfig, "openAttachment">,
  url: string,
  filename: string,
): Promise<void> {
  const result = await config.openAttachment!(url, filename);
  if (!result.ok) toast.error(i18n.t("common:attachment.couldNotOpen", { filename }), { description: result.error });
}

/**
 * Open a file the app has no viewer for, the way this host does it. Returns
 * false — and does nothing — when the host has no such way (or the type has an
 * in-app view), so the caller falls through to the Lightbox.
 *
 * Must run inside the click handler itself: the browser only lets a tab open
 * from a user gesture, so nothing may be awaited before this.
 */
export function openOutsideApp(config: Host, mime: string, url: string, filename: string): boolean {
  if (opensNatively(config, mime)) {
    void openAttachmentNatively(config, url, filename);
    return true;
  }
  if (opensInBrowser(config, mime)) {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }
  return false;
}
