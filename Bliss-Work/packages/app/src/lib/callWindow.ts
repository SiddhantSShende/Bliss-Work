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

/** Just the platform facts this needs, so a test can pass an object literal.
 *  `kind` mirrors PlatformConfig's own union (including "mobile") purely so a
 *  full PlatformConfig is structurally assignable here — openCallTab's own
 *  `kind !== "web"` check already treats every non-web platform the same
 *  way, and a React Native app has no browser tab to open in the first
 *  place (Meetings gets its own native screen in that phase), so this is
 *  never actually called with `kind: "mobile"` in practice. */
export interface CallWindowConfig {
  kind: "web" | "electron" | "mobile";
  router: "browser" | "hash";
}

/**
 * The flag `openCallTab` puts on the URL so the tab it opens can recognise
 * itself later.
 *
 * The tab cannot work this out on its own. `window.opener` is severed below —
 * deliberately — and even if it were not, the opener goes null the moment the
 * tab that launched the meeting is closed, which is exactly when someone is
 * most likely to be finishing up in the meeting tab. A flag the opener writes
 * INTO the URL survives both.
 */
export const OPENED_BY_APP_PARAM = "opened";

/** Where the "this tab exists to hold a meeting" mark lives. Per TAB, which is
 *  the whole point: sessionStorage is not shared with the tab that opened it. */
const MEETING_TAB_KEY = "tb.meeting-tab.v1";

/** The in-app path of the meeting room. */
export function callPath(callId: string): string {
  return `/call/${encodeURIComponent(callId)}`;
}

/**
 * Record that THIS tab was opened to hold this meeting.
 *
 * Written to sessionStorage rather than kept in React state because the mark
 * has to outlive the meeting route: the tab can browse the rest of BlissWork
 * with the meeting running in the floating window, and it is still a tab whose
 * reason to exist is the meeting.
 */
export function rememberMeetingTab(callId: string): void {
  try {
    window.sessionStorage.setItem(MEETING_TAB_KEY, callId);
  } catch {
    // Private browsing, or storage disabled. The tab simply falls back to
    // navigating instead of closing — worse, but not broken.
  }
}

/** Was this tab opened by BlissWork to hold a meeting? */
export function isMeetingTab(): boolean {
  try {
    return !!window.sessionStorage.getItem(MEETING_TAB_KEY);
  } catch {
    return false;
  }
}

/** Forget the mark — the meeting is over, so the tab is just a tab again. */
export function forgetMeetingTab(): void {
  try {
    window.sessionStorage.removeItem(MEETING_TAB_KEY);
  } catch {
    // Nothing to do: an unreadable store is an unwritable one.
  }
}

/** How long to wait before deciding the browser refused to close us. */
const CLOSE_REFUSED_MS = 150;

/**
 * Close the meeting tab, or fall back to going somewhere sensible.
 *
 * `window.close()` is a REQUEST, not a guarantee — the browser refuses it for a
 * tab the script did not open, which is precisely the bookmarked-or-reloaded
 * case. So it is attempted and then checked, rather than trusted: if we are
 * still here a moment later, the tab was never ours to close and the caller's
 * fallback runs instead of leaving a dead page on screen.
 */
export function closeMeetingTab(fallback: () => void): void {
  if (!isMeetingTab()) {
    fallback();
    return;
  }
  forgetMeetingTab();
  window.close();
  window.setTimeout(() => {
    if (!window.closed) fallback();
  }, CLOSE_REFUSED_MS);
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
  // The flag rides in the URL because it is the only channel to a tab that does
  // not exist yet — see OPENED_BY_APP_PARAM. It stays on the address afterwards
  // on purpose: a reload of the meeting tab has to arrive at the same answer.
  const path = `${callPath(callId)}?${OPENED_BY_APP_PARAM}=1`;
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
  //
  // Because of this line the opened tab CANNOT use `window.opener` to recognise
  // itself, which is why OPENED_BY_APP_PARAM exists. Reading `window.opener`
  // over there is always false, and a meeting tab that believed it therefore
  // navigated to /app instead of closing — leaving a second copy of BlissWork
  // behind every time a meeting ended.
  try {
    opened.opener = null;
    opened.focus();
  } catch {
    // Cross-origin or a window that vanished between opening and focusing.
    // Neither changes the answer: the room was opened.
  }
  return true;
}
