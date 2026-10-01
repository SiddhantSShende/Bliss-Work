import type { AssigneeStatus, StickyTaskDTO } from "../types/domain";

/**
 * Pure decision logic for the desktop "pin a task as a sticky note" feature.
 *
 * Kept free of Electron/React/IO so it is trivially unit-testable and shared by
 * both the Electron main process (which floats the windows) and the renderer
 * (which offers the "Pin to desktop" button). "pinned" is the caller's set —
 * on the desktop a local mirror of the durable per-user pin state in sticky-svc,
 * which is the authority; these functions never read or write it.
 */

/** Result of a pin request, returned from the Electron main process to the
 *  renderer so the UI reflects the AUTHORITATIVE pinned set (not an optimistic
 *  guess) and can surface why a pin was refused. */
export interface PinResult {
  ok: boolean;
  /** Why the pin was refused (only set when ok === false). "unpinned" means the
   *  user's shared pin state for this task (sticky-svc) is UNPINNED, so an
   *  AUTOMATIC pin request — acknowledging a task is not a request to re-pin —
   *  must not float it. It is not permanent: the user's own explicit Pin
   *  (ApiClient.stickyPin) clears it, on any device, and the note comes back. */
  reason?: "limit" | "invalid" | "unpinned";
  /** The pinned set after the request (the renderer seeds its cache from this). */
  pinned: string[];
}

/**
 * A task may be MANUALLY pinned (the in-app "Pin to desktop" button) for as long
 * as it is actionable. Terminal tasks (completed/left/ignored) are not.
 *
 * This deliberately matches `canFloatTask` rather than requiring ACKNOWLEDGED.
 * The manual button is the recovery path for a note the user took off screen
 * with its X, and that hide is available on a SENT note too — gating the button
 * on ACKNOWLEDGED meant a freshly-assigned note, once hidden, could not be
 * brought back at all until the user acknowledged a task they could no longer
 * see. The two predicates are kept as separate names because they answer
 * different questions (may I offer the button, vs should this be on screen),
 * and only one of them is expected to stay in step with the other.
 */
export function canPinTask(status: AssigneeStatus): boolean {
  return canFloatTask(status);
}

/**
 * Whether a task should float as a desktop note at all. Unlike `canPinTask`,
 * this includes SENT: a newly assigned task auto-pops on the desktop showing
 * Acknowledge / Ignore, then stays floating once acknowledged (→ Complete / Leave).
 * Terminal statuses never float — the server drops them from /tasks/sticky.
 */
export function canFloatTask(status: AssigneeStatus): boolean {
  return status === "SENT" || status === "ACKNOWLEDGED";
}

/**
 * Whether one more task can be pinned without exceeding the on-screen cap.
 * `currentFloatingCount` is how many pinned tasks already float; `max` is the
 * hard cap. Guards against advertising a "Pinned" note that would never render.
 */
export function canAcceptNewPin(currentFloatingCount: number, max: number): boolean {
  return currentFloatingCount < max;
}

/**
 * The subset of tasks that should float as desktop notes right now: the ones
 * the user has pinned that are still actionable (SENT or ACKNOWLEDGED), capped
 * at `max` (the rest stay in the in-app list). Input order is preserved so the
 * on-screen cascade is stable. A negative `max` means "no cap".
 */
export function selectFloatingTasks(
  tasks: readonly StickyTaskDTO[],
  pinned: Iterable<string>,
  max: number,
): StickyTaskDTO[] {
  const pinnedSet = new Set(pinned);
  const floating = tasks.filter((t) => pinnedSet.has(t.taskId) && canFloatTask(t.myStatus));
  return max >= 0 ? floating.slice(0, max) : floating;
}

/**
 * Pinned ids that are no longer present in the latest LIVE actionable list —
 * i.e. the task was completed/left/ignored, so the server's sticky endpoint
 * (which returns only SENT/ACKNOWLEDGED tasks) dropped it. These should be
 * unpinned and have their window/geometry cleaned up.
 *
 * The caller MUST pass ids from a SUCCESSFUL live fetch only — never a possibly
 * stale/empty cache — or this would wrongly unpin still-live commitments.
 */
export function idsToPrune(pinned: Iterable<string>, liveIds: Iterable<string>): string[] {
  const live = new Set(liveIds);
  const out: string[] = [];
  for (const id of pinned) if (!live.has(id)) out.push(id);
  return out;
}
