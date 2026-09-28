/**
 * The one clipboard-write path every Copy button in the app should use.
 *
 * `navigator.clipboard.writeText()` works unmodified in both the web app and
 * the Electron renderer — Electron's own docs recommend calling it directly
 * from the renderer rather than routing a privileged bridge through main, and
 * there is nothing for a preload API to add here: writing to the clipboard is
 * not a Node/filesystem-grade privilege, it is a browser permission the host
 * grants or denies (see apps/desktop/src/main/index.ts's
 * "clipboard-sanitized-write" allowlist entry, and screenshot-guard.ts for
 * why content-protection is a separate, unrelated control).
 *
 * The execCommand fallback only matters where the Clipboard API is entirely
 * absent (an insecure origin, a very old WebView) or a write is genuinely
 * refused (e.g. the document briefly losing focus mid-click) — the same
 * fallback BackupCodesView used to implement locally, generalized so every
 * Copy button gets it for free.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand fallback below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
