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
