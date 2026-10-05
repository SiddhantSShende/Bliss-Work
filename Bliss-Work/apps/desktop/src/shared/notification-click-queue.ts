/**
 * Holds an OS-notification click until the signed-in app can act on it.
 *
 * Main sends the click as soon as the page finishes loading (or at once, to a
 * window that is already up) — but marking a notification read and navigating
 * need the authenticated shell, which mounts later (after the session refresh) and
 * only when someone is signed in. So the preload listener is registered at module
 * load and parks the click here; the shell subscribes when it mounts and receives
 * whatever is waiting.
 *
 * Only the latest unhandled click is kept: if the user clicked two popups before
 * the app was ready, they want the second one, and replaying both would flash
 * through the first for nothing.
 */
export function createClickQueue<T>() {
  let listener: ((click: T) => void) | null = null;
  let pending: T | null = null;
  return {
    push(click: T): void {
      if (listener) listener(click);
      else pending = click;
    },
    subscribe(cb: (click: T) => void): () => void {
      listener = cb;
      if (pending !== null) {
        const waiting = pending;
        pending = null;
        cb(waiting);
      }
      return () => {
        if (listener === cb) listener = null;
      };
    },
  };
}
