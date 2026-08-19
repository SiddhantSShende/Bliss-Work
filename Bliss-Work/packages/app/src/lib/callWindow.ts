/**
 * Opening a meeting in its own browser tab.
 *
 * ── Why a tab at all ─────────────────────────────────────────────────────────
 * A meeting is not a page you visit, it is something you are in WHILE you carry
 * on working — reading the thread the meeting is about, opening the task
 * someone just mentioned. Rendering the room inside the app made those the same
 * surface: navigating away hung up, and staying meant the rest of BlissWork was
 * unreachable for the length of the call. Its own tab is what makes the meeting
 * and the work independent.
 *
 * ── Why this is a function and not a link ────────────────────────────────────
 * Because it can fail, and the caller has to know. A pop-up blocker refusing
 * the window is normal and silent, and a Join button that does nothing at all
 * is the worst possible outcome — so this reports what happened and the caller
 * falls back to opening the room in place.
 */

/** Just the platform facts this needs, so a test can pass an object literal. */
export interface CallWindowConfig {
  kind: "web" | "electron";
  router: "browser" | "hash";
}

/** The in-app path of the meeting room. */
export function callPath(callId: string): string {
  return `/call/${encodeURIComponent(callId)}`;
}

/**
 * Open (or focus) the tab holding this meeting.
 *
 * Returns false when there is no tab to open — the desktop app, where a second
 * browser tab is not a thing that exists and `window.open` would hand the URL
 * to the system browser, signed out; or a blocked pop-up. Either way the caller
 * shows the room where it stands instead.
 */
export function openCallTab(callId: string, config: CallWindowConfig): boolean {
  if (config.kind !== "web" || typeof window === "undefined") return false;
  const path = callPath(callId);
  const url =
    config.router === "hash"
      ? `${window.location.origin}${window.location.pathname}#${path}`
      : `${window.location.origin}${path}`;
  // Named after the call, so joining the same meeting twice focuses the tab
  // that is already in it rather than opening a second copy of the room — two
  // tabs in one call is two cameras, two seats on the roster, and an echo.
  const opened = window.open(url, `bliss-call-${callId}`);
  if (!opened) return false;
  // Not "noopener" in the feature string: that form returns null, so a blocked
  // pop-up would be indistinguishable from a successful one. Severing the link
  // afterwards gets the same protection with an answer.
  try {
    opened.opener = null;
    opened.focus();
  } catch {
    // Cross-origin or a window that vanished between opening and focusing.
    // Neither changes the answer: the room was opened.
  }
  return true;
}
