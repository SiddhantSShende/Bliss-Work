import { useEffect } from "react";
import type { CallDTO } from "@taskboard/shared";
import { isCallOver } from "./meetingView";

/** How often to look again for a call this device's clock says has run out but
 *  the server still reports as open. The server's own sweeper runs on this
 *  cadence, so asking more often than this would only be asking the same
 *  question twice. */
const OVERDUE_RECHECK_MS = 30_000;
/** Beyond the end time, so the answer we ask for has been decided by then. */
const AFTER_END_SLACK_MS = 1_000;
/** setTimeout cannot take more than ~24.8 days; nothing is scheduled that far
 *  ahead anyway, because a list re-arms on every refetch. */
const MAX_DELAY_MS = 60 * 60_000;

/**
 * How long until it is worth asking the server again whether an open call is
 * still open, or null if none of them has a scheduled end.
 *
 * A TRIGGER, never a verdict: this only decides WHEN to revalidate. Whether a
 * call is over is the server's answer (isCallOver). That is what stops a wrong
 * local clock from hiding a live meeting, or from turning into a request loop —
 * a call that is overdue by this clock but still open at the server is simply
 * re-asked every OVERDUE_RECHECK_MS.
 */
export function nextLapseCheckMs(calls: readonly CallDTO[], now: number): number | null {
  let next: number | null = null;
  for (const c of calls) {
    if (isCallOver(c) || !c.endsAt) continue;
    const end = Date.parse(c.endsAt);
    if (Number.isNaN(end)) continue;
    const wait = end > now ? end - now + AFTER_END_SLACK_MS : OVERDUE_RECHECK_MS;
    next = next === null ? wait : Math.min(next, wait);
  }
  return next === null ? null : Math.min(next, MAX_DELAY_MS);
}

/**
 * Revalidate a list of calls when one of them is due to have ended, so a
 * meeting that runs out while the page is open leaves "Live" on its own rather
 * than waiting for the user to reload. Re-arms every time `calls` changes,
 * which a refetch does.
 */
export function useLapseRevalidation(calls: readonly CallDTO[] | undefined, revalidate: () => void) {
  useEffect(() => {
    if (!calls) return;
    const wait = nextLapseCheckMs(calls, Date.now());
    if (wait === null) return;
    const timer = setTimeout(revalidate, wait);
    return () => clearTimeout(timer);
  }, [calls, revalidate]);
}
