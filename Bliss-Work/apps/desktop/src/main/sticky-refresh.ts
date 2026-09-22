/**
 * Which realtime events mean "re-read the desktop notes".
 *
 * Extracted from ws-process.ts so it can be tested without a utilityProcess, a
 * websocket or a broker — and because the thing it replaces was a landmine:
 *
 *     if (e.type.startsWith("task.")) void refreshSticky();
 *
 * That silently ignores any event whose name does not begin "task.", which is
 * exactly what `sticky.refresh` — the delivery watchdog's whole reason to exist
 * — does not. A prefix match reads like a rule but is really an accident of
 * naming, and the next event type added outside that prefix would have been
 * dropped just as quietly.
 */

/**
 * Task lifecycle events. Every one of these can change which notes belong on
 * screen: an assignment adds one, an acknowledgement changes its buttons, and
 * a terminal status takes it away.
 */
const TASK_LIFECYCLE = [
  "task.assigned",
  "task.acknowledged",
  "task.completed",
  "task.ignored",
  "task.left",
] as const;

/**
 * The repair signal from services/sticky-relay: "you have notes you may never
 * have received". Named outside the `task.` prefix on purpose — it is emitted
 * by a different service about delivery, not by task-svc about a task.
 */
const STICKY_REFRESH = "sticky.refresh";

const REFRESH_ON: ReadonlySet<string> = new Set<string>([...TASK_LIFECYCLE, STICKY_REFRESH]);

/**
 * Should this event trigger a re-fetch of /tasks/sticky?
 *
 * An explicit set rather than a prefix test. Adding an event type here is a
 * deliberate act; forgetting to is a visible omission rather than a silent one.
 */
export function shouldRefreshSticky(eventType: string): boolean {
  return REFRESH_ON.has(eventType);
}

/**
 * Ordering guard for overlapping /tasks/sticky re-reads.
 *
 * Every lifecycle event starts its own fetch, so two can be in flight at once,
 * and responses do not return in the order they were asked for. A slow older
 * one landing AFTER a newer one would be applied on top of it — auto-pinning a
 * task the newer list had just dropped (completed, ignored) and leaving its note
 * on screen with nothing to take it down until the next event. `begin()` hands
 * out a ticket; only the holder of the newest one may publish its result.
 *
 * "Only the newest" would throw away good data if the newest then never
 * succeeds: an older refresh that DID succeed would be discarded for nothing,
 * leaving the notes stale until the next event. So one that finishes after being
 * superseded is kept as a spare, and published only if the newest gives up. It
 * is never used once something newer has gone out — that would put back what the
 * newer publication took down.
 */
export function createRefreshGate<T>() {
  let latest = 0;
  /** The newest ticket whose result went out. */
  let published = 0;
  let spare: { ticket: number; result: T } | undefined;
  return {
    begin: (): number => ++latest,
    isCurrent: (ticket: number): boolean => ticket === latest,

    /** A refresh succeeded. True: it is the newest — publish it. False: it was
     *  superseded; it is kept as a spare unless something newer is already out. */
    succeeded(ticket: number, result: T): boolean {
      if (ticket === latest) {
        published = ticket;
        spare = undefined;
        return true;
      }
      if (ticket > published && (!spare || ticket > spare.ticket)) spare = { ticket, result };
      return false;
    },

    /** The newest refresh exhausted its retries. The spare to publish in its
     *  place, if there is one. (A spare is always newer than `published`: every
     *  publication and cancel() clears it.) */
    gaveUp(ticket: number): T | undefined {
      if (ticket !== latest || !spare) return undefined;
      published = spare.ticket;
      const { result } = spare;
      spare = undefined;
      return result;
    },

    /** Sign-out: nothing in flight for the user who left may be published or kept. */
    cancel(): void {
      published = ++latest;
      spare = undefined;
    },
  };
}
