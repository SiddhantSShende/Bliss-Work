/**
 * Cross-platform "save this Blob to a file" helper.
 *
 * Uses the canonical browser download (`<a download>` + object URL). This works
 * under the app's `default-src 'self'` CSP on BOTH the web app and the Electron
 * renderer — a `download` anchor triggers a browser/session download, not a
 * fetch/navigation, so no CSP fetch-directive gates it. The WebRTC file-receive
 * path already ships this exact mechanism (fileTransfer.tsx), proving it works
 * inside the packaged desktop app (relevant for MS-Store certification: no CDN,
 * no wasm, no eval).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a delay so the download has time to start reading the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The EXPLICIT download of a chat/channel attachment — a file's 3-dot menu →
 * Download, the only deliberate download path (a normal click OPENS the file and
 * never goes through here).
 *
 * `url` is the viewer's own signed media URL (useAttachmentLinks). The server
 * turns `?dl=1` into `Content-Disposition: attachment` — see media.ServeHeaders —
 * and THAT is what makes the browser save rather than show it: the `download`
 * attribute alone is ignored for a cross-origin URL (the desktop renderer's
 * app:// origin, or a separate API host), and it also carries the real filename
 * for the same-origin case. Nothing is fetched or buffered here, so the bytes
 * stream straight to disk and authorization stays the URL's own.
 */
export function downloadAttachment(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = `${url}${url.includes("?") ? "&" : "?"}dl=1`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
