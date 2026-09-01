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
