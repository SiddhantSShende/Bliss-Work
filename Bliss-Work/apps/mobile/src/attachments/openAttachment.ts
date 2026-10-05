import { attachmentViewer } from './attachmentViewer';

/**
 * `chatEnvelope.ts`'s own `canPreviewDocInApp` also says yes to
 * `application/pdf` — true on web, where the doc preview is a real `<iframe>`
 * (the browser's own PDF renderer runs inside it). Mobile's doc preview is a
 * `react-native-webview` instead, and the bundled Android System WebView has
 * no PDF renderer of its own: pointed at a PDF url it silently starts an OS
 * download and leaves the in-app viewer blank, rather than ever showing an
 * error — confirmed on-device, not a theoretical gap. There is no in-app fix
 * that doesn't either hand the signed url to a third-party viewer (Google
 * Docs Viewer et al., which this app's signed urls must not be) or pull in a
 * new native PDF renderer; until one of those is worth doing, a PDF here
 * takes the same file-details-with-external-open path as a ZIP. Plain text
 * still renders fine in a bare WebView, so that one stays in-app.
 */
function canPreviewDocInApp(mime: string): boolean {
  return mime === 'text/plain';
}

export interface OpenableAttachment {
  name: string;
  size: number;
  mime: string;
}

/**
 * Classify one attachment and open the right in-app viewer for it — the
 * single decision point every attachment tap in the app goes through
 * (message bubbles, the Media/Links/Docs modal, the channel Files screen),
 * so a PDF opens the same way no matter which screen it was tapped from.
 *
 *  - image/* → the pinch-zoom lightbox.
 *  - a type mobile's WebView can actually render from our own signed URL
 *    (plain text only — see canPreviewDocInApp above) → the in-app document
 *    preview.
 *  - anything else → the file-details sheet, with an explicit external-open
 *    action. Never an automatic Linking.openURL — see the sheet itself.
 *
 * `url` missing (still resolving, or not available to this viewer) opens the
 * details sheet too, so the user sees why rather than nothing happening.
 */
export function openAttachment(item: OpenableAttachment, url: string | undefined): void {
  if (item.mime.startsWith('image/') && url) {
    attachmentViewer.open({ kind: 'image', images: [{ uri: url, name: item.name }], index: 0 });
    return;
  }
  if (url && canPreviewDocInApp(item.mime)) {
    attachmentViewer.open({ kind: 'doc', url, name: item.name, mime: item.mime });
    return;
  }
  attachmentViewer.open({ kind: 'details', name: item.name, sizeBytes: item.size, mime: item.mime, url });
}

/**
 * The message bubble's image/video grid: tapping one image opens ALL the
 * visual attachments in that SAME message as one swipeable set (like a real
 * photo viewer), starting on the one tapped — not just the single image.
 * A video (no in-app player exists — out of scope here) or an image whose
 * URL hasn't resolved yet falls through to the single-attachment details
 * sheet instead, same as any other unpreviewable attachment.
 */
export function openImageGroup<T extends OpenableAttachment>(
  visuals: readonly T[],
  urlOf: (item: T) => string | undefined,
  tapped: T,
): void {
  const images = visuals
    .filter((i) => i.mime.startsWith('image/'))
    .map((i) => ({ item: i, uri: urlOf(i) }))
    .filter((x): x is { item: T; uri: string } => !!x.uri);
  const index = images.findIndex((x) => x.item === tapped);
  if (index >= 0) {
    attachmentViewer.open({
      kind: 'image',
      images: images.map((x) => ({ uri: x.uri, name: x.item.name })),
      index,
    });
    return;
  }
  openAttachment(tapped, urlOf(tapped));
}
