import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { StickyTaskDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";

/** After a deadline, how long to give task-svc's sweeper (it polls every couple of
 *  seconds) to record the miss before asking for it. */
const SWEEP_GRACE_MS = 4_000;
/** setTimeout stores its delay in a signed 32-bit int; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Re-read the task lists when the soonest upcoming deadline among the caller's
 * ACTIVE tasks passes.
 *
 * The server owns the transition and pushes `task.missed`, which is what normally
 * moves a card to Missed. This is the net under it for the case where that push
 * never arrives (the socket dropped, the laptop slept through the deadline): the
 * cards would otherwise sit in Allocated to me, offering actions the server now
 * refuses, until something else caused a refetch. A single timer for the soonest
 * deadline — not one per task — and it re-arms itself because the refetch changes
 * `tasks`.
 */
export function useDeadlineRefetch(tasks: readonly StickyTaskDTO[]): void {
  const qc = useQueryClient();
  useEffect(() => {
    const now = Date.now();
    let soonest = Infinity;
    for (const t of tasks) {
      if (t.myStatus !== "SENT" && t.myStatus !== "ACKNOWLEDGED") continue;
      const at = t.deadlineAt ? Date.parse(t.deadlineAt) : NaN;
      if (Number.isFinite(at) && at > now && at < soonest) soonest = at;
    }
    if (!Number.isFinite(soonest)) return;
    const timer = setTimeout(
      () => {
        for (const key of [qk.assigned, qk.sticky, qk.inbox, qk.sent, qk.availability]) {
          void qc.invalidateQueries({ queryKey: key });
        }
      },
      Math.min(soonest - now + SWEEP_GRACE_MS, MAX_TIMEOUT_MS),
    );
    return () => clearTimeout(timer);
  }, [tasks, qc]);
}
