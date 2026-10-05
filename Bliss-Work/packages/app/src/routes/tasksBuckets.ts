import type { StickyTaskDTO } from "@taskboard/shared";

/**
 * How the Tasks screen bounds its terminal buckets.
 *
 * A separate module so the rules are testable without rendering the whole
 * screen — the same reason mentionPatch and inboxPatch were extracted (see the
 * note in packages/app/vitest.config.ts).
 */

/**
 * How many tasks a terminal bucket shows.
 *
 * Completed, Left, Ignored and Missed are archives: they accumulate for as long as
 * someone uses the product and nothing is ever removed from them, so an
 * uncapped list is a screen that gets slower and less useful every month.
 *
 * The active buckets are deliberately NOT capped. Those are work outstanding,
 * and hiding the eleventh item would hide something that still needs doing.
 */
export const TERMINAL_VIEW_LIMIT = 10;

/** Whether `view` is an archive (capped) rather than outstanding work. */
export function isTerminalView(view: string): boolean {
  return view === "completed" || view === "left" || view === "ignored" || view === "missed";
}

/**
 * When a task reached its terminal state, for ordering the archives.
 *
 * Exactly one of the four timestamps is set for a given bucket, so reading all
 * four and taking the first present one is not ambiguity — it is one helper
 * instead of three.
 *
 * `assignedAt` is the fallback because the three are optional on the DTO, and a
 * row from a server that predates them must still sort by something real:
 * sorting as the empty string would pin it to the bottom regardless of age.
 *
 * Ordering by this rather than by `assignedAt` is the whole point. A task handed
 * over in January and finished this morning is the newest thing in Completed,
 * and sorting by when it was assigned buries it under nine older ones nobody
 * has touched since.
 */
export function terminalAt(t: StickyTaskDTO): string {
  return t.completedAt ?? t.leftAt ?? t.ignoredAt ?? t.missedAt ?? t.assignedAt;
}
