/** How far from the bottom still counts as "at the bottom" — a little slack so
 *  a bubble's own margin, or a half-loaded image, does not detach the reader. */
export const NEAR_BOTTOM_PX = 120;

/** Is the reader looking at the end of the thread (so a new message should
 *  carry them along), rather than scrolled up reading history? */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

interface Edge {
  firstId?: string;
  lastId?: string;
  count: number;
}

/**
 * True when the only change since `prev` is the last row's `temp:` id becoming
 * its real server id (an optimistic send being confirmed): same first row, same
 * number of rows. That is not a new message, so it must not scroll anything.
 */
export function isIdSwapOnly(prev: Edge, next: Edge): boolean {
  return (
    !!prev.lastId?.startsWith("temp:") &&
    next.lastId !== prev.lastId &&
    next.count === prev.count &&
    next.firstId === prev.firstId
  );
}
