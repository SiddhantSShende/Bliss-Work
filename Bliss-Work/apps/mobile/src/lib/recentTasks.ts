import type { StickyTaskDTO } from '@taskboard/shared';

/** How many tasks Home's "Recent Tasks" shows. */
export const RECENT_TASKS_LIMIT = 5;

const stamp = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/**
 * Home's "Recent Tasks": the tasks assigned to the signed-in user, newest first,
 * at most `limit`. These are the SAME rows the Tasks screen's "Assigned to Me"
 * tab shows (the `taskAssigned` query), so nothing extra is fetched and the
 * websocket task events that refresh that query refresh Home too.
 *
 * "Newest" is `assignedAt` — when the task reached this user. It is the only
 * creation-style timestamp a `StickyTaskDTO` has (there is no createdAt or
 * updatedAt on it); acknowledging or completing a task does not make it "recent"
 * again. A task with an unreadable timestamp sorts last rather than first, and a
 * task id is never listed twice. Tasks the user SENT are deliberately not
 * included: there is no detail screen to open for them (see TasksListScreen).
 */
export function recentTasks(assigned: readonly StickyTaskDTO[] | undefined, limit: number = RECENT_TASKS_LIMIT): StickyTaskDTO[] {
  if (!assigned || limit <= 0) return [];
  const seen = new Set<string>();
  const unique = assigned.filter((t) => (seen.has(t.taskId) ? false : (seen.add(t.taskId), true)));
  return unique
    .map((t, i) => ({ t, i, at: stamp(t.assignedAt) }))
    .sort((a, b) => {
      const an = Number.isNaN(a.at);
      const bn = Number.isNaN(b.at);
      if (an !== bn) return an ? 1 : -1;
      return an ? a.i - b.i : b.at - a.at || a.i - b.i;
    })
    .slice(0, limit)
    .map((x) => x.t);
}
