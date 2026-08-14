import { shell, type BrowserWindow, type WebContents } from "electron";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeExternalUrl } from "../shared/external-url";
import { applyContentProtection, watchCaptureKeys } from "./screenshot-guard";

/**
 * Per-window security hardening, applied to EVERY BrowserWindow the app opens.
 *
 * `contextIsolation` and `nodeIntegration: false` (set at construction) stop a
 * renderer reaching Node directly. They do not stop it *navigating* — and a
 * renderer that navigates to an attacker's page keeps the preload bridge and
 * whatever the OS grants this app. So navigation itself has to be constrained,
 * per window, and it is easy to apply to the main window and forget the three
 * sticky/chat variants. Hence one function called from every creation path.
 *
 * Three holes are closed here:
 *
 *   1. `setWindowOpenHandler` — target="_blank" and `window.open()`. Previously
 *      only the main window had a handler and it passed the URL straight to
 *      `shell.openExternal` with no validation, so renderer-controlled content
 *      could ask the OS to open ANY scheme. The sticky windows had no handler
 *      at all, so `window.open` there created a real child BrowserWindow with
 *      no CSP of its own.
 *   2. `will-navigate` — a top-level navigation away from our own content
 *      (an injected link, a redirect). The app is a SPA using HashRouter; it
 *      never legitimately navigates the top-level frame after load.
 *   3. `will-attach-webview` — `<webview>` is a full embedded browser and
 *      nothing in this app uses one. If a tag ever appears in our DOM it is not
 *      ours.
 *
 * Blocked URLs are logged rather than silently dropped: when a legitimate
 * feature trips this, the console line is the only clue about what happened.
 */

/** Open a URL in the user's browser, but only if it passes the allowlist. */
export function openExternalSafely(raw: unknown, context: string): void {
  const url = safeExternalUrl(raw);
  if (!url) {
    console.warn(`[security] refused to open external URL (${context}):`, raw);
    return;
  }
  void shell.openExternal(url);
}

/**
 * Directory holding our own renderer HTML. Packaged builds load from here via
 * `file://`; a file: URL outside it is not ours.
 */
const RENDERER_DIR = fileURLToPath(new URL("../renderer/", import.meta.url));

/**
 * Is this a page we ourselves loaded?
 *
 * Packaged builds load `file://` from the app bundle; dev loads the Vite server
 * on localhost. Anything else is somewhere we did not send the user.
 *
 * The file: branch is scoped to our own renderer directory rather than allowing
 * file: wholesale. A renderer that could navigate to any local path would be
 * reading the user's disk with our preload bridge still attached — the same
 * class of problem as letting it call openExternal on file:.
 */
function isOwnContent(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol === "file:") {
    // Compare decoded filesystem paths, not URL strings: %2e%2e and friends
    // survive a naive string prefix test but not fileURLToPath + startsWith.
    let path: string;
    try {
      path = fileURLToPath(parsed);
    } catch {
      return false;
    }
    return resolve(path).startsWith(resolve(RENDERER_DIR));
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && url.startsWith(devUrl)) return true;
  return false;
}

export function hardenWebContents(wc: WebContents, label: string): void {
  // 0. Capture-key interception. Lives here for the same reason as the rest:
  //    every window renders workspace content, and a guard applied per-creation
  //    -path is a guard someone forgets on the fourth one.
  watchCaptureKeys(wc, label);

  // 1. window.open / target="_blank" → the user's browser, never a child window.
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url, `${label}:window-open`);
    return { action: "deny" };
  });

  // 2. Top-level navigation away from our own content.
  wc.on("will-navigate", (e, url) => {
    if (isOwnContent(url)) return; // in-app reload / HMR
    e.preventDefault();
    console.warn(`[security] blocked navigation (${label}):`, url);
    // A blocked click was probably a real link the user meant to follow, so
    // honor the intent in the browser where it belongs. Non-https is dropped.
    openExternalSafely(url, `${label}:will-navigate`);
  });

  // 3. <webview> — unused by this app, so its appearance is not ours.
  wc.on("will-attach-webview", (e) => {
    e.preventDefault();
    console.warn(`[security] blocked <webview> attach (${label})`);
  });
}

/** Convenience wrapper for a whole window. */
export function hardenWindow(win: BrowserWindow, label: string): void {
  hardenWebContents(win.webContents, label);
  // Exclude the window from OS screen capture. Honoured on Windows and macOS;
  // a no-op on Linux/X11 — see screenshot-guard.ts for what that means.
  applyContentProtection(win, label);
}
