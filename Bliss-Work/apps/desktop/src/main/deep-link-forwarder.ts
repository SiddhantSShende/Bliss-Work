import type { BrowserWindow } from "electron";
import { parseDeepLink } from "../shared/deeplink";

/**
 * Forward a taskboard:// deep link to `win`, waiting for its current page
 * load to finish first if it has not already.
 *
 * Closes the open-url (macOS) / second-instance (Windows/Linux, app already
 * running) race in main/index.ts: both call focusMain(), which only
 * constructs/shows/focuses the window and returns synchronously, then used to
 * forward the link immediately. renderer/main.tsx registers its
 * deeplink:meeting/deeplink:invite listener at module top level, which only
 * happens once the window's page has actually loaded — sending before then
 * reaches `webContents.send` with nobody listening, and the link is silently
 * lost for good (it does not buffer). This is the same class of bug the argv
 * cold-start path elsewhere in index.ts already guards against by waiting on
 * `did-finish-load` up front.
 *
 * `webContents.isLoading()` is Electron's own authoritative answer to
 * whether that load has finished, so — unlike the sticky note's own
 * did-finish-load race, closed instead by the sticky:ready handshake in
 * sticky-manager.ts — no renderer-side handshake is needed here: the
 * listener is registered synchronously at module load, before the page's
 * `load` event (and therefore did-finish-load) can fire, so `isLoading()`
 * alone tells us whether it is safe to send yet.
 *
 * `send` does the actual parse-and-dispatch (main/index.ts's own
 * `forwardDeepLink`, reused rather than duplicated here) — this function's
 * only job is deciding WHEN to call it.
 */
export function forwardDeepLinkWhenReady(
  win: BrowserWindow,
  url: string | undefined,
  send: (url: string | undefined) => void,
): void {
  // Guard here too (not just inside `send`), so a plain relaunch with no
  // link in argv never wires a needless did-finish-load listener.
  if (!parseDeepLink(url)) return;
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => send(url));
  } else {
    send(url);
  }
}
