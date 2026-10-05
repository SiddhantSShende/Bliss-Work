import { parseDeepLink } from "../shared/deeplink";

/**
 * macOS's entry point for a `taskboard://` link: the `open-url` event.
 *
 * When the link is what LAUNCHES the app, macOS fires `open-url` before
 * `app.whenReady()` — before `bootstrap()` has created any window. The handler
 * used to call `focusMain()` unconditionally, which builds a BrowserWindow, and
 * Electron refuses to before ready; the link was lost, and macOS never puts a
 * launch link in argv, so the argv cold-start path in index.ts cannot recover it.
 * Clicking an emailed invite or a meeting-join link while the app was closed
 * therefore opened a blank app.
 *
 * So until the app is ready the link is HELD, and `bootstrap()` collects it with
 * `takeHeld()` and forwards it the same way it does an argv link. Once ready,
 * links are delivered straight away, as before.
 *
 * Electron-free (the caller supplies `isReady`/`deliver`) so the ordering can be
 * unit-tested without booting the app.
 */
export function createOpenUrlHandler(deps: { isReady: () => boolean; deliver: (url: string) => void }) {
  let held: string | undefined;
  return {
    handle(url: string): void {
      if (deps.isReady()) {
        deps.deliver(url);
        return;
      }
      // Only a link this app understands is worth holding; the latest one wins,
      // as it is the one the user just clicked.
      if (parseDeepLink(url)) held = url;
    },
    /** The link that arrived before the app was ready, if any; clears it. */
    takeHeld(): string | undefined {
      const url = held;
      held = undefined;
      return url;
    },
  };
}
